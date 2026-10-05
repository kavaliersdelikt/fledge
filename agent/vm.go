package main

// The VM runtime uses libvirt's system connection. All paths and XML originate here,
// never from guest input. Docker remains the default runtime.
import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"golang.org/x/crypto/bcrypt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

type vmMedia struct {
	ID, Name, Kind, URL, SHA256, OS string
	SizeBytes                       int64 `json:"size_bytes"`
}
type vmDisk struct {
	ID     string `json:"id"`
	SizeMB int    `json:"sizeMb"`
}
type vmProfile struct {
	VCPUs      int    `json:"vcpus"`
	MemoryMB   int    `json:"memoryMb"`
	DiskMB     int    `json:"diskMb"`
	StorageMB  int    `json:"storageMb"`
	Firmware   string `json:"firmware"`
	BootOrder  string `json:"bootOrder"`
	SecureBoot bool   `json:"secureBoot"`
	TPM        bool   `json:"tpm"`
	DiskBus    string `json:"diskBus"`
	NICModel   string `json:"nicModel"`
	VNC        bool   `json:"vnc"`
	Serial     bool   `json:"serial"`
}
type vmNetwork struct {
	ID, Name, Mode string
	LibvirtName    string `json:"libvirt_name"`
	Gateway        string
	Prefix         int
	DNS            []string
}
type vmConfig struct {
	Profile  vmProfile `json:"profile"`
	Media    vmMedia   `json:"media"`
	Driver   *vmMedia  `json:"driver"`
	Network  vmNetwork `json:"network"`
	Address  string    `json:"address"`
	MAC      string    `json:"mac"`
	Hostname string    `json:"hostname"`
	SSHKeys  []string  `json:"sshKeys"`
	Password string    `json:"password,omitempty"`
	Disks    []vmDisk  `json:"disks"`
	Forwards []struct {
		Protocol  string `json:"protocol"`
		HostPort  int    `json:"hostPort"`
		GuestPort int    `json:"guestPort"`
	} `json:"forwards"`
}

var vmLocks sync.Map
var vmCPU sync.Map
var vmProbeLock sync.Mutex
var vmActiveJobs sync.Map

type vmCPUReading struct {
	total int64
	at    time.Time
}

func vmLock(id string) func() {
	v, _ := vmLocks.LoadOrStore(id, &sync.Mutex{})
	m := v.(*sync.Mutex)
	m.Lock()
	return m.Unlock
}
func vmCommand(name string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()
	command := exec.CommandContext(ctx, name, args...)
	command.Env = append(os.Environ(), "LC_ALL=C")
	b, e := command.CombinedOutput()
	if e != nil {
		return "", fmt.Errorf("%s failed: %.500s", name, b)
	}
	return strings.TrimSpace(string(b)), nil
}
func virsh(args ...string) (string, error) {
	return vmCommand("virsh", append([]string{"--connect", "qemu:///system"}, args...)...)
}
func vmName(id string) string { return "fledge-vm-" + id }
func vmRoot(id string) string { return filepath.Join(dataRoot, id) }
func vmX(s string) string     { var b bytes.Buffer; _ = xml.EscapeText(&b, []byte(s)); return b.String() }
func exists(p string) bool    { _, e := os.Stat(p); return e == nil }
var vmCapabilityCache struct {
	sync.Mutex
	checked time.Time
	value   map[string]interface{}
}

func vmCapabilities() map[string]interface{} {
	vmCapabilityCache.Lock()
	defer vmCapabilityCache.Unlock()
	if vmCapabilityCache.value != nil && time.Since(vmCapabilityCache.checked) < time.Minute {
		return vmCapabilityCache.value
	}
	vmCapabilityCache.value = discoverVMCapabilities()
	vmCapabilityCache.checked = time.Now()
	return vmCapabilityCache.value
}

func discoverVMCapabilities() map[string]interface{} {
	kvm := false
	if f, e := os.OpenFile("/dev/kvm", os.O_RDWR, 0); e == nil {
		kvm = true
		f.Close()
	}
	variables := exists(env("VM_UEFI_VARS", "/usr/share/OVMF/OVMF_VARS_4M.fd"))
	out := map[string]interface{}{"enabled": false, "kvm": kvm, "arch": runtime.GOARCH, "libvirt": false, "uefi": variables && exists(env("VM_UEFI_CODE", "/usr/share/OVMF/OVMF_CODE_4M.fd")), "secureBoot": exists(env("VM_UEFI_SECURE_VARS", "/usr/share/OVMF/OVMF_VARS_4M.ms.fd")) && exists(env("VM_UEFI_SECURE_CODE", "/usr/share/OVMF/OVMF_CODE_4M.ms.fd")), "tpm": false, "nft": false, "isolation": false, "networks": []string{}}
	if !kvm || runtime.GOARCH != "amd64" {
		return out
	}
	_, tpmErr := exec.LookPath("swtpm")
	_, setupErr := exec.LookPath("swtpm_setup")
	_, accountErr := user.Lookup(env("VM_TPM_USER", "tss"))
	tpmReady := tpmErr == nil && setupErr == nil && accountErr == nil
	out["tpm"] = tpmReady
	_, nftErr := exec.LookPath("nft")
	out["nft"] = nftErr == nil
	_, nftProbe := vmCommand("nft", "list", "tables")
	bridgeProbe := vmIsolationProbe()
	out["isolation"] = nftProbe == nil && bridgeProbe == nil
	if version, e := virsh("version"); e == nil {
		for _, line := range strings.Split(version, "\n") {
			if strings.HasPrefix(line, "Using library:") {
				fields := strings.Fields(line)
				if len(fields) > 0 {
					parts := strings.Split(fields[len(fields)-1], ".")
					major, _ := strconv.Atoi(parts[0])
					minor := 0
					if len(parts) > 1 {
						minor, _ = strconv.Atoi(parts[1])
					}
					out["tpm"] = tpmReady && (major > 10 || major == 10 && minor >= 10)
				}
			}
		}
		out["libvirt"] = true
		if names, e := virsh("net-list", "--name"); e == nil {
			out["networks"] = strings.Fields(names)
		}
	}
	tools := []string{}
	for _, name := range []string{"qemu-img", "genisoimage", "setfacl", "ip", "bridge"} {
		if _, e := exec.LookPath(name); e != nil {
			tools = append(tools, name)
		}
	}
	out["missingTools"] = tools
	if len(tools) > 0 {
		out["libvirt"] = false
	}
	out["enabled"] = kvm && out["libvirt"] == true && out["nft"] == true && out["isolation"] == true && len(tools) == 0
	return out
}
func validateVM(s *server) error {
	if !uuidName.MatchString(s.ID) || s.VM == nil {
		return errors.New("invalid VM identity")
	}
	v := s.VM
	p := v.Profile
	if s.CPUPercent < 100 || s.CPUPercent%100 != 0 || s.CPUPercent > p.VCPUs*100 || s.MemoryMB < 256 || s.MemoryMB > p.MemoryMB || s.DiskMB > p.StorageMB {
		return errors.New("VM exceeds hardware profile")
	}
	if p.Firmware != "bios" && p.Firmware != "uefi" || p.DiskBus != "virtio" && p.DiskBus != "sata" || p.NICModel != "virtio" && p.NICModel != "e1000" {
		return errors.New("invalid virtual hardware")
	}
	if len(v.Disks) == 0 || len(v.Disks) > 8 || net.ParseIP(v.Address) == nil || len(v.MAC) != 17 || !strings.HasPrefix(v.MAC, "52:54:00:") {
		return errors.New("invalid disk or network configuration")
	}
	if mac, e := net.ParseMAC(v.MAC); e != nil || len(mac) != 6 {
		return errors.New("invalid MAC address")
	}
	used := 0
	seen := map[string]bool{}
	for _, d := range v.Disks {
		if !uuidName.MatchString(d.ID) || d.SizeMB < 1024 || seen[d.ID] {
			return errors.New("invalid disk")
		}
		seen[d.ID] = true
		used += d.SizeMB
	}
	if used > s.DiskMB {
		return errors.New("disk allowance exceeded")
	}
	return nil
}

