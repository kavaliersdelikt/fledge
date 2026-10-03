package main

import (
	"errors"
	"strings"
	"testing"
)

func TestExitInfoReportsCodeOOMAndLogTailOncePerExit(t *testing.T) {
	prior := runDocker
	defer func() { runDocker = prior }()
	exitCache.Lock()
	exitCache.byName = map[string]map[string]interface{}{}
	exitCache.Unlock()
	logReads := 0
	runDocker = func(args ...string) (string, error) {
		switch args[0] {
		case "inspect":
			return "/nvr-a|137|true|2026-10-02T10:00:00Z\n/nvr-b|0|false|2026-10-02T10:01:00Z\n/nvr-other|1|false|x", nil
		case "logs":
			logReads++
			return "line one\nOutOfMemoryError", nil
		}
		return "", errors.New("unexpected " + strings.Join(args, " "))
	}
	status := map[string]string{"nvr-a": "failed", "nvr-b": "stopped"}
	got := exitInfoFor(status)
	a := got["nvr-a"]
	if a["code"] != 137 || a["oomKilled"] != true || !strings.Contains(a["logTail"].(string), "OutOfMemoryError") {
		t.Fatalf("unexpected info for a: %#v", a)
	}
	if _, has := got["nvr-b"]["logTail"]; has {
		t.Fatal("a clean stop should not carry a log tail")
	}
	if _, leaked := got["nvr-other"]; leaked {
		t.Fatal("containers that were not asked about must be ignored")
	}
	again := exitInfoFor(status)
	if logReads != 1 || again["nvr-a"]["logTail"] == nil {
		t.Fatalf("the log tail must be read once per exit and then remembered (reads=%d)", logReads)
	}
	// Running again: the cache entry is dropped.
	exitInfoFor(map[string]string{"nvr-b": "stopped"})
	exitCache.Lock()
	_, kept := exitCache.byName["nvr-a"]
	exitCache.Unlock()
	if kept {
		t.Fatal("stale exit info was kept")
	}
}
