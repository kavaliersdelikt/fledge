package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestCrashLoopRollsBackToPreviousBinary(t *testing.T) {
	dir := t.TempDir()
	priorCred, priorVersion := credentialFile, version
	credentialFile = filepath.Join(dir, "agent.credential")
	version = "9.9.9"
	defer func() { credentialFile, version = priorCred, priorVersion }()
	exe := filepath.Join(dir, "fledge-agent")
	os.WriteFile(exe, []byte("new"), 0755)
	os.WriteFile(exe+".prev", []byte("old"), 0755)
	m, _ := json.Marshal(updateMarker{JobID: "j", Attempt: 1, From: "9.9.8", To: "9.9.9"})
	os.WriteFile(markerPath(), m, 0600)
	for i := 1; i <= 3; i++ {
		if rolled, _ := checkBoot(exe); rolled {
			t.Fatalf("boot %d must not roll back yet", i)
		}
	}
	rolled, err := checkBoot(exe)
	if err != nil || !rolled {
		t.Fatalf("fourth failed boot must roll back, got rolled=%v err=%v", rolled, err)
	}
	if b, _ := os.ReadFile(exe); string(b) != "old" {
		t.Fatalf("previous binary not restored: %q", b)
	}
	if _, e := os.Stat(failedPath("9.9.9")); e != nil {
		t.Fatal("failed version must be remembered so it is not retried")
	}
	if _, e := os.Stat(rollbackPath()); e != nil {
		t.Fatal("rollback must be reported to the panel on the next heartbeat")
	}
}

func TestMarkerForOtherVersionIsDropped(t *testing.T) {
	dir := t.TempDir()
	priorCred, priorVersion := credentialFile, version
	credentialFile = filepath.Join(dir, "agent.credential")
	version = "1.0.0"
	defer func() { credentialFile, version = priorCred, priorVersion }()
	m, _ := json.Marshal(updateMarker{To: "2.0.0"})
	os.WriteFile(markerPath(), m, 0600)
	if rolled, _ := checkBoot(filepath.Join(dir, "x")); rolled {
		t.Fatal("must not roll back")
	}
	if _, e := os.Stat(markerPath()); e == nil {
		t.Fatal("stale marker must be removed")
	}
}
