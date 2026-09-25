package main

import (
	"archive/zip"
	"bytes"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"syscall"
	"testing"
)

func TestSafeFiles(t *testing.T) {
	root := t.TempDir()
	if err := writeSafe(root, "/world/data.txt", []byte("hello")); err != nil {
		t.Fatal(err)
	}
	got, e := readFile(root, "/world/data.txt", true)
	if e != nil || got.(map[string]string)["content"] != "hello" {
		t.Fatalf("read: %v %v", got, e)
	}
	if e = writeSafe(root, "/../escape", []byte("bad")); e == nil {
		t.Fatal("traversal accepted")
	}
	outside := t.TempDir()
	if e = os.Symlink(outside, filepath.Join(root, "link")); e != nil {
		t.Fatal(e)
	}
	if e = writeSafe(root, "/link/escape", []byte("bad")); e == nil {
		t.Fatal("symlink accepted")
	}
	if _, e = readFile(root, "/link/escape", true); e == nil {
		t.Fatal("symlink read accepted")
	}
}
func TestDataOwnership(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("requires root, like supplied service")
	}
	root := t.TempDir()
	if e := os.Chown(root, 12345, 12345); e != nil {
		t.Fatal(e)
	}
	if e := writeSafe(root, "/world/save.txt", []byte("game")); e != nil {
		t.Fatal(e)
	}
	for _, p := range []string{"world", "world/save.txt"} {
		fi, e := os.Stat(filepath.Join(root, p))
		if e != nil {
			t.Fatal(e)
		}
		st := fi.Sys().(*syscall.Stat_t)
		if st.Uid != 12345 || st.Gid != 12345 {
			t.Fatalf("%s owner: %d:%d", p, st.Uid, st.Gid)
		}
	}
}
func TestZipTraversal(t *testing.T) {
	root := t.TempDir()
	var buf bytes.Buffer
	w := zip.NewWriter(&buf)
	f, e := w.Create("../escape")
	if e != nil {
		t.Fatal(e)
	}
	f.Write([]byte("bad"))
	w.Close()
	if e = writeSafe(root, "/test.zip", buf.Bytes()); e != nil {
		t.Fatal(e)
	}
	if e = extractZip(root, "/test.zip"); e == nil {
		t.Fatal("zip slip accepted")
	}
}
func TestBackupRestore(t *testing.T) {
	dataRoot = t.TempDir()
	source := filepath.Join(dataRoot, "source")
	dest := filepath.Join(dataRoot, "dest")
	os.Mkdir(source, 0700)
	if e := writeSafe(source, "/world/file.txt", []byte("save")); e != nil {
		t.Fatal(e)
	}
	var archive []byte
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "PUT" {
			archive, _ = os.ReadFile("/dev/null")
			var b bytes.Buffer
			b.ReadFrom(r.Body)
			archive = b.Bytes()
			w.WriteHeader(200)
		} else {
			w.Write(archive)
		}
	}))
	defer server.Close()
	size, e := backup(source, server.URL, "test")
	if e != nil || size == 0 {
		t.Fatalf("backup: %v size %d", e, size)
	}
	if e = restore(dest, server.URL, "test"); e != nil {
		t.Fatal(e)
	}
	v, e := readFile(dest, "/world/file.txt", true)
	if e != nil || v.(map[string]string)["content"] != "save" {
		t.Fatalf("restore %v %v", v, e)
	}
}

func TestBackupStopsAndRestartsRunningContainer(t *testing.T) {
	dataRoot = t.TempDir()
	root := filepath.Join(dataRoot, "running")
	if e := os.Mkdir(root, 0700); e != nil {
		t.Fatal(e)
	}
	if e := writeSafe(root, "/world/save.dat", []byte("stable save")); e != nil {
		t.Fatal(e)
	}
	var archive []byte
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut {
			t.Errorf("unexpected request method %s", r.Method)
			w.WriteHeader(405)
			return
		}
		archive, _ = io.ReadAll(r.Body)
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	oldRunner := runDocker
	defer func() { runDocker = oldRunner }()
	state := "true"
	var calls []string
	runDocker = func(args ...string) (string, error) {
		calls = append(calls, strings.Join(args, " "))
		switch args[0] {
		case "inspect":
			if strings.Contains(strings.Join(args, " "), "ExitCode") {
				return "0", nil
			}
			return state, nil
		case "stop":
			state = "false"
			return "", nil
		case "start":
			state = "true"
			return "", nil
		default:
			return "", fmt.Errorf("unexpected docker command %q", args[0])
		}
	}
	size, err := backupWithLifecycle(root, server.URL, "lifecycle-running", "nvr-test")
	if err != nil || size <= 0 {
		t.Fatalf("backup lifecycle: size=%d err=%v", size, err)
	}
	if state != "true" {
		t.Fatalf("running container was not restarted: %q", state)
	}
	want := []string{"inspect --format {{.State.Running}} nvr-test", "stop -t 30 nvr-test", "inspect --format {{.State.ExitCode}} nvr-test", "start nvr-test"}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("docker calls = %#v, want %#v", calls, want)
	}
	if len(archive) == 0 {
		t.Fatal("archive was not uploaded")
	}
}

func TestBackupLifecyclePreservesStoppedStateAndReportsRestartFailure(t *testing.T) {
	dataRoot = t.TempDir()
	root := filepath.Join(dataRoot, "stopped")
	if e := os.Mkdir(root, 0700); e != nil {
		t.Fatal(e)
	}
	var archive []byte
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		archive, _ = io.ReadAll(r.Body)
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()
	oldRunner := runDocker
	defer func() { runDocker = oldRunner }()
	var calls []string
	runDocker = func(args ...string) (string, error) {
		calls = append(calls, strings.Join(args, " "))
		return "false", nil
	}
	size, err := backupWithLifecycle(root, server.URL, "lifecycle-stopped", "nvr-test")
	if err != nil {
		t.Fatal(err)
	}
	if size <= 0 || len(archive) == 0 {
		t.Fatalf("stopped backup was not uploaded: size=%d", size)
	}
	if !reflect.DeepEqual(calls, []string{"inspect --format {{.State.Running}} nvr-test"}) {
		t.Fatalf("stopped container lifecycle calls: %#v", calls)
	}

	calls = nil
	runDocker = func(args ...string) (string, error) {
		calls = append(calls, strings.Join(args, " "))
		switch args[0] {
		case "inspect":
			if strings.Contains(strings.Join(args, " "), "ExitCode") {
				return "0", nil
			}
			return "true", nil
		case "stop":
			return "", nil
		case "start":
			return "", errors.New("engine refused start")
		default:
			return "", fmt.Errorf("unexpected command %q", args[0])
		}
	}
	size, err = backupWithLifecycle(root, server.URL, "lifecycle-restart-fail", "nvr-test")
	if err == nil || !strings.Contains(err.Error(), "backup uploaded but server restart failed") || size <= 0 {
		t.Fatalf("restart failure should preserve uploaded size and report recovery action: size=%d err=%v", size, err)
	}
}