// Reject backing files and external data files before invoking qemu-img, which
// otherwise may open administrator-supplied paths embedded in an image header.
func inspectVMImage(path string, maxMB int) (string, error) {
	f, e := os.Open(path)
	if e != nil {
		return "", e
	}
	h := make([]byte, 104)
	n, e := f.Read(h)
	f.Close()
	if e != nil && e != io.EOF {
		return "", e
	}
	format := "raw"
	if n >= 72 && bytes.Equal(h[:4], []byte{'Q', 'F', 'I', 0xfb}) {
		format = "qcow2"
		version := binary.BigEndian.Uint32(h[4:8])
		if version != 2 && version != 3 || binary.BigEndian.Uint64(h[8:16]) != 0 || binary.BigEndian.Uint32(h[16:20]) != 0 {
			return "", errors.New("images with backing files are refused")
		}
		if version == 3 && (n < 104 || binary.BigEndian.Uint64(h[72:80])&^uint64(1) != 0) {
			return "", errors.New("external or unsupported qcow2 features are refused")
		}
	}
	out, e := vmCommand("qemu-img", "info", "--output=json", "-f", format, path)
	if e != nil {
		return "", e
	}
	var info struct {
		VirtualSize int64  `json:"virtual-size"`
		Backing     string `json:"backing-filename"`
		Format      string `json:"format"`
	}
	if e = json.Unmarshal([]byte(out), &info); e != nil {
		return "", e
	}
	if info.Backing != "" || info.VirtualSize < 1 || info.VirtualSize > int64(maxMB)*1048576 {
		return "", errors.New("image exceeds disk size or has a backing file")
	}
	return format, nil
}
func inspectVMISO(path string) error {
	f, e := os.Open(path)
	if e != nil {
		return e
	}
	defer f.Close()
	b := make([]byte, 2048*16)
	n, e := f.ReadAt(b, 32768)
	if e != nil && e != io.EOF {
		return e
	}
	for at := 1; at+5 <= n; at += 2048 {
		signature := string(b[at : at+5])
		if signature == "CD001" || signature == "NSR02" || signature == "NSR03" {
			return nil
		}
	}
	return errors.New("media is not an ISO9660 or UDF installation image")
}
func publicVMIP(ip net.IP) bool {
	if ip == nil || !ip.IsGlobalUnicast() || ip.IsPrivate() {
		return false
	}
	for _, cidr := range []string{"0.0.0.0/8", "100.64.0.0/10", "192.0.0.0/24", "192.0.2.0/24", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "240.0.0.0/4", "64:ff9b::/96", "64:ff9b:1::/48", "2001:db8::/32"} {
		_, network, _ := net.ParseCIDR(cidr)
		if network.Contains(ip) {
			return false
		}
	}
	return true
}
func cacheVMMedia(m vmMedia) (string, error) {
	if len(m.SHA256) != 64 || m.SizeBytes < 1 || m.SizeBytes > 32<<30 {
		return "", errors.New("invalid media metadata")
	}
	if _, e := hex.DecodeString(m.SHA256); e != nil {
		return "", errors.New("invalid checksum")
	}
	dir := filepath.Join(dataRoot, ".vm-media")
	if e := os.MkdirAll(dir, 0755); e != nil {
		return "", e
	}
	target := filepath.Join(dir, m.SHA256)
	unlock := vmLock(m.SHA256)
	defer unlock()
	if exists(target) {
		return target, nil
	}
	u, e := url.Parse(m.URL)
	if e != nil || u.Scheme != "https" || u.User != nil {
		return "", errors.New("media URL must be HTTPS")
	}
	transport := &http.Transport{Proxy: nil, DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
		host, port, e := net.SplitHostPort(addr)
		if e != nil {
			return nil, e
		}
		ips, e := net.DefaultResolver.LookupIPAddr(ctx, host)
		if e != nil {
			return nil, e
		}
		if len(ips) == 0 {
			return nil, errors.New("media hostname has no addresses")
		}
		for _, a := range ips {
			if !publicVMIP(a.IP) {
				return nil, errors.New("private media sources are refused")
			}
		}
		return (&net.Dialer{Timeout: 15 * time.Second}).DialContext(ctx, network, net.JoinHostPort(ips[0].IP.String(), port))
	}}
	client := &http.Client{Transport: transport, Timeout: 30 * time.Minute, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return errors.New("use a direct media download URL") }}
	defer transport.CloseIdleConnections()
	res, e := client.Get(m.URL)
	if e != nil {
		return "", errors.New("media download failed")
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return "", fmt.Errorf("media download: HTTP %d", res.StatusCode)
	}
	if res.ContentLength > m.SizeBytes {
		return "", errors.New("media exceeds declared size")
	}
	f, e := os.CreateTemp(dir, ".download-")
	if e != nil {
		return "", e
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	digest := sha256.New()
	n, e := io.Copy(io.MultiWriter(f, digest), io.LimitReader(res.Body, m.SizeBytes+1))
	ce := f.Close()
	if e != nil {
		return "", e
	}
	if ce != nil {
		return "", ce
	}
	if n != m.SizeBytes || hex.EncodeToString(digest.Sum(nil)) != m.SHA256 {
		return "", errors.New("media size or checksum mismatch")
	}
	if e = os.Chmod(tmp, 0644); e != nil {
		return "", e
	}
	return target, os.Rename(tmp, target)
}
func vmACL(root string) error {
	user := env("VM_QEMU_USER", "libvirt-qemu")
	if strings.ContainsAny(user, ":,\r\n") {
		return errors.New("invalid QEMU user")
	}
	// Data roots are private by default; grant traversal, never directory listing.
	if _, e := vmCommand("setfacl", "-m", "u:"+user+":--x", dataRoot); e != nil {
		return e
	}
	_, e := vmCommand("setfacl", "-R", "-m", "u:"+user+":rwX", root)
	return e
}
func vmSeed(s *server) error {
	v := s.VM
	dir := filepath.Join(vmRoot(s.ID), "seed")
	if e := os.MkdirAll(dir, 0700); e != nil {
		return e
	}
	defer os.RemoveAll(dir)
	user := map[string]interface{}{"hostname": v.Hostname, "manage_etc_hosts": true, "ssh_pwauth": v.Password != "", "users": []interface{}{map[string]interface{}{"name": "fledge", "sudo": "ALL=(ALL) NOPASSWD:ALL", "shell": "/bin/bash", "lock_passwd": v.Password == "", "ssh_authorized_keys": v.SSHKeys}}}
	if v.Password != "" {
		passwordHash, e := bcrypt.GenerateFromPassword([]byte(v.Password), 12)
		if e != nil {
			return errors.New("invalid provisioning password")
		}
		user["chpasswd"] = map[string]interface{}{"expire": true, "users": []interface{}{map[string]interface{}{"name": "fledge", "password": string(passwordHash), "type": "hash"}}}
	}
	routes := []interface{}{map[string]interface{}{"to": "default", "via": strings.Split(v.Network.Gateway, "/")[0]}}
	network := map[string]interface{}{"version": 2, "ethernets": map[string]interface{}{"primary": map[string]interface{}{"match": map[string]string{"macaddress": v.MAC}, "addresses": []string{fmt.Sprintf("%s/%d", v.Address, v.Network.Prefix)}, "routes": routes, "nameservers": map[string]interface{}{"addresses": v.Network.DNS}}}}
	for name, body := range map[string]interface{}{"user-data": user, "meta-data": map[string]string{"instance-id": s.ID, "local-hostname": v.Hostname}, "network-config": network} {
		b, e := json.Marshal(body)
		if e != nil {
			return e
		}
		if name == "user-data" {
			b = append([]byte("#cloud-config\n"), b...)
		}
		if e = os.WriteFile(filepath.Join(dir, name), b, 0600); e != nil {
			return e
		}
	}
	_, e := vmCommand("genisoimage", "-quiet", "-output", filepath.Join(vmRoot(s.ID), "seed.iso"), "-volid", "cidata", "-joliet", "-rock", filepath.Join(dir, "user-data"), filepath.Join(dir, "meta-data"), filepath.Join(dir, "network-config"))
	return e
}
func vmDomainXML(s *server, bootISO, driverISO string) string {
	v := s.VM
	p := v.Profile
	root := vmRoot(s.ID)
	var b strings.Builder
	fmt.Fprintf(&b, "<domain type='kvm'><name>%s</name><uuid>%s</uuid><memory unit='MiB'>%d</memory><vcpu>%d</vcpu><os", vmName(s.ID), s.ID, s.MemoryMB, s.CPUPercent/100)
	if p.Firmware == "uefi" {
		b.WriteString(" firmware='efi'")
	}
	b.WriteString("><type arch='x86_64' machine='q35'>hvm</type>")
	if p.Firmware == "uefi" {
		code := env("VM_UEFI_CODE", "/usr/share/OVMF/OVMF_CODE_4M.fd")
		variables := env("VM_UEFI_VARS", "/usr/share/OVMF/OVMF_VARS_4M.fd")
		if p.SecureBoot {
			code = env("VM_UEFI_SECURE_CODE", "/usr/share/OVMF/OVMF_CODE_4M.ms.fd")
			variables = env("VM_UEFI_SECURE_VARS", "/usr/share/OVMF/OVMF_VARS_4M.ms.fd")
			b.WriteString("<firmware><feature enabled='yes' name='secure-boot'/><feature enabled='yes' name='enrolled-keys'/></firmware>")
		}
		fmt.Fprintf(&b, "<loader readonly='yes' type='pflash' secure='%s'>%s</loader><nvram template='%s'>%s</nvram>", map[bool]string{true: "yes", false: "no"}[p.SecureBoot], vmX(code), vmX(variables), vmX(filepath.Join(root, "nvram.fd")))
	}
	if p.BootOrder == "disk-first" {
		b.WriteString("<boot dev='hd'/>")
	}
	if bootISO != "" {
		b.WriteString("<boot dev='cdrom'/>")
	}
	if p.BootOrder != "disk-first" {
		b.WriteString("<boot dev='hd'/>")
	}
	b.WriteString("<bootmenu enable='yes'/></os><features><acpi/><apic/>")
	if p.SecureBoot {
		b.WriteString("<smm state='on'/>")
	}
	b.WriteString("</features><cpu mode='host-model'/><on_poweroff>destroy</on_poweroff><on_reboot>restart</on_reboot><on_crash>destroy</on_crash><devices>")
	for i, d := range v.Disks {
		dev := fmt.Sprintf("vd%c", 'a'+i)
		if p.DiskBus == "sata" {
			dev = fmt.Sprintf("sd%c", 'a'+i)
		}
		fmt.Fprintf(&b, "<disk type='file' device='disk'><driver name='qemu' type='qcow2'/><source file='%s'/><target dev='%s' bus='%s'/></disk>", vmX(filepath.Join(root, "disks", d.ID+".qcow2")), dev, p.DiskBus)
	}
	for i, path := range []string{bootISO, driverISO, filepath.Join(root, "seed.iso")} {
		if path == "" || !exists(path) {
			continue
		}
		fmt.Fprintf(&b, "<disk type='file' device='cdrom'><driver name='qemu' type='raw'/><source file='%s'/><target dev='sd%c' bus='sata'/><readonly/></disk>", vmX(path), 'i'+i)
	}
	fmt.Fprintf(&b, "<interface type='ethernet'><mac address='%s'/><target dev='%s' managed='no'/><model type='%s'/></interface>", vmX(v.MAC), vmTap(s.ID), p.NICModel)
	if p.VNC {
		fmt.Fprintf(&b, "<graphics type='vnc'><listen type='socket' socket='%s'/></graphics><video><model type='vga'/></video><input type='tablet' bus='usb'/>", vmX(filepath.Join(root, "vnc.sock")))
	}
	if p.Serial {
		fmt.Fprintf(&b, "<serial type='unix'><source mode='bind' path='%s'/><target type='isa-serial' port='0'/></serial><console type='unix'><source mode='bind' path='%s'/><target type='serial' port='0'/></console>", vmX(filepath.Join(root, "serial.sock")), vmX(filepath.Join(root, "serial.sock")))
	}
	if p.TPM {
		fmt.Fprintf(&b, "<tpm model='tpm-crb'><backend type='emulator' version='2.0' persistent_state='yes'><source type='dir' path='%s'/></backend></tpm>", vmX(filepath.Join(root, "tpm")))
	}
	b.WriteString("</devices></domain>")
	return b.String()
}
func vmDomainState(id string) (string, error) {
	state, e := virsh("domstate", vmName(id))
	if e == nil {
		return strings.TrimSpace(state), nil
	}
	// libvirt error wording varies by version and locale. A successful inventory
	// is required before treating an inaccessible domain as absent.
	inventory, inventoryErr := virsh("list", "--all", "--uuid")
	if inventoryErr != nil {
		return "", inventoryErr
	}
	for _, uuid := range strings.Fields(inventory) {
		if uuid == id {
			return "", e
		}
	}
	return "absent", nil
}
func vmStopped(id string) bool {
	state, e := vmDomainState(id)
	return e == nil && (state == "shut off" || state == "absent")
}
func vmStop(id string) error {
	if vmStopped(id) {
		return nil
	}
	if _, e := virsh("shutdown", vmName(id)); e != nil {
		return e
	}
	for i := 0; i < 60; i++ {
		if vmStopped(id) {
			return nil
		}
		time.Sleep(time.Second)
	}
	return errors.New("guest did not shut down; use force stop if appropriate")
}
func defineVM(s *server) error {
	root := vmRoot(s.ID)
	boot := ""
	if s.VM.Media.Kind == "iso" {
		path, e := cacheVMMedia(s.VM.Media)
		if e != nil {
			return e
		}
		if e = inspectVMISO(path); e != nil {
			return e
		}
		boot = path
	}
	drivers := ""
	if s.VM.Driver != nil {
		path, e := cacheVMMedia(*s.VM.Driver)
		if e != nil {
			return e
		}
		if e = inspectVMISO(path); e != nil {
			return e
		}
		drivers = path
	}
	if e := vmPrepareNetwork(s); e != nil {
		return e
	}
	if e := vmACL(root); e != nil {
		return e
	}
	if s.VM.Profile.TPM {
		user := env("VM_TPM_USER", "tss")
		if strings.ContainsAny(user, ":,\r\n") {
			return errors.New("invalid TPM user")
		}
		state := filepath.Join(root, "tpm")
		if e := os.MkdirAll(state, 0700); e != nil {
			return e
		}
		for _, dir := range []string{dataRoot, root} {
			if _, e := vmCommand("setfacl", "-m", "u:"+user+":--x", dir); e != nil {
				return e
			}
		}
		if _, e := vmCommand("setfacl", "-R", "-m", "u:"+user+":rwX", state); e != nil {
			return e
		}
		if _, e := vmCommand("setfacl", "-m", "d:u:"+user+":rwX", state); e != nil {
			return e
		}
	}
	path := filepath.Join(root, "domain.xml")
	if e := os.WriteFile(path, []byte(vmDomainXML(s, boot, drivers)), 0600); e != nil {
		return e
	}
	_, e := virsh("define", path, "--validate")
	return e
}
func vmSave(s *server) error {
	copy := *s
	v := *s.VM
	v.Password = ""
	copy.VM = &v
	b, e := json.Marshal(copy)
	if e != nil {
		return e
	}
	return os.WriteFile(filepath.Join(vmRoot(s.ID), "vm.json"), b, 0600)
}
func vmDisks(s *server) error {
	root := filepath.Join(vmRoot(s.ID), "disks")
	if e := os.MkdirAll(root, 0700); e != nil {
		return e
	}
	for _, d := range s.VM.Disks {
		path := filepath.Join(root, d.ID+".qcow2")
		if !exists(path) {
			if _, e := vmCommand("qemu-img", "create", "-f", "qcow2", path, fmt.Sprintf("%dM", d.SizeMB)); e != nil {
				return e
			}
		} else {
			format, e := inspectVMImage(path, d.SizeMB)
			if e != nil || format != "qcow2" {
				return errors.New("invalid managed VM disk")
			}
			if _, e = vmCommand("qemu-img", "resize", path, fmt.Sprintf("%dM", d.SizeMB)); e != nil {
				return e
			}
		}
	}
	return nil
}
func vmTap(id string) string {
	digest := sha256.Sum256([]byte(id))
	return "fv" + hex.EncodeToString(digest[:])[:12]
}
func vmIsolationProbe() error {
	vmProbeLock.Lock()
	defer vmProbeLock.Unlock()
	name := fmt.Sprintf("fvp%d", os.Getpid())
	table := fmt.Sprintf("fledge_probe_%d", os.Getpid())
	if _, e := vmCommand("ip", "link", "add", name, "type", "dummy"); e != nil {
		return e
	}
	defer vmCommand("ip", "link", "delete", name)
	bridgeName := fmt.Sprintf("fvb%d", os.Getpid())
	if _, e := vmCommand("ip", "link", "add", bridgeName, "type", "bridge"); e != nil {
		return e
	}
	defer vmCommand("ip", "link", "delete", bridgeName)
	if _, e := vmCommand("ip", "link", "set", name, "master", bridgeName); e != nil {
		return e
	}
	if _, e := vmCommand("bridge", "link", "set", "dev", name, "isolated", "on"); e != nil {
		return e
	}
	_, e := vmCommand("nft", "add", "table", "netdev", table)
	if e != nil {
		return e
	}
	defer vmCommand("nft", "delete", "table", "netdev", table)
	_, e = vmCommand("nft", "add", "chain", "netdev", table, "ingress", "{ type filter hook ingress device \""+name+"\" priority -500; policy drop; }")
	return e
}
func vmPrepareNetwork(s *server) error {
	text, e := virsh("net-dumpxml", s.VM.Network.LibvirtName)
	if e != nil {
		return e
	}
	var network struct {
		Bridge struct {
			Name string `xml:"name,attr"`
		} `xml:"bridge"`
	}
	if e = xml.Unmarshal([]byte(text), &network); e != nil {
		return e
	}
	if !regexp.MustCompile(`^[a-zA-Z0-9_.-]{1,15}$`).MatchString(network.Bridge.Name) {
		return errors.New("approved libvirt network has no usable bridge")
	}
	tap := vmTap(s.ID)
	alias := "fledge-vm:" + s.ID
	if existing, e := vmCommand("ip", "-j", "link", "show", "dev", tap); e == nil {
		var links []struct {
			Alias string `json:"ifalias"`
		}
		if json.Unmarshal([]byte(existing), &links) != nil || len(links) != 1 || links[0].Alias != alias {
			return errors.New("VM tap belongs to another workload")
		}
	} else {
		if _, e = vmCommand("ip", "tuntap", "add", "dev", tap, "mode", "tap", "user", env("VM_QEMU_USER", "libvirt-qemu")); e != nil {
			return e
		}
		if _, e = vmCommand("ip", "link", "set", "dev", tap, "alias", alias); e != nil {
			return e
		}
	}
	if _, e = vmCommand("ip", "link", "set", "dev", tap, "down"); e != nil {
		return e
	}
	if _, e = vmCommand("ip", "link", "set", "dev", tap, "master", network.Bridge.Name); e != nil {
		return e
	}
	if _, e = vmCommand("bridge", "link", "set", "dev", tap, "isolated", "on"); e != nil {
		return e
	}
	if e = vmNFT(s, network.Bridge.Name); e != nil {
		return e
	}
	_, e = vmCommand("ip", "link", "set", "dev", tap, "up")
	return e
}
func vmNFT(s *server, bridgeName string) error {
	table := "fledge_vm_" + strings.ReplaceAll(s.ID, "-", "")
	iface := vmTap(s.ID)
	var b strings.Builder
	// Delete and replace in the same nft transaction; failed validation keeps the
	// old isolation rules intact. Never change the administrator's firewall.
	if _, e := vmCommand("nft", "list", "table", "inet", table); e == nil {
		fmt.Fprintf(&b, "delete table inet %s\n", table)
	}
	if _, e := vmCommand("nft", "list", "table", "netdev", table); e == nil {
		fmt.Fprintf(&b, "delete table netdev %s\n", table)
	}
	fmt.Fprintf(&b, "table netdev %s { chain identity { type filter hook ingress device \"%s\" priority -500; policy drop; ether saddr != %s counter drop; ", table, iface, s.VM.MAC)
	if net.ParseIP(s.VM.Address).To4() != nil {
		fmt.Fprintf(&b, "ether type arp arp saddr ether != %s counter drop; ether type arp arp saddr ip != { 0.0.0.0, %s } counter drop; ether type arp accept; ether type ip ip saddr %s accept;", s.VM.MAC, s.VM.Address, s.VM.Address)
	} else {
		mac, _ := net.ParseMAC(s.VM.MAC)
		ll := net.IP{0xfe, 0x80, 0, 0, 0, 0, 0, 0, mac[0] ^ 2, mac[1], mac[2], 0xff, 0xfe, mac[3], mac[4], mac[5]}
		fmt.Fprintf(&b, "ether type ip6 exthdr frag exists meta l4proto ipv6-icmp counter drop; ether type ip6 icmpv6 type { nd-router-advert, redirect } counter drop; ether type ip6 icmpv6 type nd-neighbor-advert icmpv6 taddr != { %s, %s } counter drop; ether type ip6 ip6 saddr { %s, %s } accept; ether type ip6 ip6 saddr :: icmpv6 type nd-neighbor-solicit icmpv6 taddr { %s, %s } accept;", s.VM.Address, ll.String(), s.VM.Address, ll.String(), s.VM.Address, ll.String())
	}
	b.WriteString(" }\n}\n")
	family := "ip"
	bits := 32
	if net.ParseIP(s.VM.Address).To4() == nil {
		family = "ip6"
		bits = 128
	}
	subnet := net.ParseIP(strings.Split(s.VM.Network.Gateway, "/")[0]).Mask(net.CIDRMask(s.VM.Network.Prefix, bits)).String()
	fmt.Fprintf(&b, "table inet %s { chain host { type filter hook input priority -200; policy accept; ", table)
	match := fmt.Sprintf("iifname { \"%s\", \"%s\" } %s saddr %s", iface, bridgeName, family, s.VM.Address)
	// Bridged traffic reaches the host IP stack under the bridge's name.
	// Source identity is already enforced before bridge forwarding by netdev.
	fmt.Fprintf(&b, "%s %s daddr %s udp dport 53 accept; %s %s daddr %s tcp dport 53 accept; ", match, family, s.VM.Network.Gateway, match, family, s.VM.Network.Gateway)
	if family == "ip6" {
		mac, _ := net.ParseMAC(s.VM.MAC)
		ll := net.IP{0xfe, 0x80, 0, 0, 0, 0, 0, 0, mac[0] ^ 2, mac[1], mac[2], 0xff, 0xfe, mac[3], mac[4], mac[5]}
		fmt.Fprintf(&b, "iifname { \"%s\", \"%s\" } ip6 saddr { %s, %s, :: } icmpv6 type { nd-neighbor-solicit, nd-neighbor-advert } accept; iifname { \"%s\", \"%s\" } ip6 saddr %s drop; ", iface, bridgeName, s.VM.Address, ll.String(), iface, bridgeName, ll.String())
	}
	fmt.Fprintf(&b, "%s drop; }\n", match)
	fmt.Fprintf(&b, "chain isolation { type filter hook forward priority -200; policy accept; %s fib daddr type local drop; %s %s daddr %s/%d drop; ", match, match, family, subnet, s.VM.Network.Prefix)
	if family == "ip" {
		fmt.Fprintf(&b, "%s ip daddr { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16, 224.0.0.0/4 } drop; ", match)
	} else {
		fmt.Fprintf(&b, "%s ip6 daddr { ::1/128, fc00::/7, fe80::/10 } drop; ", match)
	}
	b.WriteString("}\n")
	if s.VM.Network.Mode == "nat" && len(s.VM.Forwards) > 0 {
		if family != "ip" {
			return errors.New("NAT forwarding requires an IPv4 pool")
		}
		b.WriteString("chain incoming { type nat hook prerouting priority -101; policy accept;\n")
		for _, r := range s.VM.Forwards {
			if r.Protocol != "tcp" && r.Protocol != "udp" || r.HostPort < 1024 || r.HostPort > 65535 || r.GuestPort < 1 || r.GuestPort > 65535 {
				return errors.New("invalid NAT forwarding")
			}
			fmt.Fprintf(&b, "fib daddr type local %s dport %d dnat ip to %s:%d\n", r.Protocol, r.HostPort, s.VM.Address, r.GuestPort)
		}
		b.WriteString("}\n")
	}
	b.WriteString("}\n")
	f, e := os.CreateTemp("", "fledge-nft-")
	if e != nil {
		return e
	}
	defer os.Remove(f.Name())
	_, e = f.WriteString(b.String())
	f.Close()
	if e != nil {
		return e
	}
	_, e = vmCommand("nft", "-f", f.Name())
	return e
}
func vmCreate(s *server) error {
	root := vmRoot(s.ID)
	if e := os.MkdirAll(root, 0700); e != nil {
		return e
	}
	if e := vmDisks(s); e != nil {
		return e
	}
	marker := filepath.Join(root, "installed")
	if !exists(marker) && s.VM.Media.Kind == "cloud" {
		image, e := cacheVMMedia(s.VM.Media)
		if e != nil {
			return e
		}
		format, e := inspectVMImage(image, s.VM.Disks[0].SizeMB)
		if e != nil {
			return e
		}
		disk := filepath.Join(root, "disks", s.VM.Disks[0].ID+".qcow2")
		tmp := disk + ".install"
		if _, e = vmCommand("qemu-img", "convert", "-f", format, "-O", "qcow2", image, tmp); e != nil {
			return e
		}
		if e = os.Rename(tmp, disk); e != nil {
			return e
		}
		if e = vmDisks(s); e != nil {
			return e
		}
		if e = vmSeed(s); e != nil {
			return e
		}
	}
	if e := defineVM(s); e != nil {
		return e
	}
	if e := vmSave(s); e != nil {
		return e
	}
	if e := os.WriteFile(marker, []byte("installed\n"), 0600); e != nil {
		return e
	}
	if vmStopped(s.ID) {
		return vmStart(s)
	}
	return nil
}

