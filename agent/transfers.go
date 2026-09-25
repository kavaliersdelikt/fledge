package main

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

// Streams payloads via the authenticated object relay. No file-sized buffers.
func streamFile(j *job, root string) (interface{}, error) {
	p, err := value(j, "path")
	if err != nil {
		return nil, err
	}
	link, err := value(j, "url")
	if err != nil {
		return nil, err
	}
	method := "GET"
	var body io.Reader
	var size int64
	if j.Kind == "file.export" {
		method = "PUT"
		f, e := openSafe(root, p)
		if e != nil {
			return nil, e
		}
		defer f.Close()
		st, e := f.Stat()
		if e != nil {
			return nil, e
		}
		if !st.Mode().IsRegular() || st.Size() > 1<<30 {
			return nil, errors.New("download requires a regular file up to 1 GiB")
		}
		size = st.Size()
		body = f
	}
	r, err := http.NewRequest(method, api+link, body)
	if err != nil {
		return nil, err
	}
	if method == "PUT" {
		r.ContentLength = size
		r.Header.Set("Content-Type", "application/octet-stream")
	}
	r.Header.Set("Authorization", "Bearer "+credential)
	r.Header.Set("X-Node-ID", nodeID)
	res, err := (&http.Client{Timeout: 30 * time.Minute}).Do(r)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, fmt.Errorf("file transfer: HTTP %d", res.StatusCode)
	}
	if method == "GET" {
		size = res.ContentLength
		if size < 0 || size > 1<<30 {
			return nil, errors.New("upload requires a valid size up to 1 GiB")
		}
		if err = checkWriteBudget(root, p, size, int64(j.Server.DiskMB)*1048576); err != nil {
			return nil, err
		}
		if err = writeSafeStream(root, p, res.Body, size); err != nil {
			return nil, err
		}
	}
	return map[string]interface{}{"ok": true, "sizeBytes": size}, nil
}

// Logical usage never follows symlinks. This is a management-write guard, not
// a filesystem quota: an independently writing game can still grow its files.
func diskUsage(root string) (int64, error) {
	var total int64
	err := filepath.Walk(root, func(p string, info os.FileInfo, e error) error {
		if e != nil {
			return e
		}
		if info.Mode().IsRegular() {
			total += info.Size()
		}
		return nil
	})
	return total, err
}
func checkWriteBudget(root, p string, size, budget int64) error {
	used, e := diskUsage(root)
	if e != nil {
		return e
	}
	if f, e := openSafe(root, p); e == nil {
		if st, e := f.Stat(); e == nil {
			used -= st.Size()
		}
		f.Close()
	}
	if budget <= 0 || size > budget-used {
		return errors.New("server disk allowance would be exceeded")
	}
	return nil
}
