package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
	"golang.org/x/sys/unix"
	"io"
	"log"
	"net"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"time"
)

func startSFTP() error {
	address := os.Getenv("SFTP_LISTEN")
	if address == "" {
		return nil
	}
	keyPath := env("SFTP_HOST_KEY", filepath.Join(filepath.Dir(credentialFile), "sftp_host_key"))
	raw, e := os.ReadFile(keyPath)
	if os.IsNotExist(e) {
		_, key, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			return err
		}
		der, err := x509.MarshalPKCS8PrivateKey(key)
		if err != nil {
			return err
		}
		raw = pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})
		if err = os.WriteFile(keyPath, raw, 0600); err != nil {
			return err
		}
	} else if e != nil {
		return e
	}
	signer, e := ssh.ParsePrivateKey(raw)
	if e != nil {
		return e
	}
	listener, e := net.Listen("tcp", address)
	if e != nil {
		return e
	}
	log.Printf("SFTP listening on %s; host key %s", address, ssh.FingerprintSHA256(signer.PublicKey()))
	slots := make(chan struct{}, 32)
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			select {
			case slots <- struct{}{}:
				go func() { defer func() { <-slots }(); serveSFTP(conn, signer) }()
			default:
				conn.Close()
			}
		}
	}()
	return nil
}

type sftpGrant struct {
	ServerID string `json:"serverId"`
	DiskMB   int64  `json:"diskMb"`
}

func serveSFTP(conn net.Conn, signer ssh.Signer) {
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(20 * time.Second))
	var grant sftpGrant
	var password string
	config := &ssh.ServerConfig{MaxAuthTries: 3, PasswordCallback: func(meta ssh.ConnMetadata, pass []byte) (*ssh.Permissions, error) {
		if e := request("POST", "/api/agent/sftp/authorize", map[string]string{"serverId": meta.User(), "password": string(pass)}, &grant, true); e != nil {
			return nil, errors.New("access denied")
		}
		password = string(pass)
		return &ssh.Permissions{}, nil
	}}
	config.AddHostKey(signer)
	session, chans, reqs, e := ssh.NewServerConn(conn, config)
	if e != nil {
		return
	}
	defer session.Close()
	conn.SetDeadline(time.Now().Add(15 * time.Minute))
	go ssh.DiscardRequests(reqs)
	stop := make(chan struct{})
	defer close(stop)
	go func() {
		ticker := time.NewTicker(20 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				var current sftpGrant
				if request("POST", "/api/agent/sftp/authorize", map[string]string{"serverId": grant.ServerID, "password": password}, &current, true) != nil {
					session.Close()
					return
				}
			}
		}
	}()
	for channel := range chans {
		if channel.ChannelType() != "session" {
			channel.Reject(ssh.UnknownChannelType, "SFTP only")
			continue
		}
		ch, requests, err := channel.Accept()
		if err != nil {
			continue
		}
		go func() {
			defer ch.Close()
			for r := range requests {
				var sub struct{ Name string }
				ok := r.Type == "subsystem" && ssh.Unmarshal(r.Payload, &sub) == nil && sub.Name == "sftp"
				r.Reply(ok, nil)
				if !ok {
					continue
				}
				h := &confinedSFTP{root: filepath.Join(dataRoot, grant.ServerID), budget: grant.DiskMB * 1048576}
				server := sftp.NewRequestServer(ch, sftp.Handlers{FileGet: h, FilePut: h, FileCmd: h, FileList: h})
				server.Serve()
				server.Close()
				return
			}
		}()
	}
}

type confinedSFTP struct {
	root   string
	budget int64
}

func (h *confinedSFTP) Fileread(r *sftp.Request) (io.ReaderAt, error) {
	return openSafe(h.root, r.Filepath)
}

var sftpWriteLock sync.Mutex

type quotaWriter struct {
	*os.File
	root   string
	budget int64
}