// A fresh API decision closes the hold/cancellation window during long imports.
// The API also checks the active job lease when a job initiated the operation.
func vmAuthorization(s *server) (string, error) {
	if api == "" {
		return "running", nil
	} // Unit/disposable guest harness; main requires API_URL.
	path := "/api/agent/servers/" + s.ID + "/vm-authorization"
	if active, ok := vmActiveJobs.Load(s.ID); ok {
		j := active.(*job)
		path += "?jobId=" + j.ID + "&attempt=" + strconv.Itoa(j.Attempt)
	}
	var reply struct {
		Allowed       bool
		DesiredStatus string
	}
	if e := request("GET", path, nil, &reply, true); e != nil {
		return "", e
	}
	if !reply.Allowed {
		return "", errors.New("VM operation authorization was revoked")
	}
	return reply.DesiredStatus, nil
}
func vmStart(s *server) error {
	desired, e := vmAuthorization(s)
	if e != nil {
		return e
	}
	if desired != "running" {
		return errors.New("VM boot was cancelled")
	}
	_, e = virsh("start", vmName(s.ID))
	return e
}

// Rebuild owned interfaces and isolation after restart. A guest whose manifest,
// authorization or firewall cannot be reconciled is fenced rather than exposed.
func vmReconcile() {
	if vmCapabilities()["libvirt"] != true {
		return
	}
	entries, e := os.ReadDir(dataRoot)
	if e != nil {
		log.Printf("VM reconcile: %v", e)
		return
	}
	for _, entry := range entries {
		if !entry.IsDir() || !uuidName.MatchString(entry.Name()) {
			continue
		}
		b, e := os.ReadFile(filepath.Join(dataRoot, entry.Name(), "vm.json"))
		if os.IsNotExist(e) {
			continue
		}
		unlock := vmLock(entry.Name())
		var s server
		if e == nil {
			e = json.Unmarshal(b, &s)
		}
		if e == nil && s.ID != entry.Name() {
			e = errors.New("manifest identity mismatch")
		}
		if e == nil {
			e = validateVM(&s)
		}
		var desired string
		if e == nil {
			desired, e = vmAuthorization(&s)
		}
		if e == nil {
			e = vmPrepareNetwork(&s)
		}
		if e != nil || desired != "running" {
			if !vmStopped(entry.Name()) {
				_, _ = virsh("destroy", vmName(entry.Name()))
			}
			if e != nil {
				log.Printf("VM %s fenced during reconcile: %v", entry.Name(), e)
			}
		}
		unlock()
	}
}

