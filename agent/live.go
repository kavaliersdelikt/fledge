package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/sha1"
	"crypto/tls"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"
)

const wsGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

type streamWire struct {
	conn    net.Conn
	reader  *bufio.Reader
	writeMu sync.Mutex
}

func dialStream() (*streamWire, error) {
	u, e := url.Parse(api)
	if e != nil {
		return nil, e
	}
	port := u.Port()
	if port == "" {
		if u.Scheme == "https" {
			port = "443"
		} else {
			port = "80"
		}
	}
	host := u.Hostname()
	addr := net.JoinHostPort(host, port)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	conn, e := (&net.Dialer{}).DialContext(ctx, "tcp", addr)
	if e != nil {
		return nil, e
	}
	if u.Scheme == "https" {
		tlsConn := tls.Client(conn, &tls.Config{ServerName: host, MinVersion: tls.VersionTLS12})
		if e = tlsConn.HandshakeContext(ctx); e != nil {
			conn.Close()
			return nil, e
		}
		conn = tlsConn
	}
	conn.SetDeadline(time.Now().Add(10 * time.Second))
	nonce := make([]byte, 16)
	if _, e = rand.Read(nonce); e != nil {
		conn.Close()
		return nil, e
	}
	key := base64.StdEncoding.EncodeToString(nonce)
	route := strings.TrimRight(u.EscapedPath(), "/") + "/api/agent/stream"
	hostHeader := u.Host
	request := fmt.Sprintf("GET %s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: %s\r\nAuthorization: Bearer %s\r\nX-Node-ID: %s\r\n\r\n", route, hostHeader, key, credential, nodeID)
	if _, e = io.WriteString(conn, request); e != nil {
		conn.Close()
		return nil, e
	}
	reader := bufio.NewReader(conn)
	res, e := http.ReadResponse(reader, &http.Request{Method: "GET"})
	if e != nil {
		conn.Close()
		return nil, e
	}
	expected := sha1.Sum([]byte(key + wsGUID))
	if res.StatusCode != 101 || res.Header.Get("Sec-WebSocket-Accept") != base64.StdEncoding.EncodeToString(expected[:]) {
		conn.Close()
		return nil, fmt.Errorf("stream upgrade rejected: %s", res.Status)
	}
	conn.SetDeadline(time.Time{})
	return &streamWire{conn: conn, reader: reader}, nil
}
func (w *streamWire) sendFrame(op byte, payload []byte) error {
	w.writeMu.Lock()
	defer w.writeMu.Unlock()
	if len(payload) > 65535 {
		return errors.New("stream frame too large")
	}
	h := []byte{0x80 | op, 0x80}
	if len(payload) < 126 {
		h[1] |= byte(len(payload))
	} else {
		h[1] |= 126
		h = append(h, byte(len(payload)>>8), byte(len(payload)))
	}
	key := make([]byte, 4)
	if _, e := rand.Read(key); e != nil {
		return e
	}
	h = append(h, key...)
	data := append([]byte(nil), payload...)
	for i := range data {
		data[i] ^= key[i%4]
	}
	w.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	_, e := w.conn.Write(append(h, data...))
	return e
}
func (w *streamWire) send(v interface{}) error {
	data, e := json.Marshal(v)
	if e != nil {
		return e
	}
	return w.sendFrame(1, data)
}
func (w *streamWire) read() ([]byte, error) {
	for {
		w.conn.SetReadDeadline(time.Now().Add(60 * time.Second))
		h := make([]byte, 2)
		if _, e := io.ReadFull(w.reader, h); e != nil {
			return nil, e
		}
		if h[0]&0x80 == 0 || h[1]&0x80 != 0 {
			return nil, errors.New("invalid server websocket frame")
		}
		n := int(h[1] & 127)
		if n == 126 {
			b := make([]byte, 2)
			if _, e := io.ReadFull(w.reader, b); e != nil {
				return nil, e
			}
			n = int(binary.BigEndian.Uint16(b))
		} else if n == 127 {
			return nil, errors.New("oversized websocket frame")
		}
		if n > 65536 {
			return nil, errors.New("oversized websocket frame")
		}
		data := make([]byte, n)
		if _, e := io.ReadFull(w.reader, data); e != nil {
			return nil, e
		}
		switch h[0] & 15 {
		case 1:
			return data, nil
		case 9:
			if e := w.sendFrame(10, data); e != nil {
				return nil, e
			}
		case 8:
			return nil, io.EOF
		case 10:
		default:
			return nil, errors.New("unexpected websocket opcode")
		}
	}
}
func streamServer(ctx context.Context, w *streamWire, id string) {
	name := container(id)
	go func() {
		cmd := exec.CommandContext(ctx, "docker", "logs", "--follow", "--tail", "100", name)
		read, write, e := os.Pipe()
		if e != nil {
			log.Printf("live logs %s: %v", id, e)
			return
		}
		defer read.Close()
		cmd.Stdout = write
		cmd.Stderr = write
		if e = cmd.Start(); e != nil {
			write.Close()
			log.Printf("live logs %s: %v", id, e)
			return
		}
		write.Close()
		go func() {
			if e := cmd.Wait(); e != nil && ctx.Err() == nil {
				log.Printf("live logs %s: %v", id, e)
			}
		}()
		buf := make([]byte, 4096)
		for {
			n, e := read.Read(buf)
			if n > 0 {
				if err := w.send(map[string]interface{}{"type": "log", "serverId": id, "data": base64.StdEncoding.EncodeToString(buf[:n])}); err != nil {
					return
				}
			}
			if e != nil {
				return
			}
		}
	}()
	sample := func() {
		s, e := containerStats(ctx, name)
		if e == nil {
			if e = w.send(map[string]interface{}{"type": "sample", "serverId": id, "cpuPercent": s.CPUPercent, "memoryBytes": s.MemoryBytes, "memoryLimitBytes": s.MemoryLimitBytes}); e != nil {
				log.Printf("live sample %s: %v", id, e)
			}
		}
	}
	sample()
	ticker := time.NewTicker(3 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			sample()
		}
	}
}
func streamSession(w *streamWire) error {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	defer w.conn.Close()
	active := map[string]context.CancelFunc{}
	defer func() {
		for _, stop := range active {
			stop()
		}
	}()
	for {
		data, e := w.read()
		if e != nil {
			return e
		}
		var m struct {
			Type     string `json:"type"`
			ServerID string `json:"serverId"`
		}
		if e = json.Unmarshal(data, &m); e != nil {
			return e
		}
		if len(m.ServerID) != 36 || strings.ContainsAny(m.ServerID, "/\\\x00\r\n") {
			return errors.New("invalid stream server id")
		}
		switch m.Type {
		case "subscribe":
			if active[m.ServerID] == nil {
				child, stop := context.WithCancel(ctx)
				active[m.ServerID] = stop
				go streamServer(child, w, m.ServerID)
			}
		case "unsubscribe":
			if stop := active[m.ServerID]; stop != nil {
				stop()
				delete(active, m.ServerID)
			}
		default:
			return errors.New("unexpected stream command")
		}
	}
}
func liveLoop() {
	for {
		w, e := dialStream()
		if e == nil {
			e = streamSession(w)
		}
		if e != nil {
			log.Printf("live stream: %v", e)
		}
		time.Sleep(3 * time.Second)
	}
}