func (w *quotaWriter) WriteAt(p []byte, off int64) (int, error) {
	sftpWriteLock.Lock()
	defer sftpWriteLock.Unlock()
	if off < 0 || off > w.budget-int64(len(p)) {
		return 0, errors.New("disk allowance exceeded")
	}
	used, e := diskUsage(w.root)
	if e != nil {
		return 0, e
	}
	st, e := w.Stat()
	if e != nil {
		return 0, e
	}
	growth := off + int64(len(p)) - st.Size()
	if growth > 0 && used+growth > w.budget {
		return 0, errors.New("disk allowance exceeded")
	}
	return w.File.WriteAt(p, off)
}
func (h *confinedSFTP) Filewrite(r *sftp.Request) (io.WriterAt, error) {
	segments, e := parts(r.Filepath)
	if e != nil || len(segments) == 0 {
		return nil, errors.New("invalid file path")
	}
	d, e := dir(h.root, segments[:len(segments)-1], false)
	if e != nil {
		return nil, e
	}
	defer d.Close()
	flags := r.Pflags()
	if flags.Append {
		return nil, errors.New("append is unsupported; upload or resume by offset")
	}
	mode := syscall.O_WRONLY | syscall.O_NOFOLLOW | syscall.O_CLOEXEC | syscall.O_NONBLOCK
	if flags.Creat {
		mode |= syscall.O_CREAT
	}
	if flags.Excl {
		mode |= syscall.O_EXCL
	}
	fd, e := syscall.Openat(int(d.Fd()), segments[len(segments)-1], mode, 0600)
	if e != nil {
		return nil, e
	}
	f := os.NewFile(uintptr(fd), r.Filepath)
	st, e := f.Stat()
	if e != nil || !st.Mode().IsRegular() {
		f.Close()
		return nil, errors.New("regular file required")
	}
	if uid, gid, e := owner(d); e == nil {
		if e = f.Chown(uid, gid); e != nil {
			f.Close()
			return nil, e
		}
	}
	if flags.Trunc {
		if e = f.Truncate(0); e != nil {
			f.Close()
			return nil, e
		}
	}
	return &quotaWriter{f, h.root, h.budget}, nil
}

type fileListing []os.FileInfo

func (l fileListing) ListAt(dst []os.FileInfo, offset int64) (int, error) {
	if offset < 0 || offset >= int64(len(l)) {
		return 0, io.EOF
	}
	n := copy(dst, l[offset:])
	if n < len(dst) {
		return n, io.EOF
	}
	return n, nil
}
func (h *confinedSFTP) Filelist(r *sftp.Request) (sftp.ListerAt, error) {
	segments, e := parts(r.Filepath)
	if e != nil {
		return nil, e
	}
	if r.Method == "List" {
		d, e := dir(h.root, segments, false)
		if e != nil {
			return nil, e
		}
		defer d.Close()
		all, e := d.Readdir(-1)
		if e != nil {
			return nil, e
		}
		out := fileListing{}
		for _, f := range all {
			if f.Mode()&os.ModeSymlink == 0 {
				out = append(out, f)
			}
		}
		return out, nil
	}
	if r.Method == "Stat" || r.Method == "Lstat" {
		var f *os.File
		f, e = dir(h.root, segments, false)
		if e != nil {
			f, e = openSafe(h.root, r.Filepath)
		}
		if e != nil {
			return nil, e
		}
		defer f.Close()
		st, e := f.Stat()
		return fileListing{st}, e
	}
	return nil, errors.New("unsupported file operation")
}
func (h *confinedSFTP) Filecmd(r *sftp.Request) error {
	if r.Method == "Mkdir" {
		return mkdirSafe(h.root, r.Filepath)
	}
	segments, e := parts(r.Filepath)
	if e != nil || len(segments) == 0 {
		return errors.New("invalid path")
	}
	d, e := dir(h.root, segments[:len(segments)-1], false)
	if e != nil {
		return e
	}
	defer d.Close()
	name := segments[len(segments)-1]
	switch r.Method {
	case "Remove":
		return unix.Unlinkat(int(d.Fd()), name, 0)
	case "Rmdir":
		return unix.Unlinkat(int(d.Fd()), name, unix.AT_REMOVEDIR)
	case "Rename":
		target, e := parts(r.Target)
		if e != nil || len(target) == 0 {
			return errors.New("invalid target")
		}
		to, e := dir(h.root, target[:len(target)-1], false)
		if e != nil {
			return e
		}
		defer to.Close()
		return syscall.Renameat(int(d.Fd()), name, int(to.Fd()), target[len(target)-1])
	}
	return errors.New("unsupported operation; links, ownership and permissions cannot be changed")
}
