package main

import (
	"bufio"
	"bytes"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestDockerStats(t *testing.T) {
	s, e := parseStats(`{"CPUPerc":"83.40%","MemUsage":"400MiB / 512MiB"}`)
	if e != nil || s.CPUPercent != 83.4 || s.MemoryBytes != 419430400 || s.MemoryLimitBytes != 536870912 {
		t.Fatalf("parsed %#v: %v", s, e)
	}
	for _, bad := range []string{`{"CPUPerc":"-1%","MemUsage":"1MiB / 2MiB"}`, `{"CPUPerc":"10%","MemUsage":"n/a"}`, `{"CPUPerc":"NaN%","MemUsage":"1MiB / 2MiB"}`} {
		if _, e := parseStats(bad); e == nil {
			t.Fatalf("accepted %s", bad)
		}
	}
}
func TestOutboundStreamHandshake(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/agent/stream" || r.Header.Get("Authorization") != "Bearer test-secret" || r.Header.Get("X-Node-ID") != "node-test" {
			t.Errorf("wrong outbound headers: %s %#v", r.URL, r.Header)
		}
		conn, _, e := w.(http.Hijacker).Hijack()
		if e != nil {
			t.Error(e)
			return
		}
		defer conn.Close()
		digest := sha1.Sum([]byte(r.Header.Get("Sec-WebSocket-Key") + wsGUID))
		fmt.Fprintf(conn, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: %s\r\n\r\n", base64.StdEncoding.EncodeToString(digest[:]))
		frame := []byte(`{"type":"subscribe","serverId":"12345678-1234-1234-1234-123456789012"}`)
		conn.Write(append([]byte{0x81, byte(len(frame))}, frame...))
	}))
	defer server.Close()
	prevAPI, prevNode, prevCredential := api, nodeID, credential
	api, nodeID, credential = server.URL, "node-test", "test-secret"
	defer func() { api, nodeID, credential = prevAPI, prevNode, prevCredential }()
	stream, e := dialStream()
	if e != nil {
		t.Fatal(e)
	}
	defer stream.conn.Close()
	frame, e := stream.read()
	if e != nil || !bytes.Contains(frame, []byte("subscribe")) {
		t.Fatalf("handshake frame %q: %v", frame, e)
	}
}
func TestBatchStatsOnlyKnownContainers(t *testing.T) {
	names := []string{"nvr-a", "nvr-b"}
	out := []byte("{\"Name\":\"nvr-a\",\"CPUPerc\":\"25.5%\",\"MemUsage\":\"128MiB / 512MiB\"}\n{\"Name\":\"foreign\",\"CPUPerc\":\"50%\",\"MemUsage\":\"1MiB / 2MiB\"}\n{\"Name\":\"nvr-b\",\"CPUPerc\":\"N/A\",\"MemUsage\":\"0B / 512MiB\"}")
	samples := parseStatsBatch(out, names)
	if len(samples) != 1 || samples["nvr-a"].CPUPercent != 25.5 {
		t.Fatalf("unexpected batch: %#v", samples)
	}
}
func TestMaskedClientFrameAndLogBytes(t *testing.T) {
	a, b := net.Pipe()
	defer a.Close()
	defer b.Close()
	w := &streamWire{conn: a}
	text := []byte("first line\nsecond line\n")
	errCh := make(chan error, 1)
	go func() { errCh <- w.send(map[string]string{"type": "log", "data": "Zmlyc3Q="}) }()
	header := make([]byte, 2)
	if _, e := io.ReadFull(b, header); e != nil {
		t.Fatal(e)
	}
	if header[0] != 0x81 || header[1]&0x80 == 0 {
		t.Fatalf("not a masked text frame: %v", header)
	}
	var n int
	if header[1]&127 == 126 {
		ext := make([]byte, 2)
		if _, e := io.ReadFull(b, ext); e != nil {
			t.Fatal(e)
		}
		n = int(binary.BigEndian.Uint16(ext))
	} else {
		n = int(header[1] & 127)
	}
	mask := make([]byte, 4)
	if _, e := io.ReadFull(b, mask); e != nil {
		t.Fatal(e)
	}
	payload := make([]byte, n)
	if _, e := io.ReadFull(b, payload); e != nil {
		t.Fatal(e)
	}
	for i := range payload {
		payload[i] ^= mask[i%4]
	}
	if !bytes.Contains(payload, []byte("Zmlyc3Q=")) {
		t.Fatalf("log frame lost bytes: %q", payload)
	}
	if e := <-errCh; e != nil {
		t.Fatal(e)
	}
	// The receiver must handle a control ping before the next text message.
	pong := make(chan []byte, 1)
	go func() { head := make([]byte, 6); io.ReadFull(b, head); pong <- head }()
	go func() { b.Write([]byte{0x89, 0x00, 0x81, 0x02, 'o', 'k'}) }()
	w.reader = bufio.NewReader(a)
	got, e := w.read()
	if e != nil || string(got) != "ok" {
		t.Fatalf("read %q: %v", got, e)
	}
	if p := <-pong; p[0] != 0x8a {
		t.Fatalf("missing pong: %v", p)
	}
	if len(text) != 23 {
		t.Fatal("fixture changed")
	}
}
