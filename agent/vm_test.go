package main

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"golang.org/x/sys/unix"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func testVM() *server {
	return &server{ID: "00000000-0000-4000-8000-000000000001", Runtime: "vm", MemoryMB: 512, CPUPercent: 100, DiskMB: 4096, VM: &vmConfig{Profile: vmProfile{VCPUs: 1, MemoryMB: 512, DiskMB: 1024, StorageMB: 4096, Firmware: "bios", DiskBus: "virtio", NICModel: "virtio", VNC: true, Serial: true}, Address: "10.90.0.10", MAC: "52:54:00:12:34:56", Hostname: "mews-guest", Network: vmNetwork{LibvirtName: "fledge-guests", Mode: "nat", Gateway: "10.90.0.1", Prefix: 24, DNS: []string{"1.1.1.1"}}, Disks: []vmDisk{{ID: "00000000-0000-4000-8000-000000000002", SizeMB: 1024}}}}
}
func TestVMIdentityAndHardware(t *testing.T) {
	s := testVM()
	if e := validateVM(s); e != nil {
		t.Fatal(e)
	}
	s.CPUPercent = 150
	if validateVM(s) == nil {
		t.Fatal("fractional vCPU accepted")
	}
	s.CPUPercent = 100
	s.VM.Disks = append(s.VM.Disks, s.VM.Disks[0])
	if validateVM(s) == nil {
		t.Fatal("duplicate disk identity accepted")
	}
}
func TestVMXML(t *testing.T) {
	s := testVM()
	text := vmDomainXML(s, "", "")
	decoder := xml.NewDecoder(strings.NewReader(text))
	for {
		_, e := decoder.Token()
		if e != nil {
			if e.Error() != "EOF" {
				t.Fatal(e)
			}
			break
		}
	}
	if !strings.Contains(text, "type='kvm'") || !strings.Contains(text, "managed='no'") || strings.Contains(text, "listen='0.0.0.0'") {
		t.Fatal("unsafe domain configuration")
	}
	original := dataRoot
	dataRoot = filepath.Join(t.TempDir(), "bad&<root")
	defer func() { dataRoot = original }()
	if !strings.Contains(vmDomainXML(s, "", ""), "&amp;") {
		t.Fatal("XML not escaped")
	}
}
func TestVMRejectExternalImage(t *testing.T) {
	h := make([]byte, 104)
	copy(h, []byte{'Q', 'F', 'I', 0xfb})
	binary.BigEndian.PutUint32(h[4:8], 3)
	binary.BigEndian.PutUint64(h[8:16], 104)
	p := filepath.Join(t.TempDir(), "backing.qcow2")
	os.WriteFile(p, h, 0600)
	if _, e := inspectVMImage(p, 1024); e == nil {
		t.Fatal("external backing file accepted")
	}
	binary.BigEndian.PutUint64(h[8:16], 0)
	binary.BigEndian.PutUint64(h[72:80], 4)
	os.WriteFile(p, h, 0600)
	if _, e := inspectVMImage(p, 1024); e == nil {
		t.Fatal("external data file accepted")
	}
}

// Opt-in integration uses actual libvirt/QEMU. A test-only virsh wrapper changes
// KVM to TCG on machines without /dev/kvm; production never has that fallback.
func TestVMRealGuest(t *testing.T) {
	root := os.Getenv("VM_GUEST_TEST_ROOT")
	if root == "" {
		t.Skip("requires disposable Linux guest test host")
	}
	dataRoot = root
	s := testVM()
	s.VM.Media = vmMedia{Kind: "iso", SHA256: os.Getenv("VM_GUEST_SHA256")}
	media := filepath.Join(root, ".vm-media", s.VM.Media.SHA256)
	st, e := os.Stat(media)
	if e != nil {
		t.Fatal(e)
	}
	s.VM.Media.SizeBytes = st.Size()
	if e = vmCreate(s); e != nil {
		t.Fatal(e)
	}
	if vmStopped(s.ID) {
		t.Fatal("guest did not start")
	}
	t.Log("real guest started; VNC and serial Unix sockets:", vmRoot(s.ID))
}

