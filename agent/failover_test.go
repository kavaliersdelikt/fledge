package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestEvictMovesDataAsideAndHonoursRetention(t *testing.T) {
	priorRoot, priorDocker := dataRoot, runDocker
	dataRoot = t.TempDir()
	runDocker = func(args ...string) (string, error) { return "", nil }
	defer func() { dataRoot, runDocker = priorRoot, priorDocker; applyFailover(failoverConfig{}) }()
	id := "11111111-2222-3333-4444-555555555555"

	os.MkdirAll(filepath.Join(dataRoot, id), 0700)
	os.WriteFile(filepath.Join(dataRoot, id, "world"), []byte("x"), 0600)
	foMu.Lock()
	foConfig.EvictedRetentionDays = 7
	foMu.Unlock()
	if _, e := evictServer(id); e != nil {
		t.Fatal(e)
	}
	if _, e := os.Stat(filepath.Join(dataRoot, id)); e == nil {
		t.Fatal("the live directory must be gone")
	}
	kept, _ := os.ReadDir(evictedDir())
	if len(kept) != 1 {
		t.Fatalf("data should be kept aside, found %d entries", len(kept))
	}
	if held := heldIDs(nil); len(held) != 0 {
		t.Fatalf("an evicted server must no longer be reported as held: %v", held)
	}

	os.MkdirAll(filepath.Join(dataRoot, id), 0700)
	foMu.Lock()
	foConfig.EvictedRetentionDays = 0
	foMu.Unlock()
	if _, e := evictServer(id); e != nil {
		t.Fatal(e)
	}
	if kept, _ := os.ReadDir(evictedDir()); len(kept) != 1 {
		t.Fatal("zero retention deletes immediately instead of keeping another copy")
	}
	if _, e := evictServer("../../etc"); e == nil {
		t.Fatal("ids must be UUIDs")
	}
}

func TestHeldIDsListsDirectoriesAndIgnoresOthers(t *testing.T) {
	prior := dataRoot
	dataRoot = t.TempDir()
	defer func() { dataRoot = prior }()
	id := "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
	os.MkdirAll(filepath.Join(dataRoot, id), 0700)
	os.MkdirAll(filepath.Join(dataRoot, ".volumes"), 0700)
	os.MkdirAll(filepath.Join(dataRoot, "notes"), 0700)
	got := heldIDs([]string{"not-an-id"})
	if len(got) != 1 || got[0] != id {
		t.Fatalf("held = %v", got)
	}
}