// Reconfiguration can grow a qcow2 image irreversibly. Stage and swap the
// complete stopped machine so a failed definition restores the previous size.
func vmChange(s *server, change func() error) error {
	root := vmRoot(s.ID)
	var previous server
	b, e := os.ReadFile(filepath.Join(root, "vm.json"))
	if e != nil {
		return e
	}
	if e = json.Unmarshal(b, &previous); e != nil {
		return e
	}
	if e = validateVM(&previous); e != nil {
		return e
	}
	stage, e := os.MkdirTemp(filepath.Dir(root), ".vm-change-")
	if e != nil {
		return e
	}
	defer os.RemoveAll(stage)
	if _, e = vmCommand("cp", "-a", "--reflink=auto", root+"/.", stage); e != nil {
		return e
	}
	if e = exchangeDirs(filepath.Dir(root), filepath.Base(root), filepath.Base(stage)); e != nil {
		return e
	}
	if e = change(); e != nil {
		if !vmStopped(s.ID) {
			if _, fence := virsh("destroy", vmName(s.ID)); fence != nil {
				return fmt.Errorf("VM change failed: %v; fencing failed: %w", e, fence)
			}
		}
		if rollback := exchangeDirs(filepath.Dir(root), filepath.Base(root), filepath.Base(stage)); rollback != nil {
			return fmt.Errorf("VM change failed: %v; storage rollback failed: %w", e, rollback)
		}
		if rollback := defineVM(&previous); rollback != nil {
			return fmt.Errorf("VM change failed: %v; domain rollback failed: %w", e, rollback)
		}
		return e
	}
	return nil
}

