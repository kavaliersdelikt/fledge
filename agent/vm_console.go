package main

import (
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"time"
)

var vmConsoleDigest = regexp.MustCompile(`^[a-f0-9]{64}$`)

// Polling only carries session metadata. Each console creates an authenticated
// outbound binary connection; VNC and serial remain local Unix sockets.
func vmConsoleLoop() {
	active := map[string]bool{}
	var mu sync.Mutex
	for {
		if env("VM_ENABLED", "false") == "true" {
			var reply struct {
				Consoles []struct {
					ID       string `json:"id"`
					ServerID string `json:"serverId"`
					Mode     string `json:"mode"`
				} `json:"consoles"`
			}
			if request("GET", "/api/agent/vm-consoles", nil, &reply, true) == nil {
				for _, c := range reply.Consoles {
					if !vmConsoleDigest.MatchString(c.ID) || !uuidName.MatchString(c.ServerID) || (c.Mode != "vnc" && c.Mode != "serial") {
						continue
					}
					mu.Lock()
					running := active[c.ID]
					if !running && len(active) < 32 {
						active[c.ID] = true
						mu.Unlock()
						go func(id, serverID, mode string) {
							defer func() { mu.Lock(); delete(active, id); mu.Unlock() }()
							_ = vmConsoleSession(id, serverID, mode)
						}(c.ID, c.ServerID, c.Mode)
					} else {
						mu.Unlock()
					}
				}
			}
		}
		time.Sleep(time.Second)
	}
}
func vmConsoleSession(id, serverID, mode string) error {
	// Require locally persisted VM ownership; a relay request is not an arbitrary
	// local-socket proxy, even if an API or protocol client sends an invalid path.
	root := vmRoot(serverID)
	if _, e := os.Stat(filepath.Join(root, "vm.json")); e != nil {
		return e
	}
	socketPath := filepath.Join(root, mode+".sock")
	fi, e := os.Lstat(socketPath)
	if e != nil {
		return e
	}
	if fi.Mode()&os.ModeSocket == 0 {
		return errors.New("console is not a local socket")
	}
	local, e := net.DialTimeout("unix", socketPath, 5*time.Second)
	if e != nil {
		return e
	}
	defer local.Close()
	wire, e := dialStreamRoute("/api/agent/vm-console/" + id)
	if e != nil {
		return e
	}
	defer wire.conn.Close()
	done := make(chan error, 1)
	go func() {
		buf := make([]byte, 16384)
		for {
			n, e := local.Read(buf)
			if n > 0 {
				if err := wire.sendFrame(2, buf[:n]); err != nil {
					done <- err
					return
				}
			}
			if e != nil {
				done <- e
				return
			}
		}
	}()
	go func() {
		for {
			data, e := wire.read()
			if e != nil {
				done <- e
				return
			}
			if _, e = local.Write(data); e != nil {
				done <- e
				return
			}
		}
	}()
	select {
	case e := <-done:
		if e == io.EOF {
			return nil
		}
		return e
	case <-time.After(time.Hour):
		return errors.New("console expired")
	}
}
