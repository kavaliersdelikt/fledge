package main

// Agent self-update.
//
// The panel queues an `agent.update` job with a download URL and SHA-256. The agent
// downloads the binary next to itself, verifies the checksum, runs `<new> --version`,
// keeps the current binary as `<exe>.prev`, swaps the new one in atomically and
// re-executes itself (same PID, so systemd or a foreground shell keep supervising it).
//
// The new process confirms the update to the panel after its first successful
// heartbeat. If it fails to start three times in a row it restores `.prev`, remembers
// the version as bad and reports the failure.

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"
)

const maxAgentBinary = 128 << 20

type updateMarker struct {
	JobID   string `json:"jobId"`
	Attempt int    `json:"attempt"`
	From    string `json:"from"`
	To      string `json:"to"`
	Boots   int    `json:"boots"`
}

func stateDir() string   { return filepath.Dir(credentialFile) }
func markerPath() string { return filepath.Join(stateDir(), "agent-update.json") }
func failedPath(v string) string {
	return filepath.Join(stateDir(), "agent-update-failed-"+sanitize(v))
}
func rollbackPath() string { return filepath.Join(stateDir(), "agent-update-rolledback.json") }
func sanitize(v string) string {
	return strings.Map(func(r rune) rune {
		if r >= '0' && r <= '9' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r == '.' || r == '-' {
			return r
		}
		return '_'
	}, v)
}

func exePath() (string, error) {
	p, e := os.Executable()
	if e != nil {
		return "", e
	}
	return filepath.EvalSymlinks(p)
}

// updateBlocker explains why this agent cannot update itself, or "" if it can.
func updateBlocker() string {
	p, e := exePath()
	if e != nil {
		return "cannot locate the agent binary"
	}
	if runtime.GOOS != "linux" || (runtime.GOARCH != "amd64" && runtime.GOARCH != "arm64") {
		return "unsupported platform " + runtime.GOOS + "/" + runtime.GOARCH
	}
	probe, e := os.CreateTemp(filepath.Dir(p), ".fledge-write-test-")
	if e != nil {
		return "the agent binary directory is not writable"
	}
	probe.Close()
	os.Remove(probe.Name())
	return ""
}

// updateBoot runs first thing at startup: count boots of a freshly installed
// binary and roll back if it keeps failing before confirming itself.
func updateBoot() {
	exe, e := exePath()
	if e != nil {
		return
	}
	if rolledBack, _ := checkBoot(exe); rolledBack {
		reexec(exe)
	}
}

// checkBoot returns true when it restored the previous binary and the caller must re-exec.
func checkBoot(exe string) (bool, error) {
	b, e := os.ReadFile(markerPath())
	if e != nil {
		return false, nil
	}
	var m updateMarker
	if json.Unmarshal(b, &m) != nil || m.To != version {
		// A marker for a different version: the update was superseded or rolled back.
		os.Remove(markerPath())
		return false, nil
	}
	m.Boots++
	if m.Boots > 3 {
		if err := os.Rename(exe+".prev", exe); err != nil {
			log.Printf("rollback failed: %v", err)
			return false, err
		}
		os.WriteFile(failedPath(m.To), []byte(time.Now().UTC().Format(time.RFC3339)), 0600)
		rb, _ := json.Marshal(m)
		os.WriteFile(rollbackPath(), rb, 0600)
		os.Remove(markerPath())
		log.Printf("agent %s failed to start; rolled back to %s", m.To, m.From)
		return true, nil
	}
	nb, _ := json.Marshal(m)
	os.WriteFile(markerPath(), nb, 0600)
	return false, nil
}

func reexec(exe string) {
	if e := syscall.Exec(exe, os.Args, os.Environ()); e != nil {
		log.Fatalf("restart into new agent failed: %v", e)
	}
}