func TestVMGuestRecovery(t *testing.T) {
	root := os.Getenv("VM_GUEST_TEST_ROOT")
	if root == "" || os.Getenv("VM_GUEST_RECOVERY") != "true" {
		t.Skip("requires running disposable guest")
	}
	dataRoot = root
	s := testVM()
	b, e := os.ReadFile(filepath.Join(vmRoot(s.ID), "vm.json"))
	if e != nil {
		t.Fatal(e)
	}
	if e = json.Unmarshal(b, s); e != nil {
		t.Fatal(e)
	}
	if e = vmStop(s.ID); e != nil {
		t.Fatal("graceful shutdown:", e)
	}
	disk := filepath.Join(vmRoot(s.ID), "disks", s.VM.Disks[0].ID+".qcow2")
	check := func() {
		out, e := vmCommand("qemu-io", "-f", "qcow2", "-c", "read -v 65536 16", disk)
		if e != nil || !strings.Contains(out, "4d 65 77 73 2d 70 65 72 73 69 73 74 65 6e 63 65") {
			t.Fatalf("guest disk persistence: %s %v", out, e)
		}
	}
	check()
	j := &job{Server: s, Kind: "vm.snapshot.create", Payload: map[string]interface{}{"snapshotId": "00000000-0000-4000-8000-000000000003"}}
	if _, e = vmSnapshot(j); e != nil {
		t.Fatal(e)
	}
	if _, e = vmCommand("qemu-io", "-f", "qcow2", "-c", "write -P 0 65536 16", disk); e != nil {
		t.Fatal(e)
	}
	j.Kind = "vm.snapshot.restore"
	if _, e = vmSnapshot(j); e != nil {
		t.Fatal(e)
	}
	check()
	var archive []byte
	receiver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "PUT" {
			archive, _ = io.ReadAll(r.Body)
		} else {
			w.Write(archive)
		}
	}))
	defer receiver.Close()
	api = receiver.URL
	if _, e = backup(vmRoot(s.ID), "/backup", "guest-recovery"); e != nil {
		t.Fatal(e)
	}
	if _, e = vmCommand("qemu-io", "-f", "qcow2", "-c", "write -P 0 65536 16", disk); e != nil {
		t.Fatal(e)
	}
	if e = restoreWithPostSwap(vmRoot(s.ID), "/backup", "guest-recovery", func() error {
		inventory, e := vmSnapshotInventory(s)
		if e != nil {
			return e
		}
		if len(inventory) == 0 {
			return errors.New("backup lost snapshot inventory")
		}
		return defineVM(s)
	}); e != nil {
		t.Fatal(e)
	}
	check()
	if _, e = virsh("start", vmName(s.ID)); e != nil {
		t.Fatal(e)
	}
	t.Log("actual guest graceful shutdown, disk persistence, stopped snapshot and backup restore passed")
}
func TestVMConsoleBridge(t *testing.T) {
	path := os.Getenv("VM_GUEST_RELAY_FILE")
	if path == "" {
		t.Skip("requires documentation relay fixture")
	}
	var config struct{ API, NodeID, Credential string }
	b, e := os.ReadFile(path)
	if e != nil {
		t.Fatal(e)
	}
	if e = json.Unmarshal(b, &config); e != nil {
		t.Fatal(e)
	}
	api = config.API
	nodeID = config.NodeID
	credential = config.Credential
	dataRoot = "/var/lib/fledge/servers"
	go vmConsoleLoop()
	time.Sleep(30 * time.Minute)
}