// Only release API reservations after the node confirms that no guest or partial
// provisioning data remains. Existing installed machines never enter this path.
func vmCleanupUnprovisioned(s *server) error {
	state, e := vmDomainState(s.ID)
	absent := state == "absent"
	if e != nil {
		return e
	}
	if !absent {
		if strings.TrimSpace(state) != "shut off" {
			return errors.New("partial guest is not fenced")
		}
		if _, e = virsh("undefine", vmName(s.ID), "--nvram", "--keep-tpm"); e != nil {
			return e
		}
	}
	table := "fledge_vm_" + strings.ReplaceAll(s.ID, "-", "")
	for _, family := range []string{"inet", "netdev"} {
		if _, e = vmCommand("nft", "list", "table", family, table); e == nil {
			if _, e = vmCommand("nft", "delete", "table", family, table); e != nil {
				return e
			}
		} else if !strings.Contains(e.Error(), "No such file") {
			return e
		}
	}
	if _, e = vmCommand("ip", "link", "show", vmTap(s.ID)); e == nil {
		if _, e = vmCommand("ip", "link", "delete", vmTap(s.ID)); e != nil {
			return e
		}
	} else if !strings.Contains(e.Error(), "does not exist") && !strings.Contains(e.Error(), "Cannot find device") {
		return e
	}
	return os.RemoveAll(vmRoot(s.ID))
}

