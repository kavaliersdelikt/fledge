package main

import (
	"encoding/json"
	"fmt"
	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestSFTPConfinesPathsAndEnforcesPerServerWriteAllowance(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret"), []byte("secret"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "escape")); err != nil {
		t.Fatal(err)
	}
	h := &confinedSFTP{root: root, budget: 12}
	for _, p := range []string{"/escape/secret", "/../secret"} {
		if f, err := h.Fileread(sftp.NewRequest("Get", p)); err == nil {
			if c, ok := f.(*os.File); ok {
				c.Close()
			}
			t.Fatalf("unsafe read accepted: %s", p)
		}
	}
	if err := os.WriteFile(filepath.Join(root, "data"), []byte("hello"), 0600); err != nil {
		t.Fatal(err)
	}
	f, err := os.OpenFile(filepath.Join(root, "data"), os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	w := &quotaWriter{f, root, 12}
	if _, err = w.WriteAt([]byte(" world"), 5); err != nil {
		t.Fatal(err)
	}
	if _, err = w.WriteAt([]byte("too much"), 11); err == nil {
		t.Fatal("SFTP quota allowed an oversized write")
	}
	if err = checkWriteBudget(root, "/new", 2, 12); err == nil {
		t.Fatal("browser transfer quota allowed an oversized write")
	}
	if err = checkWriteBudget(root, "/data", 4, 12); err != nil {
		t.Fatal(err)
	}
	if err = h.Filecmd(sftp.NewRequest("Symlink", "/link")); err == nil {
		t.Fatal("symlink creation was accepted")
	}
}

func TestSFTPSSHAuthSubsystemReadWriteAndPathConfinement(t *testing.T) {
	priorAPI, priorNode, priorRoot, priorCredential, priorCredFile := api, nodeID, dataRoot, credential, credentialFile
	root := t.TempDir()
	dataRoot, nodeID, credential = root, "node-test", "node-secret"
	credentialFile = filepath.Join(root, "credential")
	if err := os.WriteFile(credentialFile, []byte(credential), 0600); err != nil {
		t.Fatal(err)
	}
	serverID := "12345678-1234-1234-1234-123456789abc"
	serverRoot := filepath.Join(root, serverID)
	if err := os.Mkdir(serverRoot, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(serverRoot, "hello.txt"), []byte("hello"), 0600); err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret"), []byte("secret"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(serverRoot, "escape")); err != nil {
		t.Fatal(err)
	}
	apiServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var b map[string]string
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			http.Error(w, "bad request", 400)
			return
		}
		if r.Header.Get("Authorization") != "Bearer node-secret" || r.Header.Get("X-Node-ID") != "node-test" || b["serverId"] != serverID || b["password"] != "short-lived" {
			http.Error(w, "denied", 401)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"serverId":%q,"diskMb":1}`, serverID)
	}))
	defer apiServer.Close()
	api = apiServer.URL
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := ln.Addr().String()
	ln.Close()
	t.Setenv("SFTP_LISTEN", address)
	t.Setenv("SFTP_HOST_KEY", filepath.Join(root, "host-key"))
	if err = startSFTP(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		api, nodeID, dataRoot, credential, credentialFile = priorAPI, priorNode, priorRoot, priorCredential, priorCredFile
	}()
	var clientConn *ssh.Client
	var dialErr error
	for i := 0; i < 50; i++ {
		clientConn, dialErr = ssh.Dial("tcp", address, &ssh.ClientConfig{User: serverID, Auth: []ssh.AuthMethod{ssh.Password("short-lived")}, HostKeyCallback: ssh.InsecureIgnoreHostKey(), Timeout: time.Second})
		if dialErr == nil {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if dialErr != nil {
		t.Fatal(dialErr)
	}
	defer clientConn.Close()
	sess, err := clientConn.NewSession()
	if err != nil {
		t.Fatal(err)
	}
	defer sess.Close()
	rd, err := sess.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	wr, err := sess.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err = sess.RequestSubsystem("sftp"); err != nil {
		t.Fatal(err)
	}
	client, err := sftp.NewClientPipe(rd, wr)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	file, err := client.Open("/hello.txt")
	if err != nil {
		t.Fatal(err)
	}
	b, err := io.ReadAll(file)
	file.Close()
	if err != nil || string(b) != "hello" {
		t.Fatalf("SFTP read: %q, %v", b, err)
	}
	if _, err = client.Open("/escape/secret"); err == nil {
		t.Fatal("SFTP followed a symlink outside the server root")
	}
	traversal, traversalErr := client.Create("/../outside.txt")
	if traversalErr == nil {
		traversal.Close()
	}
	if _, err = os.Stat(filepath.Join(outside, "outside.txt")); err == nil {
		t.Fatal("SFTP wrote outside the server root")
	}
	f, err := client.Create("/new.txt")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.Write([]byte("new game file")); err != nil {
		t.Fatal(err)
	}
	if err = f.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err = client.Lstat("/new.txt"); err != nil {
		t.Fatal(err)
	}
}
