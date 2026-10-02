package main

// Kernel-enforced per-server disk allowances.
//
// Each server's data directory is a sparse ext4 image (DATA_ROOT/.volumes/<id>.img)
// loop-mounted at DATA_ROOT/<id>. The image size is the allowance: when it is full
// the kernel answers ENOSPC to every writer — the game, SFTP and the panel alike.
// Space is allocated lazily (sparse), so unused allowance costs nothing up front.

import (
	"bufio"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
)

var (
	quotaMu    sync.Mutex
	quotaMode  = "auto" // auto | required | off — set from the panel
	supportErr error
	supportSet bool
)

func volumesDir() string         { return filepath.Join(dataRoot, ".volumes") }
func imagePath(id string) string { return filepath.Join(volumesDir(), id+".img") }
func setQuotaMode(mode string) {
	if mode != "auto" && mode != "required" && mode != "off" {
		return
	}
	quotaMu.Lock()
	quotaMode = mode
	quotaMu.Unlock()
}
func getQuotaMode() string {
	quotaMu.Lock()
	defer quotaMu.Unlock()
	return quotaMode
}

// quotaSupport reports whether this host can create loop-mounted volumes.
func quotaSupport() error {
	quotaMu.Lock()
	defer quotaMu.Unlock()
	if supportSet && supportErr == nil {
		return nil
	}
	supportSet = true
	supportErr = checkSupport()
	return supportErr
}
func checkSupport() error {
	if os.Geteuid() != 0 {
		return errors.New("the agent must run as root to mount volumes")
	}
	for _, tool := range []string{"mkfs.ext4", "losetup", "mount", "umount", "resize2fs", "e2fsck"} {
		if _, e := exec.LookPath(tool); e != nil {
			return fmt.Errorf("%s is not installed (package e2fsprogs / util-linux)", tool)
		}
	}
	if _, e := os.Stat("/dev/loop-control"); e != nil {
		return errors.New("loop devices are unavailable (/dev/loop-control missing)")
	}
	if e := os.MkdirAll(volumesDir(), 0700); e != nil {
		return e
	}
	return nil
}

// quotaActive says whether new servers should get a volume right now.
func quotaActive() (bool, error) {
	mode := getQuotaMode()
	if mode == "off" {
		return false, nil
	}
	if e := quotaSupport(); e != nil {
		if mode == "required" {
			return false, fmt.Errorf("disk limits are required but unavailable on this node: %w", e)
		}
		return false, nil
	}
	return true, nil
}

func quotaStatus() map[string]interface{} {
	mode := getQuotaMode()
	e := quotaSupport()
	st := map[string]interface{}{"mode": mode, "supported": e == nil, "enforced": e == nil && mode != "off"}
	if e != nil {
		st["reason"] = e.Error()
	} else if mode == "off" {
		st["reason"] = "Turned off in the panel"
	}
	return st
}

func run(name string, args ...string) (string, error) {
	out, e := exec.Command(name, args...).CombinedOutput()
	o := strings.TrimSpace(string(out))
	if e != nil {
		return o, fmt.Errorf("%s %s: %v: %s", name, args[0], e, o)
	}
	return o, nil
}