func executeVM(j *job) (interface{}, error) {
	s := j.Server
	if e := validateVM(s); e != nil {
		return nil, e
	}
	unlock := vmLock(s.ID)
	defer unlock()
	vmActiveJobs.Store(s.ID, j)
	defer vmActiveJobs.Delete(s.ID)
	cleanup := j.Kind == "stop" || j.Kind == "kill" || j.Kind == "delete"
	if !cleanup {
		caps := vmCapabilities()
		if caps["enabled"] != true {
			return nil, errors.New("KVM/libvirt isolation prerequisites are unavailable")
		}
		if _, err := vmAuthorization(s); err != nil {
			return nil, err
		}
	}
	root := vmRoot(s.ID)
	var e error
	result := map[string]interface{}{"ok": true, "status": "stopped"}
	switch j.Kind {
	case "create":
		fresh := !exists(filepath.Join(root, "vm.json")) && !exists(filepath.Join(root, "installed"))
		e = vmCreate(s)
		if e != nil && fresh {
			if cleanupErr := vmCleanupUnprovisioned(s); cleanupErr == nil {
				result["provisioningCleaned"] = true
			}
		}
		result["status"] = "running"
	case "start":
		if e = defineVM(s); e == nil {
			e = vmStart(s)
		}
		result["status"] = "running"
	case "stop":
		e = vmStop(s.ID)
	case "kill":
		if !vmStopped(s.ID) {
			_, e = virsh("destroy", vmName(s.ID))
		}
	case "restart":
		if e = vmStop(s.ID); e == nil {
			if e = defineVM(s); e == nil {
				e = vmStart(s)
			}
		}
		result["status"] = "running"
	case "delete":
		if !vmStopped(s.ID) {
			_, e = virsh("destroy", vmName(s.ID))
		}
		if e == nil {
			var state string
			state, e = vmDomainState(s.ID)
			if e == nil && state != "absent" {
				_, e = virsh("undefine", vmName(s.ID), "--nvram", "--keep-tpm")
			}
		}
		if e == nil {
			table := "fledge_vm_" + strings.ReplaceAll(s.ID, "-", "")
			_, _ = vmCommand("nft", "delete", "table", "inet", table)
			_, _ = vmCommand("nft", "delete", "table", "netdev", table)
			_, _ = vmCommand("ip", "link", "delete", vmTap(s.ID))
			e = os.RemoveAll(root)
		}
	case "configure", "vm.disks", "vm.network":
		if !vmStopped(s.ID) {
			e = errors.New("stop the VM before reconfiguration")
		} else {
			e = vmChange(s, func() error {
				if err := vmDisks(s); err != nil {
					return err
				}
				if err := defineVM(s); err != nil {
					return err
				}
				return vmSave(s)
			})
		}
	case "vm.installation", "reinstall":
		if !vmStopped(s.ID) {
			e = errors.New("stop the VM before installation")
			break
		}
		e = vmChange(s, func() error {
			if j.Kind == "reinstall" || j.Payload["reinstall"] == true {
				for _, d := range s.VM.Disks {
					if err := os.Remove(filepath.Join(root, "disks", d.ID+".qcow2")); err != nil && !os.IsNotExist(err) {
						return err
					}
				}
				if err := os.Remove(filepath.Join(root, "installed")); err != nil && !os.IsNotExist(err) {
					return err
				}
				return vmCreate(s)
			}
			if err := defineVM(s); err != nil {
				return err
			}
			return vmSave(s)
		})
		if e == nil && (j.Kind == "reinstall" || j.Payload["reinstall"] == true) {
			result["status"] = "running"
		}

	case "verify-backup":
		return verifyBackup(j)
	case "backup":
		if !vmStopped(s.ID) {
			e = errors.New("stop the VM for a consistent full backup")
			break
		}
		var link string
		link, e = value(j, "url")
		if e == nil {
			e = vmSave(s)
		}
		if e == nil {
			var size int64
			size, e = backup(root, link, j.ID)
			result["sizeBytes"] = size
		}
	case "restore":
		var snapshots []vmSnapshotInfo
		previousVM := *s.VM
		if !vmStopped(s.ID) {
			e = errors.New("stop the VM before restoring")
			break
		}
		var link string
		link, e = value(j, "url")
		if e == nil {
			e = restoreWithPostSwap(root, link, j.ID, func() error {
				var old server
				b, e := os.ReadFile(filepath.Join(root, "vm.json"))
				if e != nil {
					return e
				}
				if e = json.Unmarshal(b, &old); e != nil || old.Runtime != "vm" || old.VM == nil || old.ID != s.ID {
					return errors.New("backup is not a VM bundle")
				}
				if old.VM.Profile.Firmware != s.VM.Profile.Firmware || old.VM.Profile.SecureBoot != s.VM.Profile.SecureBoot || old.VM.Profile.TPM != s.VM.Profile.TPM || old.VM.Profile.DiskBus != s.VM.Profile.DiskBus || old.VM.Profile.NICModel != s.VM.Profile.NICModel {
					return errors.New("backup hardware is incompatible with the VM profile")
				}
				s.VM.Disks = old.VM.Disks
				for _, d := range s.VM.Disks {
					if !uuidName.MatchString(d.ID) {
						return errors.New("invalid restored disk")
					}
					if _, e = inspectVMImage(filepath.Join(root, "disks", d.ID+".qcow2"), d.SizeMB); e != nil {
						return e
					}
				}
				if e = validateVM(s); e != nil {
					return e
				}
				snapshots, e = vmSnapshotInventory(s)
				if e != nil {
					return e
				}
				if e = defineVM(s); e != nil {
					return e
				}
				return vmSave(s)
			})
		}
		if e != nil {
			*s.VM = previousVM
			if exists(filepath.Join(root, "vm.json")) {
				if recovery := defineVM(s); recovery != nil {
					return nil, fmt.Errorf("restore failed: %v; domain recovery failed: %w", e, recovery)
				}
			}
		}
		if e == nil {
			var desired string
			desired, e = vmAuthorization(s)
			if e == nil && desired == "running" {
				e = vmStart(s)
				result["status"] = "running"
			}
			result["disks"] = s.VM.Disks
			result["snapshots"] = snapshots
		}
	case "vm.snapshot.create", "vm.snapshot.restore", "vm.snapshot.delete":
		result, e = vmSnapshot(j)
	default:
		e = errors.New("operation is unavailable for virtual machines")
	}
	return result, e
}