func TestVMChangeRollback(t *testing.T) {
	if os.Getenv("VM_GUEST_CHANGE") != "true" {
		t.Skip("requires disposable guest")
	}
	dataRoot = os.Getenv("VM_GUEST_TEST_ROOT")
	var s server
	manifest := filepath.Join(vmRoot(testVM().ID), "vm.json")
	before, e := os.ReadFile(manifest)
	if e != nil {
		t.Fatal(e)
	}
	if e = json.Unmarshal(before, &s); e != nil {
		t.Fatal(e)
	}
	if e = vmStop(s.ID); e != nil {
		t.Fatal(e)
	}
	disk := filepath.Join(vmRoot(s.ID), "disks", s.VM.Disks[0].ID+".qcow2")
	original, e := vmCommand("qemu-img", "info", "--output=json", disk)
	if e != nil {
		t.Fatal(e)
	}
	e = vmChange(&s, func() error {
		if _, err := vmCommand("qemu-img", "resize", disk, "2048M"); err != nil {
			return err
		}
		return errors.New("injected domain-definition failure")
	})
	if e == nil || !strings.Contains(e.Error(), "injected") {
		t.Fatal("failed change was not rolled back:", e)
	}
	after, e := vmCommand("qemu-img", "info", "--output=json", disk)
	if e != nil {
		t.Fatal(e)
	}
	var a, b map[string]interface{}
	_ = json.Unmarshal([]byte(original), &a)
	_ = json.Unmarshal([]byte(after), &b)
	if a["virtual-size"] != b["virtual-size"] {
		t.Fatal("failed change retained irreversible disk growth")
	}
	current, e := os.ReadFile(manifest)
	if e != nil || string(current) != string(before) {
		t.Fatal("previous manifest not restored", e)
	}
	if _, e = virsh("start", vmName(s.ID)); e != nil {
		t.Fatal(e)
	}
}

func TestVMFirmwareRecovery(t *testing.T) {
	if os.Getenv("VM_GUEST_FIRMWARE") != "true" {
		t.Skip("requires disposable libvirt firmware environment")
	}
	dataRoot = os.Getenv("VM_GUEST_TEST_ROOT")
	s := testVM()
	s.ID = "00000000-0000-4000-8000-000000000020"
	s.VM.Address = "10.90.0.11"
	s.VM.MAC = "52:54:00:12:34:57"
	s.VM.Profile.Firmware = "uefi"
	s.VM.Profile.SecureBoot = true
	s.VM.Profile.TPM = true
	s.VM.Media = vmMedia{Kind: "iso", SHA256: os.Getenv("VM_GUEST_SHA256"), SizeBytes: 70254592}
	defer func() {
		_, _ = virsh("destroy", vmName(s.ID))
		_, _ = virsh("undefine", vmName(s.ID), "--nvram", "--keep-tpm")
		_ = os.RemoveAll(vmRoot(s.ID))
		table := "fledge_vm_" + strings.ReplaceAll(s.ID, "-", "")
		_, _ = vmCommand("nft", "delete", "table", "netdev", table)
		_, _ = vmCommand("nft", "delete", "table", "inet", table)
		_, _ = vmCommand("ip", "link", "delete", vmTap(s.ID))
	}()
	if e := vmCreate(s); e != nil {
		t.Fatal("UEFI/TPM boot:", e)
	}
	time.Sleep(5 * time.Second)
	if _, e := virsh("destroy", vmName(s.ID)); e != nil {
		t.Fatal(e)
	}
	digest := func() map[string][32]byte {
		result := map[string][32]byte{}
		for _, name := range []string{"nvram.fd", "tpm"} {
			root := filepath.Join(vmRoot(s.ID), name)
			if !exists(root) {
				t.Fatal("missing firmware/TPM state", name)
			}
			if e := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
				if err != nil {
					return err
				}
				if info.Mode().IsRegular() {
					b, e := os.ReadFile(path)
					if e != nil {
						return e
					}
					relative, _ := filepath.Rel(vmRoot(s.ID), path)
					result[relative] = sha256.Sum256(b)
				}
				return nil
			}); e != nil {
				t.Fatal(e)
			}
		}
		if len(result) < 2 {
			t.Fatal("TPM state was not persisted")
		}
		return result
	}
	before := digest()
	j := &job{Server: s, Kind: "vm.snapshot.create", Payload: map[string]interface{}{"snapshotId": "00000000-0000-4000-8000-000000000021"}}
	if _, e := vmSnapshot(j); e != nil {
		t.Fatal(e)
	}
	if e := os.WriteFile(filepath.Join(vmRoot(s.ID), "nvram.fd"), []byte("damaged"), 0600); e != nil {
		t.Fatal(e)
	}
	j.Kind = "vm.snapshot.restore"
	if _, e := vmSnapshot(j); e != nil {
		t.Fatal(e)
	}
	after := digest()
	if len(before) != len(after) {
		t.Fatal("firmware state set changed")
	}
	for path, hash := range before {
		if after[path] != hash {
			t.Fatal("firmware/TPM restore mismatch", path)
		}
	}
	if _, e := virsh("start", vmName(s.ID)); e != nil {
		t.Fatal("restored firmware/TPM failed to start", e)
	}
	t.Log("real UEFI, Secure Boot firmware and swtpm state started and restored together; guest OS trust/PCR behavior is a separate hardware acceptance test")
}

