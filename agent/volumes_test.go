package main

import (
	"errors"
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

// Needs root, loop devices and e2fsprogs; skipped elsewhere.
func TestVolumeEnforcesAllowanceInKernel(t *testing.T) {
	prior := dataRoot
	dataRoot = t.TempDir()
	defer func() { dataRoot = prior }()
	if e := checkSupport(); e != nil {
		t.Skipf("volumes unsupported here: %v", e)
	}
	id := "11111111-2222-3333-4444-555555555555"
	if e := ensureVolume(id, 32); e != nil {
		t.Skipf("cannot mount here: %v", e)
	}
	defer destroyVolume(id)
	root := filepath.Join(dataRoot, id)
	if !isMounted(root) {
		t.Fatal("volume should be mounted")
	}
	f, e := os.Create(filepath.Join(root, "big"))
	if e != nil {
		t.Fatal(e)
	}
	defer f.Close()
	chunk := make([]byte, 1<<20)
	var werr error
	for i := 0; i < 64 && werr == nil; i++ {
		_, werr = f.Write(chunk)
	}
	if !errors.Is(werr, syscall.ENOSPC) {
		t.Fatalf("writing past the allowance must fail with ENOSPC, got %v", werr)
	}
	if used, total, ok := volumeUsedBytes(root); !ok || total > 32<<20 || used == 0 {
		t.Fatalf("usage should be read from the kernel: used=%d total=%d ok=%v", used, total, ok)
	}
}