type vmSnapshotInfo struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	SizeMB int    `json:"sizeMb"`
}

func vmSnapshotInventory(s *server) ([]vmSnapshotInfo, error) {
	out := []vmSnapshotInfo{}
	total := 0
	for _, d := range s.VM.Disks {
		total += d.SizeMB
	}
	entries, e := os.ReadDir(filepath.Join(vmRoot(s.ID), "snapshots"))
	if os.IsNotExist(e) {
		return out, nil
	}
	if e != nil {
		return nil, e
	}
	for _, entry := range entries {
		if !entry.IsDir() || !uuidName.MatchString(entry.Name()) {
			return nil, errors.New("invalid snapshot bundle entry")
		}
		root := filepath.Join(vmRoot(s.ID), "snapshots", entry.Name())
		b, e := os.ReadFile(filepath.Join(root, "vm.json"))
		if e != nil {
			return nil, e
		}
		var saved server
		if json.Unmarshal(b, &saved) != nil || saved.ID != s.ID || validateVM(&saved) != nil {
			return nil, errors.New("invalid snapshot bundle metadata")
		}
		info := vmSnapshotInfo{ID: entry.Name(), Name: "Recovered snapshot"}
		if name, e := os.ReadFile(filepath.Join(root, "snapshot-name")); e == nil {
			info.Name = string(name)
			if len(info.Name) > 80 {
				info.Name = info.Name[:80]
			}
		}
		for _, d := range saved.VM.Disks {
			if _, e = inspectVMImage(filepath.Join(root, "disks", d.ID+".qcow2"), d.SizeMB); e != nil {
				return nil, e
			}
			info.SizeMB += d.SizeMB
		}
		total += info.SizeMB
		if total > s.DiskMB {
			return nil, errors.New("restored disks and snapshots exceed the storage allowance")
		}
		out = append(out, info)
	}
	return out, nil
}