// This test uses the same managed tap and kernel ingress path as QEMU.
func TestVMNativeNetwork(t *testing.T) {
	if os.Getenv("VM_GUEST_TEST_ROOT") == "" {
		t.Skip("requires disposable Linux network namespace")
	}
	if e := vmIsolationProbe(); e != nil {
		t.Fatal(e)
	}
	if e := vmIsolationProbe(); e != nil {
		t.Fatal("native ingress capability:", e)
	}
	for _, ipv6 := range []bool{false, true} {
		s := testVM()
		s.ID = "00000000-0000-4000-8000-000000000004"
		s.VM.Address = "10.90.0.11"
		if ipv6 {
			s.VM.Address = "fd00:90::11"
			s.VM.Network.Gateway = "fd00:90::1"
			s.VM.Network.Prefix = 64
		}
		if e := vmPrepareNetwork(s); e != nil {
			t.Fatal("prepare network:", e)
		}
		table := "fledge_vm_" + strings.ReplaceAll(s.ID, "-", "")
		cleanup := func() {
			vmCommand("nft", "delete", "table", "inet", table)
			vmCommand("nft", "delete", "table", "netdev", table)
			vmCommand("ip", "link", "delete", vmTap(s.ID))
		}
		fd, e := unix.Open("/dev/net/tun", unix.O_RDWR|unix.O_NONBLOCK, 0)
		if e != nil {
			cleanup()
			t.Fatal(e)
		}
		request, _ := unix.NewIfreq(vmTap(s.ID))
		request.SetUint16(unix.IFF_TAP | unix.IFF_NO_PI)
		if e = unix.IoctlIfreq(fd, unix.TUNSETIFF, request); e != nil {
			unix.Close(fd)
			cleanup()
			t.Fatal(e)
		}
		// A frame with another workload's MAC must be counted and dropped.
		mac, _ := net.ParseMAC("52:54:00:ff:ff:ff")
		frame := make([]byte, 60)
		copy(frame[:6], []byte{255, 255, 255, 255, 255, 255})
		copy(frame[6:12], mac)
		frame[12] = 8
		frame[13] = 6
		if _, e = unix.Write(fd, frame); e != nil {
			unix.Close(fd)
			cleanup()
			t.Fatal(e)
		}
		// A permitted Ethernet identity still cannot advertise another IP.
		allowed, _ := net.ParseMAC(s.VM.MAC)
		if !ipv6 {
			copy(frame[6:12], allowed)
			copy(frame[14:22], []byte{0, 1, 8, 0, 6, 4, 0, 1})
			copy(frame[22:28], allowed)
			copy(frame[28:32], net.ParseIP("10.90.0.250").To4())
			copy(frame[38:42], net.ParseIP(s.VM.Network.Gateway).To4())
		} else {
			frame = make([]byte, 14+40+24)
			copy(frame[:6], []byte{0x33, 0x33, 0, 0, 0, 1})
			copy(frame[6:12], allowed)
			frame[12] = 0x86
			frame[13] = 0xdd
			frame[14] = 0x60
			frame[19] = 24
			frame[20] = 58
			frame[21] = 255
			copy(frame[22:38], net.ParseIP(s.VM.Address).To16())
			copy(frame[38:54], net.ParseIP("ff02::1").To16())
			frame[54] = 136
			copy(frame[62:78], net.ParseIP(s.VM.Network.Gateway).To16())
		}
		if _, e = unix.Write(fd, frame); e != nil {
			unix.Close(fd)
			cleanup()
			t.Fatal(e)
		}
		time.Sleep(100 * time.Millisecond)
		out, e := vmCommand("nft", "list", "table", "netdev", table)
		unix.Close(fd)
		cleanup()
		if e != nil || !strings.Contains(out, "counter packets 1 bytes 46") {
			t.Fatal("spoofed frame was not dropped:", out, e)
		}
		if strings.Count(out, "counter packets 1 bytes") < 2 {
			t.Fatal("spoofed IP was not dropped:", out)
		}
		t.Log(fmt.Sprintf("native %s ingress rejected spoofed Ethernet identity", map[bool]string{false: "IPv4", true: "IPv6"}[ipv6]))
	}
}