// updateConfirm is called after the first successful heartbeat.
func updateConfirm() {
	if b, e := os.ReadFile(markerPath()); e == nil {
		var m updateMarker
		if json.Unmarshal(b, &m) == nil && m.To == version {
			body := map[string]interface{}{"attempt": m.Attempt, "success": true, "result": map[string]string{"from": m.From, "to": m.To}}
			if e := request("POST", "/api/agent/jobs/"+m.JobID+"/result", body, nil, true); e != nil {
				log.Printf("update confirmation: %v (the panel will see the new version in the next heartbeat)", e)
			}
			os.Remove(markerPath())
			log.Printf("agent updated %s -> %s", m.From, m.To)
		}
	}
	if b, e := os.ReadFile(rollbackPath()); e == nil {
		var m updateMarker
		if json.Unmarshal(b, &m) == nil {
			body := map[string]interface{}{"attempt": m.Attempt, "success": false, "error": fmt.Sprintf("Version %s failed to start; rolled back to %s", m.To, m.From)}
			request("POST", "/api/agent/jobs/"+m.JobID+"/result", body, nil, true)
		}
		os.Remove(rollbackPath())
	}
}

func updateAgent(j *job) (interface{}, error) {
	target, _ := j.Payload["version"].(string)
	link, _ := j.Payload["url"].(string)
	want, _ := j.Payload["sha256"].(string)
	if target == "" || link == "" || len(want) != 64 {
		return nil, errors.New("invalid update request")
	}
	if target == version {
		return map[string]string{"from": version, "to": version}, nil
	}
	if _, e := os.Stat(failedPath(target)); e == nil {
		return nil, fmt.Errorf("version %s already failed on this node and was rolled back", target)
	}
	if reason := updateBlocker(); reason != "" {
		return nil, errors.New("cannot update: " + reason)
	}
	u, e := url.Parse(link)
	if e != nil || (u.Scheme != "https" && !(u.Scheme == "http" && os.Getenv("ALLOW_INSECURE_HTTP") == "true")) {
		return nil, errors.New("update URL must be HTTPS")
	}
	exe, e := exePath()
	if e != nil {
		return nil, e
	}
	tmp, e := os.CreateTemp(filepath.Dir(exe), ".fledge-agent-new-")
	if e != nil {
		return nil, e
	}
	defer os.Remove(tmp.Name())
	res, e := (&http.Client{Timeout: 10 * time.Minute}).Get(link)
	if e != nil {
		tmp.Close()
		return nil, fmt.Errorf("download failed: %w", e)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		tmp.Close()
		return nil, fmt.Errorf("download failed: %s", res.Status)
	}
	h := sha256.New()
	n, e := io.Copy(io.MultiWriter(tmp, h), io.LimitReader(res.Body, maxAgentBinary+1))
	if ce := tmp.Close(); e == nil {
		e = ce
	}
	if e != nil {
		return nil, e
	}
	if n > maxAgentBinary {
		return nil, errors.New("downloaded file is too large")
	}
	if got := hex.EncodeToString(h.Sum(nil)); !strings.EqualFold(got, want) {
		return nil, errors.New("checksum mismatch: the download does not match the published SHA-256; nothing was installed")
	}
	if e = os.Chmod(tmp.Name(), 0755); e != nil {
		return nil, e
	}
	out, e := exec.Command(tmp.Name(), "--version").Output()
	if got := strings.TrimSpace(string(out)); e != nil || got != target {
		return nil, fmt.Errorf("the downloaded binary reports version %q, expected %q", got, target)
	}
	// Keep the running binary as the rollback target.
	if e = copyFile(exe, exe+".prev", 0755); e != nil {
		return nil, fmt.Errorf("could not keep a rollback copy: %w", e)
	}
	m, _ := json.Marshal(updateMarker{JobID: j.ID, Attempt: j.Attempt, From: version, To: target})
	if e = os.WriteFile(markerPath(), m, 0600); e != nil {
		return nil, e
	}
	if e = os.Rename(tmp.Name(), exe); e != nil {
		os.Remove(markerPath())
		return nil, e
	}
	log.Printf("installed agent %s, restarting", target)
	time.Sleep(200 * time.Millisecond)
	reexec(exe)
	return nil, errors.New("unreachable")
}

func copyFile(src, dst string, mode os.FileMode) error {
	in, e := os.Open(src)
	if e != nil {
		return e
	}
	defer in.Close()
	tmp := dst + ".tmp"
	out, e := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, mode)
	if e != nil {
		return e
	}
	if _, e = io.Copy(out, in); e != nil {
		out.Close()
		return e
	}
	if e = out.Close(); e != nil {
		return e
	}
	return os.Rename(tmp, dst)
}
