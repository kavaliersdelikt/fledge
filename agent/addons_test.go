package main

import (
	"crypto/sha256"
	"crypto/sha512"
	"encoding/hex"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func sha512hex(b []byte) string { s := sha512.Sum512(b); return hex.EncodeToString(s[:]) }
func sha256hex(b []byte) string { s := sha256.Sum256(b); return hex.EncodeToString(s[:]) }

// local allows the fetch code to talk to an httptest server on 127.0.0.1.
func local(t *testing.T) {
	t.Helper()
	fetchTesting.AllowHTTP, fetchTesting.AllowPrivate, fetchTesting.Client = true, true, &http.Client{Timeout: 5 * time.Second}
	t.Cleanup(func() { fetchTesting.AllowHTTP, fetchTesting.AllowPrivate, fetchTesting.Client = false, false, nil })
}
func setup(t *testing.T) (root string) {
	t.Helper()
	prior := dataRoot
	dataRoot = t.TempDir()
	t.Cleanup(func() { dataRoot = prior })
	root = filepath.Join(dataRoot, "srv")
	if e := os.MkdirAll(root, 0700); e != nil {
		t.Fatal(e)
	}
	return root
}
func fetchJob(url, path string, extra map[string]interface{}) *job {
	p := map[string]interface{}{"path": path, "url": url, "allowedHosts": []interface{}{"127.0.0.1"}}
	for k, v := range extra {
		p[k] = v
	}
	return &job{ID: "job-1", Kind: "file.fetch", Payload: p}
}

func TestFetchWritesVerifiedFileAndReplacesOldOne(t *testing.T) {
	local(t)
	root := setup(t)
	body := []byte("PK-fake-jar-contents")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write(body) }))
	defer srv.Close()
	if e := writeSafe(root, "/mods/old-1.0.jar", []byte("old")); e != nil {
		t.Fatal(e)
	}
	res, e := fetchFile(fetchJob(srv.URL+"/a.jar", "/mods/new-2.0.jar", map[string]interface{}{"sha512": sha512hex(body), "size": float64(len(body)), "replace": []interface{}{"/mods/old-1.0.jar", "/mods/missing.jar"}}), root, 100)
	if e != nil {
		t.Fatal(e)
	}
	got, _ := os.ReadFile(filepath.Join(root, "mods", "new-2.0.jar"))
	if string(got) != string(body) {
		t.Fatalf("file content %q", got)
	}
	if _, e := os.Stat(filepath.Join(root, "mods", "old-1.0.jar")); !os.IsNotExist(e) {
		t.Fatal("old file was not replaced")
	}
	if m := res.(map[string]interface{}); m["sizeBytes"].(int64) != int64(len(body)) || m["replaceErrors"] != nil {
		t.Fatalf("result %#v", res)
	}
	// Nothing is left behind in the data root.
	left, _ := filepath.Glob(filepath.Join(dataRoot, ".fetch-*"))
	if len(left) != 0 {
		t.Fatalf("temp files left: %v", left)
	}
}

func TestFetchAcceptsSHA256Only(t *testing.T) {
	local(t)
	root := setup(t)
	body := []byte("hello")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write(body) }))
	defer srv.Close()
	if _, e := fetchFile(fetchJob(srv.URL, "/p/x.jar", map[string]interface{}{"sha256": sha256hex(body)}), root, 100); e != nil {
		t.Fatal(e)
	}
}

func TestFetchRefusesChecksumMismatchAndKeepsExistingFile(t *testing.T) {
	local(t)
	root := setup(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("tampered")) }))
	defer srv.Close()
	if e := writeSafe(root, "/mods/a.jar", []byte("good")); e != nil {
		t.Fatal(e)
	}
	_, e := fetchFile(fetchJob(srv.URL, "/mods/a.jar", map[string]interface{}{"sha512": sha512hex([]byte("original"))}), root, 100)
	if e == nil || !strings.Contains(e.Error(), "checksum mismatch") {
		t.Fatalf("expected checksum mismatch, got %v", e)
	}
	if b, _ := os.ReadFile(filepath.Join(root, "mods", "a.jar")); string(b) != "good" {
		t.Fatal("existing file was overwritten by a bad download")
	}
}