func TestVMFreshAuthorization(t *testing.T) {
	oldAPI, oldNode, oldCredential := api, nodeID, credential
	defer func() { api, nodeID, credential = oldAPI, oldNode, oldCredential }()
	s := testVM()
	nodeID, credential = "test-node", "test-credential"
	allowed := true
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer test-credential" || r.Header.Get("X-Node-ID") != "test-node" {
			http.Error(w, "missing node authentication", 401)
			return
		}
		if r.URL.Path != "/api/agent/servers/"+s.ID+"/vm-authorization" || r.URL.Query().Get("jobId") != "active-lease" || r.URL.Query().Get("attempt") != "2" {
			http.Error(w, "missing lease identity", 400)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"allowed": allowed, "desiredStatus": "stopped"})
	}))
	defer srv.Close()
	api = srv.URL
	vmActiveJobs.Store(s.ID, &job{ID: "active-lease", Attempt: 2})
	defer vmActiveJobs.Delete(s.ID)
	desired, e := vmAuthorization(s)
	if e != nil || desired != "stopped" {
		t.Fatalf("authenticated decision: %q %v", desired, e)
	}
	allowed = false
	if _, e = vmAuthorization(s); e == nil {
		t.Fatal("revoked operation was authorized")
	}
	if e = vmStart(s); e == nil {
		t.Fatal("revoked operation reached domain start")
	}
}

func TestVMPartialProvisioningCleanup(t *testing.T) {
	if os.Getenv("VM_GUEST_TEST_ROOT") == "" {
		t.Skip("isolated Linux guest host required")
	}
	oldRoot := dataRoot
	defer func() { dataRoot = oldRoot }()
	dataRoot = os.Getenv("VM_GUEST_TEST_ROOT")
	s := testVM()
	s.ID = "00000000-0000-4000-8000-000000000031"
	s.VM.Media = vmMedia{Kind: "iso", SHA256: strings.Repeat("f", 64), URL: "http://127.0.0.1/invalid.iso"}
	if e := vmCreate(s); e == nil {
		t.Fatal("unapproved media provisioned")
	}
	if !exists(vmRoot(s.ID)) {
		t.Fatal("test did not exercise partial storage")
	}
	if e := vmCleanupUnprovisioned(s); e != nil {
		t.Fatal(e)
	}
	if exists(vmRoot(s.ID)) {
		t.Fatal("partial storage was retained")
	}
	active := testVM()
	if !vmStopped(active.ID) && vmCleanupUnprovisioned(active) == nil {
		t.Fatal("cleanup accepted a running guest")
	}
}

func TestVMSecureBootXML(t *testing.T) {
	s := testVM()
	s.VM.Profile.Firmware = "uefi"
	s.VM.Profile.SecureBoot = true
	xml := vmDomainXML(s, "", "")
	if !strings.Contains(xml, "name='enrolled-keys'") || !strings.Contains(xml, "OVMF_VARS_4M.ms.fd") {
		t.Fatal("Secure Boot omitted enrolled-key template")
	}
}