func isMounted(path string) bool {
	f, e := os.Open("/proc/self/mountinfo")
	if e != nil {
		return false
	}
	defer f.Close()
	clean := filepath.Clean(path)
	s := bufio.NewScanner(f)
	for s.Scan() {
		fields := strings.Fields(s.Text())
		if len(fields) > 4 && unescape(fields[4]) == clean {
			return true
		}
	}
	return false
}
func unescape(s string) string {
	return strings.NewReplacer(`\040`, " ", `\011`, "\t", `\012`, "\n", `\134`, `\`).Replace(s)
}

func hasVolume(id string) bool { _, e := os.Stat(imagePath(id)); return e == nil }

func mountVolume(img, target string) error {
	if e := os.MkdirAll(target, 0700); e != nil {
		return e
	}
	if isMounted(target) {
		return nil
	}
	_, e := run("mount", "-o", "loop,nodev,nosuid,noatime", "-t", "ext4", img, target)
	return e
}
func unmountVolume(target string) error {
	if !isMounted(target) {
		return nil
	}
	if _, e := run("umount", target); e != nil {
		if _, e2 := run("umount", "-l", target); e2 != nil {
			return e
		}
	}
	return nil
}
func makeImage(img string, mb int) error {
	if mb < 16 {
		return errors.New("disk allowance must be at least 16 MB")
	}
	if e := os.MkdirAll(filepath.Dir(img), 0700); e != nil {
		return e
	}
	f, e := os.OpenFile(img, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if e != nil {
		return e
	}
	if e = f.Truncate(int64(mb) << 20); e != nil {
		f.Close()
		os.Remove(img)
		return e
	}
	f.Close()
	// -m 0: no reserved blocks, the allowance is entirely usable by the game.
	if _, e = run("mkfs.ext4", "-q", "-F", "-m", "0", "-i", "32768", "-L", "fledge", img); e != nil {
		os.Remove(img)
		return e
	}
	return nil
}

// ensureVolume makes sure root is a mounted volume of mb megabytes. An existing
// plain directory (from before disk limits) is migrated in place. The caller must
// have stopped and removed the container: a running container keeps its old bind mount.
func ensureVolume(id string, mb int) error {
	root := filepath.Join(dataRoot, id)
	if isMounted(root) {
		return nil
	}
	img := imagePath(id)
	if hasVolume(id) {
		return mountVolume(img, root)
	}
	if e := os.MkdirAll(volumesDir(), 0700); e != nil {
		return e
	}
	tmp := img + ".new"
	os.Remove(tmp)
	if e := makeImage(tmp, mb); e != nil {
		return e
	}
	legacy := false
	if fi, e := os.Lstat(root); e == nil && fi.IsDir() {
		if entries, _ := os.ReadDir(root); len(entries) > 0 {
			legacy = true
		}
	}
	if legacy {
		stage := filepath.Join(dataRoot, ".migrate-"+id)
		if e := mountVolume(tmp, stage); e != nil {
			os.Remove(tmp)
			return e
		}
		if _, e := run("cp", "-a", root+"/.", stage+"/"); e != nil {
			unmountVolume(stage)
			os.Remove(tmp)
			os.Remove(stage)
			return fmt.Errorf("existing files do not fit in the %d MB allowance or could not be copied: %w", mb, e)
		}
		unmountVolume(stage)
		os.Remove(stage)
		if e := os.Rename(tmp, img); e != nil {
			return e
		}
		if e := os.RemoveAll(root); e != nil {
			return e
		}
	} else if e := os.Rename(tmp, img); e != nil {
		return e
	}
	return mountVolume(img, root)
}
func img2id(img string) string { return strings.TrimSuffix(filepath.Base(img), ".img") }

func loopDevice(img string) (string, error) {
	out, e := run("losetup", "-j", img, "-O", "NAME", "--noheadings")
	if e != nil {
		return "", e
	}
	dev := strings.Fields(out)
	if len(dev) == 0 {
		return "", errors.New("no loop device for volume")
	}
	return dev[0], nil
}

func volumeSizeMB(id string) (int, error) {
	fi, e := os.Stat(imagePath(id))
	if e != nil {
		return 0, e
	}
	return int(fi.Size() >> 20), nil
}

// volumeUsedBytes reads real filesystem usage (data plus metadata) from the kernel.
func volumeUsedBytes(root string) (used, total int64, ok bool) {
	if !isMounted(root) {
		return 0, 0, false
	}
	var st syscall.Statfs_t
	if syscall.Statfs(root, &st) != nil {
		return 0, 0, false
	}
	total = int64(st.Blocks) * int64(st.Bsize)
	used = total - int64(st.Bfree)*int64(st.Bsize)
	return used, total, true
}

// growOnline enlarges a mounted volume without stopping the game. Some kernels and
// sandboxes refuse online resizes (they need CAP_SYS_RESOURCE); callers then fall back
// to resizeOffline.
func growOnline(id string, mb int) error {
	img := imagePath(id)
	cur, e := volumeSizeMB(id)
	if e != nil {
		return e
	}
	if e = os.Truncate(img, int64(mb)<<20); e != nil {
		return e
	}
	dev, e := loopDevice(img)
	if e == nil {
		if _, e = run("losetup", "-c", dev); e == nil {
			_, e = run("resize2fs", dev)
		}
	}
	if e != nil {
		os.Truncate(img, int64(cur)<<20) // leave the image as it was
		syncLoopSize(img)
	}
	return e
}
func syncLoopSize(img string) {
	if dev, e := loopDevice(img); e == nil {
		run("losetup", "-c", dev)
	}
}

// resizeOffline grows or shrinks the filesystem with the volume unmounted, so the
// caller stops the container first.
func resizeOffline(id string, mb int) error {
	img, root := imagePath(id), filepath.Join(dataRoot, id)
	cur, e := volumeSizeMB(id)
	if e != nil {
		return e
	}
	if used, _, ok := volumeUsedBytes(root); ok && mb < cur && used+(16<<20) > int64(mb)<<20 {
		return fmt.Errorf("the server already uses %d MB; a %d MB allowance is too small", used>>20, mb)
	}
	if e = unmountVolume(root); e != nil {
		return e
	}
	fail := func(err error) error {
		if re := mountVolume(img, root); re != nil {
			return fmt.Errorf("%v; remounting failed: %w", err, re)
		}
		return err
	}
	if _, e = run("e2fsck", "-fy", img); e != nil && !strings.Contains(e.Error(), "exit status 1") {
		return fail(e)
	}
	if mb > cur {
		if e = os.Truncate(img, int64(mb)<<20); e != nil {
			return fail(e)
		}
		if _, e = run("resize2fs", img); e != nil {
			os.Truncate(img, int64(cur)<<20)
			return fail(e)
		}
	} else {
		if _, e = run("resize2fs", img, strconv.Itoa(mb)+"M"); e != nil {
			return fail(e)
		}
		if e = os.Truncate(img, int64(mb)<<20); e != nil {
			return fail(e)
		}
	}
	return mountVolume(img, root)
}

func destroyVolume(id string) error {
	root := filepath.Join(dataRoot, id)
	if e := unmountVolume(root); e != nil {
		return e
	}
	os.Remove(imagePath(id))
	os.Remove(imagePath(id) + ".new")
	os.Remove(imagePath(id) + ".old")
	return nil
}

// mountAllVolumes remounts every server volume (after reboot or agent restart).
func mountAllVolumes() {
	entries, e := os.ReadDir(volumesDir())
	if e != nil {
		return
	}
	for _, en := range entries {
		if !strings.HasSuffix(en.Name(), ".img") {
			continue
		}
		id := strings.TrimSuffix(en.Name(), ".img")
		if e := mountVolume(filepath.Join(volumesDir(), en.Name()), filepath.Join(dataRoot, id)); e != nil {
			log.Printf("volume %s: %v", id, e)
		}
	}
}

// restoreVolume swaps in a freshly built image: extract into a scratch volume of the
// same size, then exchange image files. The old image is kept until the swap succeeds.
func restoreVolume(id string, extract func(stage string) error, postSwap func() error) error {
	root, img := filepath.Join(dataRoot, id), imagePath(id)
	mb, e := volumeSizeMB(id)
	if e != nil {
		return e
	}
	fresh, old := img+".restore", img+".old"
	os.Remove(fresh)
	if e = makeImage(fresh, mb); e != nil {
		return e
	}
	stage := filepath.Join(dataRoot, ".restore-"+id)
	cleanup := func() { unmountVolume(stage); os.Remove(stage); os.Remove(fresh) }
	if e = mountVolume(fresh, stage); e != nil {
		cleanup()
		return e
	}
	if e = os.Chmod(stage, 0700); e == nil {
		e = extract(stage)
	}
	if e != nil {
		cleanup()
		return e
	}
	if e = unmountVolume(stage); e != nil {
		cleanup()
		return e
	}
	os.Remove(stage)
	if e = unmountVolume(root); e != nil {
		os.Remove(fresh)
		return e
	}
	os.Remove(old)
	if e = os.Rename(img, old); e != nil {
		mountVolume(img, root)
		os.Remove(fresh)
		return e
	}
	if e = os.Rename(fresh, img); e != nil {
		os.Rename(old, img)
		mountVolume(img, root)
		return e
	}
	if e = mountVolume(img, root); e == nil && postSwap != nil {
		e = postSwap()
	}
	if e != nil {
		unmountVolume(root)
		os.Rename(img, fresh)
		os.Rename(old, img)
		os.Remove(fresh)
		if re := mountVolume(img, root); re != nil {
			return fmt.Errorf("restore failed: %v; remounting the previous data failed: %w", e, re)
		}
		return e
	}
	os.Remove(old)
	return nil
}

// snapshotVolume takes a point-in-time copy of a running server's volume: the filesystem
// is frozen for the few moments it takes to copy the (sparse) image, then the copy is
// mounted read-only for archiving while the game keeps running.
func snapshotVolume(id string) (string, func(), error) {
	root, img := filepath.Join(dataRoot, id), imagePath(id)
	snap, stage := img+".snap", filepath.Join(dataRoot, ".snap-"+id)
	cleanup := func() { unmountVolume(stage); os.Remove(stage); os.Remove(snap) }
	cleanup()
	if _, e := run("fsfreeze", "-f", root); e != nil {
		return "", func() {}, e
	}
	_, copyErr := run("cp", "--sparse=always", "--reflink=auto", img, snap)
	if _, e := run("fsfreeze", "-u", root); e != nil {
		// A frozen volume would hang the game: try hard to thaw.
		if _, e2 := run("fsfreeze", "-u", root); e2 != nil {
			return "", cleanup, fmt.Errorf("could not thaw %s: %w", root, e2)
		}
	}
	if copyErr != nil {
		cleanup()
		return "", func() {}, copyErr
	}
	if e := os.MkdirAll(stage, 0700); e != nil {
		cleanup()
		return "", func() {}, e
	}
	if _, e := run("mount", "-o", "loop,ro,noload,nodev,nosuid", "-t", "ext4", snap, stage); e != nil {
		cleanup()
		return "", func() {}, e
	}
	return stage, cleanup, nil
}
