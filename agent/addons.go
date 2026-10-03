package main

// Add-on file jobs: `file.fetch` downloads a file straight from its source onto the node,
// `file.delete` removes files and `file.rename` toggles a `.disabled` suffix.
//
// A fetch only talks HTTPS, only to hosts the panel listed for the job, never to private or
// loopback addresses (checked on the address actually dialled, so DNS tricks do not help),
// and the result must match the checksum before it is placed in the server's data directory.

import (
	"context"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/hex"
	"errors"
	"fmt"
	"hash"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

const maxFetchBytes = 512 << 20

// fetchTesting lets unit tests talk to a local server. It is never set in production.
var fetchTesting struct {
	AllowPrivate bool
	AllowHTTP    bool
	Client       *http.Client
}

func privateIP(ip net.IP) bool {
	if ip == nil {
		return true
	}
	if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsMulticast() || ip.IsUnspecified() || ip.IsInterfaceLocalMulticast() {
		return true
	}
	if v4 := ip.To4(); v4 != nil {
		// 0.0.0.0/8, carrier-grade NAT 100.64.0.0/10 and the reserved 240.0.0.0/4 block.
		return v4[0] == 0 || (v4[0] == 100 && v4[1]&0xC0 == 64) || v4[0] >= 240
	}
	return false
}

func hostAllowed(host string, allowed []string) bool {
	host = strings.ToLower(host)
	for _, a := range allowed {
		a = strings.ToLower(strings.TrimSpace(a))
		if strings.HasPrefix(a, "*.") {
			if strings.HasSuffix(host, a[1:]) && len(host) > len(a)-1 {
				return true
			}
		} else if a != "" && host == a {
			return true
		}
	}
	return false
}

func fetchClient() *http.Client {
	if fetchTesting.Client != nil {
		return fetchTesting.Client
	}
	dialer := &net.Dialer{Timeout: 15 * time.Second, Control: func(network, address string, _ syscall.RawConn) error {
		host, _, err := net.SplitHostPort(address)
		if err != nil {
			return err
		}
		if privateIP(net.ParseIP(host)) {
			return fmt.Errorf("refusing to connect to a private or local address (%s)", host)
		}
		return nil
	}}
	return &http.Client{Timeout: 20 * time.Minute, Transport: &http.Transport{DialContext: dialer.DialContext, ForceAttemptHTTP2: true, TLSHandshakeTimeout: 15 * time.Second, DisableCompression: false, MaxIdleConns: 2}}
}

func stringList(v interface{}) []string {
	var out []string
	if list, ok := v.([]interface{}); ok {
		for _, x := range list {
			if s, ok := x.(string); ok {
				out = append(out, s)
			}
		}
	}
	return out
}

func numberValue(v interface{}) int64 {
	if f, ok := v.(float64); ok && f >= 0 {
		return int64(f)
	}
	return 0
}

// fetchFile implements the file.fetch job.
func fetchFile(j *job, root string, diskMB int64) (interface{}, error) {
	p, e := value(j, "path")
	if e != nil {
		return nil, e
	}
	rawURL, e := value(j, "url")
	if e != nil {
		return nil, e
	}
	if _, e = parts(p); e != nil {
		return nil, e
	}
	allowed := stringList(j.Payload["allowedHosts"])
	if len(allowed) == 0 {
		return nil, errors.New("no download hosts were allowed for this job")
	}
	wantSHA512, _ := j.Payload["sha512"].(string)
	wantSHA256, _ := j.Payload["sha256"].(string)
	wantSHA512, wantSHA256 = strings.ToLower(wantSHA512), strings.ToLower(wantSHA256)
	if len(wantSHA512) != 128 && len(wantSHA256) != 64 {
		return nil, errors.New("a SHA-512 or SHA-256 checksum is required")
	}
	limit := numberValue(j.Payload["maxBytes"])
	if limit <= 0 || limit > maxFetchBytes {
		limit = maxFetchBytes
	}
	expected := numberValue(j.Payload["size"])
	if expected > limit {
		return nil, fmt.Errorf("the file is larger than the allowed %d MB", limit>>20)
	}

	client := fetchClient()
	checked := *client
	checked.CheckRedirect = func(req *http.Request, via []*http.Request) error {
		if len(via) >= 4 {
			return errors.New("too many redirects")
		}
		return checkFetchURL(req.URL, allowed)
	}
	u, e := url.Parse(rawURL)
	if e != nil {
		return nil, errors.New("invalid download URL")
	}
	if e = checkFetchURL(u, allowed); e != nil {
		return nil, e
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Minute)
	defer cancel()
	req, e := http.NewRequestWithContext(ctx, "GET", u.String(), nil)
	if e != nil {
		return nil, e
	}
	req.Header.Set("User-Agent", "Fledge-agent/"+version)
	res, e := checked.Do(req)
	if e != nil {
		return nil, fmt.Errorf("download failed: %v", e)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return nil, fmt.Errorf("the download server answered %d", res.StatusCode)
	}
	if res.ContentLength > limit {
		return nil, fmt.Errorf("the file is larger than the allowed %d MB", limit>>20)
	}

	tmp, e := os.CreateTemp(dataRoot, ".fetch-"+sanitize(j.ID)+"-")
	if e != nil {
		return nil, e
	}
	defer os.Remove(tmp.Name())
	defer tmp.Close()
	var h hash.Hash
	if len(wantSHA512) == 128 {
		h = sha512.New()
	} else {
		h = sha256.New()
	}
	size, e := io.Copy(io.MultiWriter(tmp, h), io.LimitReader(res.Body, limit+1))
	if e != nil {
		return nil, fmt.Errorf("download interrupted: %v", e)
	}
	if size > limit {
		return nil, fmt.Errorf("the file is larger than the allowed %d MB", limit>>20)
	}
	if size == 0 {
		return nil, errors.New("the download was empty")
	}
	if expected > 0 && size != expected {
		return nil, fmt.Errorf("the file size (%d) does not match the expected size (%d)", size, expected)
	}
	got, want := hex.EncodeToString(h.Sum(nil)), wantSHA512
	if want == "" {
		want = wantSHA256
	}
	if got != want {
		return nil, errors.New("checksum mismatch: the downloaded file is not the one that was published; nothing was installed")
	}
	if e = checkWriteBudget(root, p, size, diskMB*1048576); e != nil {
		return nil, e
	}
	if _, e = tmp.Seek(0, 0); e != nil {
		return nil, e
	}
	if e = writeSafeStream(root, p, tmp, size); e != nil {
		return nil, e
	}
	result := map[string]interface{}{"ok": true, "sizeBytes": size}
	var replaceErrors []string
	for _, old := range stringList(j.Payload["replace"]) {
		if path.Clean(old) == path.Clean(p) {
			continue
		}
		if e := deleteSafe(root, old); e != nil && !errors.Is(e, syscall.ENOENT) {
			replaceErrors = append(replaceErrors, fmt.Sprintf("%s: %v", old, e))
		}
	}
	if len(replaceErrors) > 0 {
		result["replaceErrors"] = replaceErrors
	}
	return result, nil
}

func checkFetchURL(u *url.URL, allowed []string) error {
	if u.Scheme != "https" && !(fetchTesting.AllowHTTP && u.Scheme == "http") {
		return errors.New("only HTTPS downloads are allowed")
	}
	if u.User != nil {
		return errors.New("download URLs with credentials are not allowed")
	}
	if !hostAllowed(u.Hostname(), allowed) {
		return fmt.Errorf("%s is not an allowed download host", u.Hostname())
	}
	if port := u.Port(); port != "" && port != "443" && !fetchTesting.AllowPrivate {
		return errors.New("only the default HTTPS port is allowed")
	}
	if ip := net.ParseIP(u.Hostname()); ip != nil && privateIP(ip) && !fetchTesting.AllowPrivate {
		return errors.New("downloads from private or local addresses are not allowed")
	}
	return nil
}

// deleteSafe removes one file (never a directory, never through a symlink).
func deleteSafe(root, p string) error {
	segments, e := parts(p)
	if e != nil {
		return e
	}
	if len(segments) == 0 {
		return errors.New("cannot delete the data root")
	}
	d, e := dir(root, segments[:len(segments)-1], false)
	if e != nil {
		return e
	}
	defer d.Close()
	return syscall.Unlinkat(int(d.Fd()), segments[len(segments)-1])
}

func deleteFiles(j *job, root string) (interface{}, error) {
	paths := stringList(j.Payload["paths"])
	if len(paths) == 0 || len(paths) > 100 {
		return nil, errors.New("between 1 and 100 paths are required")
	}
	deleted := 0
	for _, p := range paths {
		if e := deleteSafe(root, p); e != nil {
			if errors.Is(e, syscall.ENOENT) {
				continue // already gone
			}
			return nil, fmt.Errorf("%s: %v", p, e)
		}
		deleted++
	}
	return map[string]interface{}{"ok": true, "deleted": deleted}, nil
}

// renameFile moves a file within its folder, only to add or drop the ".disabled" suffix.
func renameFile(j *job, root string) (interface{}, error) {
	from, e := value(j, "from")
	if e != nil {
		return nil, e
	}
	to, e := value(j, "to")
	if e != nil {
		return nil, e
	}
	if path.Dir(from) != path.Dir(to) || !(from+".disabled" == to || to+".disabled" == from) {
		return nil, errors.New("only enabling or disabling a file in place is allowed")
	}
	fs, e := parts(from)
	if e != nil {
		return nil, e
	}
	ts, e := parts(to)
	if e != nil {
		return nil, e
	}
	d, e := dir(root, fs[:len(fs)-1], false)
	if e != nil {
		return nil, e
	}
	defer d.Close()
	// RENAME_NOREPLACE: never overwrite an existing file.
	if e = unix.Renameat2(int(d.Fd()), fs[len(fs)-1], int(d.Fd()), ts[len(ts)-1], unix.RENAME_NOREPLACE); e != nil {
		if errors.Is(e, syscall.EEXIST) {
			return nil, errors.New("a file with the target name already exists")
		}
		return nil, e
	}
	return map[string]bool{"ok": true}, nil
}
