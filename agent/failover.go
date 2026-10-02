package main

// Agent side of failover: report what this node holds, evict copies of servers that now
// live elsewhere, and (optionally) stop failover-protected servers if the panel has been
// unreachable for so long that it may have started them on another node.

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

var uuidName = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

type failoverConfig struct {
	FenceAfterSeconds    int      `json:"fenceAfterSeconds"`
	FenceServers         []string `json:"fenceServers"`
	EvictedRetentionDays int      `json:"evictedRetentionDays"`
}

var (
	foMu        sync.Mutex
	foConfig    failoverConfig
	lastBeatOK  = time.Now()
	fencedNow   = map[string]bool{}
	lastPurge   time.Time
	foStateFile = func() string { return filepath.Join(stateDir(), "failover.json") }
)

func loadFailoverState() {
	b, e := os.ReadFile(foStateFile())
	if e != nil {
		return
	}
	foMu.Lock()
	defer foMu.Unlock()
	_ = json.Unmarshal(b, &foConfig)
}

func applyFailover(c failoverConfig) {
	foMu.Lock()
	foConfig = c
	foMu.Unlock()
	if b, e := json.Marshal(c); e == nil {
		_ = os.WriteFile(foStateFile(), b, 0600)
	}
}

// beatOK is called after every successful heartbeat: restart anything we fenced that the
// panel still says belongs here, and purge old evicted data.
func beatOK() {
	foMu.Lock()
	lastBeatOK = time.Now()
	owned := map[string]bool{}
	for _, id := range foConfig.FenceServers {
		owned[id] = true
	}
	var restart []string
	for id := range fencedNow {
		if owned[id] {
			restart = append(restart, id)
		}
		delete(fencedNow, id)
	}
	days := foConfig.EvictedRetentionDays
	purge := time.Since(lastPurge) > time.Hour
	if purge {
		lastPurge = time.Now()
	}
	foMu.Unlock()
	for _, id := range restart {
		if _, e := docker("start", container(id)); e != nil {
			log.Printf("fence: restarting %s: %v", id, e)
		} else {
			log.Printf("fence: panel reachable again, restarted %s", id)
		}
	}
	if purge {
		purgeEvicted(days)
	}
}

// checkFence runs when a heartbeat fails.
func checkFence() {
	foMu.Lock()
	after := foConfig.FenceAfterSeconds
	ids := append([]string(nil), foConfig.FenceServers...)
	silent := time.Since(lastBeatOK)
	foMu.Unlock()
	if after <= 0 || silent < time.Duration(after)*time.Second {
		return
	}
	for _, id := range ids {
		foMu.Lock()
		done := fencedNow[id]
		foMu.Unlock()
		if done {
			continue
		}
		if state, _ := docker("inspect", "--format", "{{.State.Running}}", container(id)); state != "true" {
			continue
		}
		log.Printf("fence: panel unreachable for %s; stopping %s so it cannot run twice", silent.Round(time.Second), id)
		if _, e := docker("stop", "-t", "10", container(id)); e != nil {
			log.Printf("fence: %v", e)
			continue
		}
		foMu.Lock()
		fencedNow[id] = true
		foMu.Unlock()
	}
}

// heldIDs lists every server this node has a container, volume or directory for.
func heldIDs(containers []string) []string {
	seen := map[string]bool{}
	for _, id := range containers {
		if uuidName.MatchString(id) {
			seen[id] = true
		}
	}
	if entries, e := os.ReadDir(dataRoot); e == nil {
		for _, en := range entries {
			if uuidName.MatchString(en.Name()) {
				seen[en.Name()] = true
			}
		}
	}
	if entries, e := os.ReadDir(volumesDir()); e == nil {
		for _, en := range entries {
			if n := strings.TrimSuffix(en.Name(), ".img"); uuidName.MatchString(n) && strings.HasSuffix(en.Name(), ".img") {
				seen[n] = true
			}
		}
	}
	out := make([]string, 0, len(seen))
	for id := range seen {
		out = append(out, id)
	}
	return out
}

func evictedDir() string { return filepath.Join(dataRoot, ".evicted") }

// evictServer removes a server that now lives on another node: stop and remove the
// container, then move its data aside (or delete it when retention is zero).
func evictServer(id string) (interface{}, error) {
	if !uuidName.MatchString(id) {
		return nil, fmt.Errorf("invalid server id")
	}
	if _, e := docker("rm", "-f", container(id)); e != nil && !strings.Contains(e.Error(), "No such container") {
		return nil, e
	}
	root := filepath.Join(dataRoot, id)
	foMu.Lock()
	days := foConfig.EvictedRetentionDays
	foMu.Unlock()
	stamp := time.Now().UTC().Format("20060102T150405")
	moved := false
	if hasVolume(id) {
		if e := unmountVolume(root); e != nil {
			return nil, e
		}
		if days == 0 {
			os.Remove(imagePath(id))
		} else if e := os.MkdirAll(evictedDir(), 0700); e != nil {
			return nil, e
		} else if e := os.Rename(imagePath(id), filepath.Join(evictedDir(), id+"-"+stamp+".img")); e != nil {
			return nil, e
		}
		moved = true
		os.Remove(root)
	} else if _, e := os.Stat(root); e == nil {
		if days == 0 {
			if e := os.RemoveAll(root); e != nil {
				return nil, e
			}
		} else if e := os.MkdirAll(evictedDir(), 0700); e != nil {
			return nil, e
		} else if e := os.Rename(root, filepath.Join(evictedDir(), id+"-"+stamp)); e != nil {
			return nil, e
		}
		moved = true
	}
	log.Printf("evicted server %s (kept=%v)", id, moved && days > 0)
	return map[string]interface{}{"evicted": moved, "kept": moved && days > 0}, nil
}

func purgeEvicted(days int) {
	if days <= 0 {
		return
	}
	entries, e := os.ReadDir(evictedDir())
	if e != nil {
		return
	}
	cutoff := time.Now().Add(-time.Duration(days) * 24 * time.Hour)
	for _, en := range entries {
		if info, err := en.Info(); err == nil && info.ModTime().Before(cutoff) {
			os.RemoveAll(filepath.Join(evictedDir(), en.Name()))
			log.Printf("purged evicted data %s", en.Name())
		}
	}
}