func TestFetchRequiresChecksumHostAndSafePath(t *testing.T) {
	local(t)
	root := setup(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("x")) }))
	defer srv.Close()
	sum := map[string]interface{}{"sha512": sha512hex([]byte("x"))}
	if _, e := fetchFile(fetchJob(srv.URL, "/mods/a.jar", nil), root, 100); e == nil || !strings.Contains(e.Error(), "checksum is required") {
		t.Fatalf("no checksum accepted: %v", e)
	}
	j := fetchJob(srv.URL, "/mods/a.jar", sum)
	j.Payload["allowedHosts"] = []interface{}{"cdn.example.org"}
	if _, e := fetchFile(j, root, 100); e == nil || !strings.Contains(e.Error(), "not an allowed download host") {
		t.Fatalf("unlisted host accepted: %v", e)
	}
	j = fetchJob(srv.URL, "/mods/a.jar", sum)
	delete(j.Payload, "allowedHosts")
	if _, e := fetchFile(j, root, 100); e == nil {
		t.Fatal("a job without allowed hosts was accepted")
	}
	for _, bad := range []string{"/../escape.jar", "/mods/../../x.jar", "relative.jar"} {
		if _, e := fetchFile(fetchJob(srv.URL, bad, sum), root, 100); e == nil {
			t.Fatalf("path %q accepted", bad)
		}
	}
	outside := t.TempDir()
	if e := os.Symlink(outside, filepath.Join(root, "link")); e != nil {
		t.Fatal(e)
	}
	if _, e := fetchFile(fetchJob(srv.URL, "/link/x.jar", sum), root, 100); e == nil {
		t.Fatal("a symlinked folder was followed")
	}
	if _, e := os.Stat(filepath.Join(outside, "x.jar")); e == nil {
		t.Fatal("file escaped through the symlink")
	}
}

func TestFetchLimitsSizeAndStatus(t *testing.T) {
	local(t)
	root := setup(t)
	big := strings.Repeat("a", 5000)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/missing" {
			http.NotFound(w, r)
			return
		}
		w.Write([]byte(big))
	}))
	defer srv.Close()
	sum := map[string]interface{}{"sha512": sha512hex([]byte(big))}
	if _, e := fetchFile(fetchJob(srv.URL, "/m/a.jar", map[string]interface{}{"sha512": sum["sha512"], "maxBytes": float64(1000)}), root, 100); e == nil || !strings.Contains(e.Error(), "larger than") {
		t.Fatalf("oversize accepted: %v", e)
	}
	if _, e := fetchFile(fetchJob(srv.URL, "/m/a.jar", map[string]interface{}{"sha512": sum["sha512"], "size": float64(10)}), root, 100); e == nil || !strings.Contains(e.Error(), "does not match the expected size") {
		t.Fatalf("size mismatch accepted: %v", e)
	}
	if _, e := fetchFile(fetchJob(srv.URL+"/missing", "/m/a.jar", sum), root, 100); e == nil || !strings.Contains(e.Error(), "404") {
		t.Fatalf("404 accepted: %v", e)
	}
	if _, e := os.Stat(filepath.Join(root, "m", "a.jar")); e == nil {
		t.Fatal("a failed download left a file")
	}
}

func TestFetchRespectsTheServerDiskAllowance(t *testing.T) {
	local(t)
	root := setup(t)
	body := []byte(strings.Repeat("z", 3<<20))
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write(body) }))
	defer srv.Close()
	// A 1 MB allowance cannot hold a 3 MB file.
	if _, e := fetchFile(fetchJob(srv.URL, "/m/a.jar", map[string]interface{}{"sha512": sha512hex(body)}), root, 1); e == nil {
		t.Fatal("the disk allowance was ignored")
	}
}

func TestFetchRedirectsMustStayOnAllowedHosts(t *testing.T) {
	local(t)
	root := setup(t)
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("x")) }))
	defer other.Close()
	// Redirect to the same IP but a different (unlisted) host name.
	otherURL := strings.Replace(other.URL, "127.0.0.1", "localhost", 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, otherURL, http.StatusFound) }))
	defer srv.Close()
	_, e := fetchFile(fetchJob(srv.URL, "/m/a.jar", map[string]interface{}{"sha512": sha512hex([]byte("x"))}), root, 100)
	if e == nil || !strings.Contains(e.Error(), "not an allowed download host") {
		t.Fatalf("redirect to an unlisted host followed: %v", e)
	}
}

func TestFetchNeverDialsPrivateAddresses(t *testing.T) {
	// The real client (no test client) refuses loopback even though the URL check passed.
	fetchTesting.AllowHTTP, fetchTesting.AllowPrivate = true, true
	defer func() { fetchTesting.AllowHTTP, fetchTesting.AllowPrivate = false, false }()
	root := setup(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("x")) }))
	defer srv.Close()
	_, e := fetchFile(fetchJob(srv.URL, "/m/a.jar", map[string]interface{}{"sha512": sha512hex([]byte("x"))}), root, 100)
	if e == nil || !strings.Contains(e.Error(), "private or local address") {
		t.Fatalf("loopback was dialled: %v", e)
	}
}