func vmSnapshot(j *job) (map[string]interface{}, error) {
	s := j.Server
	id, e := value(j, "snapshotId")
	if e != nil || !uuidName.MatchString(id) {
		return nil, errors.New("invalid snapshot")
	}
	if !vmStopped(s.ID) {
		return nil, errors.New("stop the VM before snapshots")
	}
	root := vmRoot(s.ID)
	snap := filepath.Join(root, "snapshots", id)
	result := map[string]interface{}{"snapshotId": id, "status": "stopped"}
	if j.Kind == "vm.snapshot.delete" {
		return result, os.RemoveAll(snap)
	}
	if j.Kind == "vm.snapshot.create" {
		if exists(filepath.Join(snap, "vm.json")) {
			return result, nil
		}
		stage := snap + ".partial"
		defer os.RemoveAll(stage)
		_ = os.RemoveAll(stage)
		if e = os.MkdirAll(stage, 0700); e != nil {
			return nil, e
		}
		if e = vmSave(s); e != nil {
			return nil, e
		}
		for _, name := range []string{"disks", "nvram.fd", "tpm", "vm.json", "seed.iso", "installed"} {
			if exists(filepath.Join(root, name)) {
				if _, e = vmCommand("cp", "-a", "--reflink=auto", filepath.Join(root, name), filepath.Join(stage, name)); e != nil {
					return nil, e
				}
			}
		}
		if name, ok := j.Payload["name"].(string); ok {
			if len(name) > 80 {
				name = name[:80]
			}
			if e = os.WriteFile(filepath.Join(stage, "snapshot-name"), []byte(name), 0600); e != nil {
				return nil, e
			}
		}
		return result, os.Rename(stage, snap)
	}
	var saved server
	b, e := os.ReadFile(filepath.Join(snap, "vm.json"))
	if e != nil {
		return nil, e
	}
	if e = json.Unmarshal(b, &saved); e != nil || saved.VM == nil {
		return nil, errors.New("invalid snapshot metadata")
	}
	for _, d := range saved.VM.Disks {
		if !uuidName.MatchString(d.ID) {
			return nil, errors.New("invalid snapshot disk")
		}
		if _, e = inspectVMImage(filepath.Join(snap, "disks", d.ID+".qcow2"), d.SizeMB); e != nil {
			return nil, e
		}
	}
	previous := *s.VM
	s.VM.Disks = saved.VM.Disks
	if e = validateVM(s); e != nil {
		return nil, e
	}
	// Stage the entire workload and exchange directories once. Firmware, TPM and
	// disks must roll back together if validation or domain definition fails.
	stage, e := os.MkdirTemp(filepath.Dir(root), ".vm-snapshot-")
	if e != nil {
		return nil, e
	}
	defer os.RemoveAll(stage)
	if _, e = vmCommand("cp", "-a", "--reflink=auto", root+"/.", stage); e != nil {
		return nil, e
	}
	for _, name := range []string{"disks", "nvram.fd", "tpm", "seed.iso", "installed", "vm.json"} {
		if e = os.RemoveAll(filepath.Join(stage, name)); e != nil {
			return nil, e
		}
		if exists(filepath.Join(snap, name)) {
			if _, e = vmCommand("cp", "-a", "--reflink=auto", filepath.Join(snap, name), filepath.Join(stage, name)); e != nil {
				return nil, e
			}
		}
	}
	s.VM.Disks = saved.VM.Disks
	if e = exchangeDirs(filepath.Dir(root), filepath.Base(root), filepath.Base(stage)); e != nil {
		return nil, e
	}
	if e = defineVM(s); e == nil {
		e = vmSave(s)
	}
	if e != nil {
		if rollback := exchangeDirs(filepath.Dir(root), filepath.Base(root), filepath.Base(stage)); rollback != nil {
			return nil, fmt.Errorf("snapshot restore failed: %v; rollback failed: %w", e, rollback)
		}
		*s.VM = previous
		if rollback := defineVM(s); rollback != nil {
			return nil, fmt.Errorf("snapshot restore failed: %v; domain recovery failed: %w", e, rollback)
		}
		return nil, e
	}
	result["disks"] = s.VM.Disks
	return result, nil
}
func vmStatuses() []map[string]interface{} {
	if vmCapabilities()["libvirt"] != true {
		return nil
	}
	names, e := virsh("list", "--all", "--name")
	if e != nil {
		return nil
	}
	out := []map[string]interface{}{}
	for _, name := range strings.Fields(names) {
		if !strings.HasPrefix(name, "fledge-vm-") {
			continue
		}
		id := strings.TrimPrefix(name, "fledge-vm-")
		if !uuidName.MatchString(id) {
			continue
		}
		state, e := virsh("domstate", name)
		if e != nil {
			continue
		}
		status := "stopped"
		if state == "running" {
			status = "running"
		} else if state == "crashed" {
			status = "failed"
		}
		entry := map[string]interface{}{"id": id, "status": status, "diskEnforced": false}
		if used, e := diskUsage(vmRoot(id)); e == nil {
			entry["diskBytes"] = used
		}
		if stats, e := virsh("domstats", name, "--cpu-total", "--balloon"); e == nil {
			sample := map[string]interface{}{"cpuPercent": float64(0)}
			now := time.Now()
			for _, line := range strings.Split(stats, "\n") {
				kv := strings.SplitN(strings.TrimSpace(line), "=", 2)
				if len(kv) != 2 {
					continue
				}
				n, _ := strconv.ParseInt(kv[1], 10, 64)
				if kv[0] == "cpu.time" {
					if old, ok := vmCPU.Load(id); ok {
						previous := old.(vmCPUReading)
						elapsed := now.Sub(previous.at).Nanoseconds()
						if elapsed > 0 && n >= previous.total {
							sample["cpuPercent"] = float64(n-previous.total) * 100 / float64(elapsed)
						}
					}
					vmCPU.Store(id, vmCPUReading{n, now})
				}
				if kv[0] == "balloon.current" {
					sample["memoryBytes"] = n * 1024
				}
				if kv[0] == "balloon.maximum" {
					sample["memoryLimitBytes"] = n * 1024
				}
			}
			entry["usage"] = sample
		}
		out = append(out, entry)
	}
	return out
}
