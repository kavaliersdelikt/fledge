package main

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

func parts(p string) ([]string, error) {
	if !strings.HasPrefix(p, "/") {
		return nil, errors.New("virtual path must start with /")
	}
	var out []string
	for _, c := range strings.Split(p, "/") {
		if c == "" {
			continue
		}
		if c == "." || c == ".." || strings.ContainsRune(c, 0) || strings.ContainsRune(c, '\\') {
			return nil, errors.New("invalid path component")
		}
		out = append(out, c)
	}
	return out, nil
}
func owner(f *os.File) (int, int, error) {
	st, e := f.Stat()
	if e != nil {
		return 0, 0, e
	}
	sys, ok := st.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, 0, errors.New("cannot determine data ownership")
	}
	return int(sys.Uid), int(sys.Gid), nil
}
func dir(root string, components []string, create bool) (*os.File, error) {
	fi, e := os.Lstat(root)
	if e != nil {
		return nil, e
	}
	if !fi.IsDir() || fi.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("unsafe data root")
	}
	f, e := os.Open(root)
	if e != nil {
		return nil, e
	}
	for _, name := range components {
		fd, e := syscall.Openat(int(f.Fd()), name, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
		if e != nil && create && e == syscall.ENOENT {
			uid, gid, ownerErr := owner(f)
			if ownerErr != nil {
				f.Close()
				return nil, ownerErr
			}
			created := false
			if e = syscall.Mkdirat(int(f.Fd()), name, 0700); e == nil {
				created = true
			} else if e != syscall.EEXIST {
				f.Close()
				return nil, e
			}
			if created {
				if e = syscall.Fchownat(int(f.Fd()), name, uid, gid, 0); e != nil {
					f.Close()
					return nil, e
				}
			}
			fd, e = syscall.Openat(int(f.Fd()), name, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
		}
		if e != nil {
			f.Close()
			return nil, e
		}
		f.Close()
		f = os.NewFile(uintptr(fd), name)
	}
	return f, nil
}
func openSafe(root, p string) (*os.File, error) {
	segments, e := parts(p)
	if e != nil {
		return nil, e
	}
	if len(segments) == 0 {
		return nil, errors.New("path is a directory")
	}
	d, e := dir(root, segments[:len(segments)-1], false)
	if e != nil {
		return nil, e
	}
	defer d.Close()
	fd, e := syscall.Openat(int(d.Fd()), segments[len(segments)-1], syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if e != nil {
		return nil, e
	}
	f := os.NewFile(uintptr(fd), p)
	fi, e := f.Stat()
	if e != nil || !fi.Mode().IsRegular() {
		f.Close()
		return nil, errors.New("regular file required")
	}
	return f, nil
}
func listFiles(root, p string) (interface{}, error) {
	segments, e := parts(p)
	if e != nil {
		return nil, e
	}
	d, e := dir(root, segments, false)
	if e != nil {
		return nil, e
	}
	defer d.Close()
	entries, e := d.Readdir(-1)
	if e != nil {
		return nil, e
	}
	items := []map[string]interface{}{}
	for _, v := range entries {
		if v.Mode()&os.ModeSymlink != 0 {
			continue
		}
		items = append(items, map[string]interface{}{"name": v.Name(), "path": path.Join(p, v.Name()), "type": map[bool]string{true: "directory", false: "file"}[v.IsDir()], "size": v.Size(), "modifiedAt": v.ModTime()})
	}
	return map[string]interface{}{"path": p, "items": items}, nil
}
func readFile(root, p string, text bool) (interface{}, error) {
	f, e := openSafe(root, p)
	if e != nil {
		return nil, e
	}
	defer f.Close()
	b, e := io.ReadAll(io.LimitReader(f, maxTransfer+1))
	if e != nil {
		return nil, e
	}
	if len(b) > maxTransfer {
		return nil, errors.New("file exceeds 8 MiB API download limit")
	}
	if text {
		return map[string]string{"content": string(b)}, nil
	}
	return map[string]string{"data": base64.StdEncoding.EncodeToString(b), "name": path.Base(p)}, nil
}
func mkdirSafe(root, p string) error {
	segments, e := parts(p)
	if e != nil {
		return e
	}
	d, e := dir(root, segments, true)
	if e == nil {
		d.Close()
	}
	return e
}
func writeSafe(root, p string, data []byte) error {
	return writeSafeStream(root, p, bytes.NewReader(data), int64(len(data)))
}
func writeSafeStream(root, p string, src io.Reader, size int64) error {
	segments, e := parts(p)
	if e != nil {
		return e
	}
	if len(segments) == 0 {
		return errors.New("cannot overwrite root")
	}
	d, e := dir(root, segments[:len(segments)-1], true)
	if e != nil {
		return e
	}
	defer d.Close()
	random := make([]byte, 12)
	if _, e = rand.Read(random); e != nil {
		return e
	}
	tmp := fmt.Sprintf(".navrylo-tmp-%x", random)
	fd, e := syscall.Openat(int(d.Fd()), tmp, syscall.O_WRONLY|syscall.O_CREAT|syscall.O_EXCL|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0600)
	if e != nil {
		return e
	}
	f := os.NewFile(uintptr(fd), tmp)
	defer syscall.Unlinkat(int(d.Fd()), tmp)
	uid, gid, e := owner(d)
	if e == nil {
		e = f.Chown(uid, gid)
	}
	if e != nil {
		f.Close()
		return e
	}
	written, e := io.CopyN(f, src, size)
	if e == nil && written != size {
		e = io.ErrUnexpectedEOF
	}
	if e == nil {
		e = f.Sync()
	}
	closeErr := f.Close()
	if e != nil {
		return e
	}
	if closeErr != nil {
		return closeErr
	}
	return syscall.Renameat(int(d.Fd()), tmp, int(d.Fd()), segments[len(segments)-1])
}
func extractZip(root, p string) error {
	f, e := openSafe(root, p)
	if e != nil {
		return e
	}
	defer f.Close()
	stat, e := f.Stat()
	if e != nil {
		return e
	}
	if stat.Size() > maxTransfer {
		return errors.New("zip exceeds 8 MiB upload limit")
	}
	z, e := zip.NewReader(f, stat.Size())
	if e != nil {
		return e
	}
	if len(z.File) > 10000 {
		return errors.New("too many archive entries")
	}
	base := path.Dir(p)
	var total int64
	for _, entry := range z.File {
		if entry.Mode()&os.ModeSymlink != 0 || (!entry.Mode().IsRegular() && !entry.FileInfo().IsDir()) {
			return errors.New("unsupported archive entry")
		}
		segments, e := parts("/" + entry.Name)
		if e != nil {
			return e
		}
		if len(segments) == 0 {
			continue
		}
		dest := path.Join(base, path.Join(segments...))
		if !strings.HasPrefix(dest, "/") {
			dest = "/" + dest
		}
		if entry.FileInfo().IsDir() {
			if e = mkdirSafe(root, dest); e != nil {
				return e
			}
			continue
		}
		total += int64(entry.UncompressedSize64)
		if total > 100<<20 {
			return errors.New("extracted data exceeds 100 MiB")
		}
		r, e := entry.Open()
		if e != nil {
			return e
		}
		e = writeSafeStream(root, dest, r, int64(entry.UncompressedSize64))
		r.Close()
		if e != nil {
			return e
		}
	}
	return nil
}
func backup(root, link, id string) (int64, error) {
	fi, e := os.Lstat(root)
	if e != nil {
		return 0, e
	}
	if !fi.IsDir() || fi.Mode()&os.ModeSymlink != 0 {
		return 0, errors.New("unsafe data root")
	}
	temp, e := os.CreateTemp(dataRoot, ".backup-"+id+"-")
	if e != nil {
		return 0, e
	}
	defer os.Remove(temp.Name())
	defer temp.Close()
	gzipWriter := gzip.NewWriter(temp)
	tarWriter := tar.NewWriter(gzipWriter)
	e = filepath.Walk(root, func(p string, fi os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if p == root {
			return nil
		}
		if fi.Mode()&os.ModeSymlink != 0 {
			return nil
		}
		if !fi.IsDir() && !fi.Mode().IsRegular() {
			return nil
		}
		rel, e := filepath.Rel(root, p)
		if e != nil {
			return e
		}
		h, e := tar.FileInfoHeader(fi, "")
		if e != nil {
			return e
		}
		h.Name = filepath.ToSlash(rel)
		if e = tarWriter.WriteHeader(h); e != nil {
			return e
		}
		if fi.Mode().IsRegular() {
			f, e := openSafe(root, "/"+filepath.ToSlash(rel))
			if e != nil {
				return e
			}
			_, e = io.Copy(tarWriter, io.LimitReader(f, fi.Size()))
			f.Close()
			return e
		}
		return nil
	})
	if closeErr := tarWriter.Close(); e == nil {
		e = closeErr
	}
	if closeErr := gzipWriter.Close(); e == nil {
		e = closeErr
	}
	if e != nil {
		return 0, e
	}
	stat, e := temp.Stat()
	if e != nil {
		return 0, e
	}
	if stat.Size() > 10<<30 {
		return 0, errors.New("backup exceeds 10 GiB")
	}
	// Walk the actual generated gzip/tar file before publishing it. Reading all
	// entry bytes through gzip.Reader validates its CRC and truncated streams.
	if _, e = temp.Seek(0, 0); e != nil {
		return 0, e
	}
	if e = scanArchive(temp, ""); e != nil {
		return 0, fmt.Errorf("backup archive verification failed: %w", e)
	}
	if _, e = temp.Seek(0, 0); e != nil {
		return 0, e
	}
	r, e := http.NewRequest("PUT", api+link, temp)
	if e != nil {
		return 0, errors.New("invalid S3 upload URL")
	}
	r.ContentLength = stat.Size()
	r.Header.Set("Content-Type", "application/octet-stream")
	r.Header.Set("Authorization", "Bearer "+credential)
	r.Header.Set("X-Node-ID", nodeID)
	res, e := (&http.Client{Timeout: 30 * time.Minute}).Do(r)
	if e != nil {
		return 0, errors.New("S3 upload transport failed (check agent S3 network access)")
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return 0, fmt.Errorf("S3 PUT: %s", res.Status)
	}
	return stat.Size(), nil
}

// backupWithLifecycle asks Docker to stop the game cleanly before archiving
// files, then restores the original running state. This narrows the window
// where games can mutate files while tar is reading them. It is not a
// filesystem snapshot and depends on the image handling Docker's stop signal.
func backupWithLifecycle(root, link, id, name string) (int64, error) {
	state, err := docker("inspect", "--format", "{{.State.Running}}", name)
	if err != nil {
		return 0, err
	}
	if state != "true" && state != "false" {
		return 0, errors.New("unknown container state")
	}
	wasRunning := state == "true"
	if wasRunning {
		if _, err = docker("stop", "-t", "30", name); err != nil {
			return 0, err
		}
	}
	if wasRunning {
		code, inspectErr := docker("inspect", "--format", "{{.State.ExitCode}}", name)
		if inspectErr != nil || code != "0" {
			_, restartErr := docker("start", name)
			return 0, fmt.Errorf("backup refused: game did not exit cleanly (exit %s, inspect %v, restart %v)", code, inspectErr, restartErr)
		}
	}
	size, backupErr := backup(root, link, id)
	if wasRunning {
		if _, err = docker("start", name); err != nil {
			if backupErr != nil {
				return size, fmt.Errorf("backup failed: %v; server restart failed: %w", backupErr, err)
			}
			return size, fmt.Errorf("backup uploaded but server restart failed: %w", err)
		}
	}
	return size, backupErr
}

// scanArchive validates entry names/types, reads every byte and checks the
// gzip checksum. If destination is nonempty it extracts only into that private
// staging directory; the live data directory is never touched during parsing.
func scanArchive(source io.Reader, destination string) error {
	gz, e := gzip.NewReader(io.LimitReader(source, (10<<30)+1))
	if e != nil {
		return e
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	seen := make(map[string]bool)
	var total int64
	for count := 0; ; count++ {
		h, e := tr.Next()
		if e == io.EOF {
			// tar.Reader stops at its end markers, but gzip must be drained to
			// verify the checksum and reject nonzero trailing payload.
			var tail [4096]byte
			remaining := 16384
			for {
				n, err := gz.Read(tail[:])
				remaining -= n
				if remaining < 0 {
					return errors.New("unexpected trailing archive data")
				}
				for _, v := range tail[:n] {
					if v != 0 {
						return errors.New("unexpected trailing archive data")
					}
				}
				if err == io.EOF {
					return nil
				}
				if err != nil {
					return err
				}
			}
		}
		if e != nil {
			return e
		}
		if count >= 100000 {
			return errors.New("archive contains too many entries")
		}
		if h.Name == "" || strings.HasPrefix(h.Name, "/") {
			return errors.New("unsafe archive path")
		}
		segments, e := parts("/" + h.Name)
		if e != nil || len(segments) == 0 {
			return errors.New("unsafe archive path")
		}
		p := "/" + path.Join(segments...)
		if seen[p] {
			return errors.New("duplicate archive path")
		}
		seen[p] = true
		switch h.Typeflag {
		case tar.TypeDir:
			if h.Size != 0 {
				return errors.New("invalid directory entry")
			}
			if destination != "" {
				if e = mkdirSafe(destination, p); e != nil {
					return e
				}
			}
		case tar.TypeReg, tar.TypeRegA:
			if h.Size < 0 || h.Size > (10<<30)-total {
				return errors.New("archive exceeds 10 GiB")
			}
			total += h.Size
			if destination != "" {
				if e = writeSafeStream(destination, p, tr, h.Size); e != nil {
					return e
				}
			} else if _, e = io.CopyN(io.Discard, tr, h.Size); e != nil {
				return e
			}
		default:
			return errors.New("unsafe archive entry type")
		}
	}
}

// Linux renameat2(RENAME_EXCHANGE) swaps two directories in one operation.
// Refuse unsupported architectures/filesystems rather than expose a partial
// restore with a two-rename window. The previous root remains at staging.
func exchangeDirs(parent, oldName, newName string) error {
	number := uintptr(0)
	switch runtime.GOARCH {
	case "amd64":
		number = 316
	case "arm64":
		number = 276
	default:
		return errors.New("atomic restore unsupported on this architecture")
	}
	fd, e := syscall.Open(parent, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
	if e != nil {
		return e
	}
	defer syscall.Close(fd)
	oldPtr, e := syscall.BytePtrFromString(oldName)
	if e != nil {
		return e
	}
	newPtr, e := syscall.BytePtrFromString(newName)
	if e != nil {
		return e
	}
	_, _, errno := syscall.Syscall6(number, uintptr(fd), uintptr(unsafe.Pointer(oldPtr)), uintptr(fd), uintptr(unsafe.Pointer(newPtr)), 2, 0)
	if errno != 0 {
		return fmt.Errorf("atomic directory exchange failed: %w", errno)
	}
	return nil
}

func restoreWithPostSwap(root, link, id string, postSwap func() error) error {
	parent := filepath.Dir(root)
	if e := os.MkdirAll(parent, 0700); e != nil {
		return e
	}
	current, e := os.Lstat(root)
	if e != nil && !os.IsNotExist(e) {
		return e
	}
	if e == nil && (!current.IsDir() || current.Mode()&os.ModeSymlink != 0) {
		return errors.New("unsafe data root")
	}
	stage, e := os.MkdirTemp(parent, ".restore-")
	if e != nil {
		return e
	}
	cleanupStage := true
	defer func() {
		if cleanupStage {
			os.RemoveAll(stage)
		}
	}()
	if current != nil {
		st := current.Sys().(*syscall.Stat_t)
		if e = os.Chown(stage, int(st.Uid), int(st.Gid)); e != nil {
			return e
		}
	}
	r, e := http.NewRequest("GET", api+link, nil)
	if e != nil {
		return errors.New("invalid backup download URL")
	}
	r.Header.Set("Authorization", "Bearer "+credential)
	r.Header.Set("X-Node-ID", nodeID)
	res, e := (&http.Client{Timeout: 30 * time.Minute}).Do(r)
	if e != nil {
		return errors.New("S3 download transport failed (check agent S3 network access)")
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return fmt.Errorf("S3 GET: %s", res.Status)
	}
	if e = scanArchive(res.Body, stage); e != nil {
		return fmt.Errorf("restore archive verification failed: %w", e)
	}
	// Until this point an invalid/truncated archive leaves the original intact.
	if current == nil {
		if e = os.Rename(stage, root); e != nil {
			return e
		}
		if postSwap != nil {
			if e = postSwap(); e != nil {
				if rollbackErr := os.Rename(root, stage); rollbackErr != nil {
					cleanupStage = false
					return fmt.Errorf("restore failed: %v; rollback failed: %w", e, rollbackErr)
				}
				return e
			}
		}
		return nil
	}
	if e = exchangeDirs(parent, filepath.Base(root), filepath.Base(stage)); e != nil {
		return e
	}
	if postSwap != nil {
		if e = postSwap(); e != nil {
			if rollbackErr := exchangeDirs(parent, filepath.Base(root), filepath.Base(stage)); rollbackErr != nil {
				cleanupStage = false
				return fmt.Errorf("restore failed: %v; rollback failed: %w", e, rollbackErr)
			}
			return e
		}
	}
	return nil
}

// The legacy dispatcher calls restore after stopping the container and always
// starts it afterward. Keep the direct helper for that path and local tests.
func restore(root, link, id string) error { return restoreWithPostSwap(root, link, id, nil) }

// Wire this into the restore branch in main.go when that file can be edited.
// Unlike the legacy dispatcher, it preserves the original running/stopped
// state and rolls back the directory exchange if restarting the game fails.
func restoreWithLifecycle(root, link, id, name string) error {
	state, e := docker("inspect", "--format", "{{.State.Running}}", name)
	if e != nil {
		return e
	}
	if state != "true" && state != "false" {
		return errors.New("unknown container state")
	}
	wasRunning := state == "true"
	if wasRunning {
		if _, e = docker("stop", "-t", "30", name); e != nil {
			return e
		}
	}
	e = restoreWithPostSwap(root, link, id, func() error {
		if !wasRunning {
			return nil
		}
		_, startErr := docker("start", name)
		return startErr
	})
	if e != nil && wasRunning {
		if _, restartErr := docker("start", name); restartErr != nil {
			return fmt.Errorf("restore failed: %v; original container could not restart: %w", e, restartErr)
		}
	}
	return e
}

// Verification restores into a private scratch directory, reads all contents,
// validates archive paths and checksums, then removes the scratch data.
// It deliberately does not boot the game or modify the live server directory.
func verifyBackup(j *job) (interface{}, error) {
	link, e := value(j, "url")
	if e != nil {
		return nil, e
	}
	stage, e := os.MkdirTemp(dataRoot, ".verify-")
	if e != nil {
		return nil, e
	}
	defer os.RemoveAll(stage)
	r, e := http.NewRequest("GET", api+link, nil)
	if e != nil {
		return nil, e
	}
	r.Header.Set("Authorization", "Bearer "+credential)
	r.Header.Set("X-Node-ID", nodeID)
	res, e := (&http.Client{Timeout: 30 * time.Minute}).Do(r)
	if e != nil {
		return nil, e
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return nil, fmt.Errorf("backup download HTTP %d", res.StatusCode)
	}
	if e = scanArchive(res.Body, stage); e != nil {
		return nil, e
	}
	size, e := diskUsage(stage)
	if e != nil {
		return nil, e
	}
	return map[string]interface{}{"verified": true, "restoredBytes": size, "gameBooted": false}, nil
}