func TestFetchOnlyAllowsHTTPSAndPublicHostsInProduction(t *testing.T) {
	root := setup(t)
	sum := map[string]interface{}{"sha512": sha512hex([]byte("x"))}
	for _, u := range []string{"http://cdn.example.org/a.jar", "https://user:pw@cdn.example.org/a.jar", "https://cdn.example.org:8443/a.jar", "https://10.0.0.5/a.jar", "ftp://cdn.example.org/a.jar"} {
		j := fetchJob(u, "/m/a.jar", sum)
		j.Payload["allowedHosts"] = []interface{}{"cdn.example.org", "10.0.0.5"}
		if _, e := fetchFile(j, root, 100); e == nil {
			t.Fatalf("%s was accepted", u)
		}
	}
}

func TestPrivateAddressClassification(t *testing.T) {
	for _, ip := range []string{"127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "240.0.0.1", "::1", "fe80::1", "fc00::1"} {
		if !privateIP(net.ParseIP(ip)) {
			t.Fatalf("%s should be private", ip)
		}
	}
	for _, ip := range []string{"8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700:4700::1111", "100.128.0.1"} {
		if privateIP(net.ParseIP(ip)) {
			t.Fatalf("%s should be public", ip)
		}
	}
	if !hostAllowed("cdn.modrinth.com", []string{"*.modrinth.com"}) || hostAllowed("modrinth.com", []string{"*.modrinth.com"}) || hostAllowed("evilmodrinth.com", []string{"*.modrinth.com"}) {
		t.Fatal("wildcard host matching is wrong")
	}
}

func TestDeleteFilesRemovesFilesOnly(t *testing.T) {
	root := setup(t)
	for _, p := range []string{"/mods/a.jar", "/mods/b.jar.disabled"} {
		if e := writeSafe(root, p, []byte("x")); e != nil {
			t.Fatal(e)
		}
	}
	outside := filepath.Join(t.TempDir(), "victim")
	os.WriteFile(outside, []byte("keep"), 0600)
	os.Symlink(outside, filepath.Join(root, "mods", "link.jar"))
	res, e := deleteFiles(&job{Payload: map[string]interface{}{"paths": []interface{}{"/mods/a.jar", "/mods/b.jar.disabled", "/mods/never-existed.jar", "/mods/link.jar"}}}, root)
	if e != nil {
		t.Fatal(e)
	}
	if res.(map[string]interface{})["deleted"].(int) != 3 {
		t.Fatalf("deleted %v", res)
	}
	if _, e := os.Stat(outside); e != nil {
		t.Fatal("deleting a symlink removed its target")
	}
	// A directory is never removed.
	os.MkdirAll(filepath.Join(root, "mods", "folder"), 0700)
	if _, e := deleteFiles(&job{Payload: map[string]interface{}{"paths": []interface{}{"/mods/folder"}}}, root); e == nil {
		t.Fatal("a directory was deleted")
	}
	for _, bad := range []string{"/../x", "relative", "/"} {
		if _, e := deleteFiles(&job{Payload: map[string]interface{}{"paths": []interface{}{bad}}}, root); e == nil {
			t.Fatalf("%q accepted", bad)
		}
	}
	if _, e := deleteFiles(&job{Payload: map[string]interface{}{"paths": []interface{}{}}}, root); e == nil {
		t.Fatal("empty list accepted")
	}
}

func TestRenameTogglesDisabledSuffixOnly(t *testing.T) {
	root := setup(t)
	if e := writeSafe(root, "/mods/a.jar", []byte("x")); e != nil {
		t.Fatal(e)
	}
	r := func(from, to string) error {
		_, e := renameFile(&job{Payload: map[string]interface{}{"from": from, "to": to}}, root)
		return e
	}
	if e := r("/mods/a.jar", "/mods/a.jar.disabled"); e != nil {
		t.Fatal(e)
	}
	if _, e := os.Stat(filepath.Join(root, "mods", "a.jar.disabled")); e != nil {
		t.Fatal("not renamed")
	}
	if e := r("/mods/a.jar.disabled", "/mods/a.jar"); e != nil {
		t.Fatal(e)
	}
	for _, bad := range [][2]string{{"/mods/a.jar", "/mods/b.jar"}, {"/mods/a.jar", "/other/a.jar.disabled"}, {"/mods/a.jar", "/mods/../a.jar.disabled"}, {"/mods/a.jar", "/mods/a.jar"}} {
		if r(bad[0], bad[1]) == nil {
			t.Fatalf("%v accepted", bad)
		}
	}
	// Never overwrites an existing file.
	writeSafe(root, "/mods/c.jar", []byte("1"))
	writeSafe(root, "/mods/c.jar.disabled", []byte("2"))
	if e := r("/mods/c.jar", "/mods/c.jar.disabled"); e == nil || !strings.Contains(e.Error(), "already exists") {
		t.Fatalf("overwrite not refused: %v", e)
	}
	if b, _ := os.ReadFile(filepath.Join(root, "mods", "c.jar.disabled")); string(b) != "2" {
		t.Fatal("existing file was overwritten")
	}
	_ = errors.New
}
