package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

var version = "0.7.1.1"

const maxTransfer = 8 << 20

var api, nodeID, dataRoot, credentialFile, credential string
var client = &http.Client{Timeout: 35 * time.Second}

type server struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	MemoryMB      int    `json:"memoryMb"`
	CPUPercent    int    `json:"cpuPercent"`
	DiskMB        int    `json:"diskMb"`
	Port          int    `json:"port"`
	Image         string `json:"image"`
	Startup       string `json:"startup"`
	StopCommand   string `json:"stopCommand"`
	TemplateID    string `json:"templateId"`
	InternalPorts []struct {
		Container int    `json:"container"`
		Offset    int    `json:"offset"`
		Protocol  string `json:"protocol"`
	} `json:"internalPorts"`
	Env map[string]string `json:"env"`
}
type job struct {
	ID      string                 `json:"id"`
	Kind    string                 `json:"kind"`
	Attempt int                    `json:"attempt"`
	Payload map[string]interface{} `json:"payload"`
	Server  *server                `json:"server"`
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
func consumeEnrollmentToken() string {
	secret := os.Getenv("ENROLLMENT_TOKEN")
	_ = os.Unsetenv("ENROLLMENT_TOKEN")
	return secret
}
func main() {
	if len(os.Args) > 1 && (os.Args[1] == "--version" || os.Args[1] == "version") {
		fmt.Println(version)
		return
	}
	api = strings.TrimRight(os.Getenv("API_URL"), "/")
	nodeID = os.Getenv("NODE_ID")
	dataRoot = env("DATA_ROOT", "/var/lib/fledge/servers")
	credentialFile = env("CREDENTIAL_FILE", "/var/lib/fledge/agent.credential")
	if api == "" || nodeID == "" {
		log.Fatal("API_URL and NODE_ID required")
	}
	u, e := url.Parse(api)
	if e != nil || (u.Scheme != "https" && !(u.Scheme == "http" && os.Getenv("ALLOW_INSECURE_HTTP") == "true")) {
		log.Fatal("API_URL must be HTTPS; ALLOW_INSECURE_HTTP=true is for local development only")
	}
	if e = os.MkdirAll(dataRoot, 0700); e != nil {
		log.Fatal(e)
	}
	updateBoot()
	if b, e := os.ReadFile(credentialFile); e == nil {
		credential = strings.TrimSpace(string(b))
	}
	if credential == "" {
		secret := consumeEnrollmentToken()
		if secret == "" {
			log.Fatal("ENROLLMENT_TOKEN or saved credential required")
		}
		var reply struct {
			Credential string `json:"credential"`
		}
		if e = request("POST", "/api/agent/enroll", map[string]string{"nodeId": nodeID, "token": secret}, &reply, false); e != nil {
			log.Fatal(e)
		}
		if reply.Credential == "" {
			log.Fatal("missing credential")
		}
		credential = reply.Credential
		if e = os.MkdirAll(filepath.Dir(credentialFile), 0700); e != nil {
			log.Fatal(e)
		}
		if e = os.WriteFile(credentialFile, []byte(credential+"\n"), 0600); e != nil {
			log.Fatal(e)
		}
	}
	log.Printf("Fledge agent %s node %s", version, nodeID)
	mountAllVolumes()
	loadFailoverState()
	if e := heartbeat(); e != nil {
		log.Printf("heartbeat: %v", e)
	}
	go liveLoop()
	go func() {
		for {
			if e := heartbeat(); e != nil {
				log.Printf("heartbeat: %v", e)
				checkFence()
			}
			time.Sleep(10 * time.Second)
		}
	}()
	for {
		var reply struct {
			Job *job `json:"job"`
		}
		if e := request("GET", "/api/agent/jobs", nil, &reply, true); e != nil {
			log.Printf("poll: %v", e)
			time.Sleep(3 * time.Second)
			continue
		}
		if reply.Job != nil {
			runJob(reply.Job)
		} else {
			time.Sleep(2 * time.Second)
		}
	}
}
func request(method, p string, body interface{}, out interface{}, auth bool) error {
	var in io.Reader
	if body != nil {
		b, e := json.Marshal(body)
		if e != nil {
			return e
		}
		in = bytes.NewReader(b)
	}
	r, e := http.NewRequest(method, api+p, in)
	if e != nil {
		return e
	}
	if body != nil {
		r.Header.Set("Content-Type", "application/json")
	}
	if auth {
		r.Header.Set("Authorization", "Bearer "+credential)
		r.Header.Set("X-Node-ID", nodeID)
	}
	res, e := client.Do(r)
	if e != nil {
		return e
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		b, _ := io.ReadAll(io.LimitReader(res.Body, 1024))
		return fmt.Errorf("API %s: %s", res.Status, strings.TrimSpace(string(b)))
	}
	if out != nil {
		return json.NewDecoder(io.LimitReader(res.Body, 16<<20)).Decode(out)
	}
	return nil
}

type cappedOutput struct {
	bytes.Buffer
	max int
}

func (b *cappedOutput) Write(p []byte) (int, error) {
	n := len(p)
	if b.Len() < b.max {
		room := b.max - b.Len()
		if len(p) > room {
			p = p[:room]
		}
		_, _ = b.Buffer.Write(p)
	}
	return n, nil
}

var runDocker = func(args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()
	c := exec.CommandContext(ctx, "docker", args...)
	out := &cappedOutput{max: maxTransfer}
	c.Stdout = out
	c.Stderr = out
	e := c.Run()
	o := strings.TrimSpace(out.String())
	if e != nil {
		return "", fmt.Errorf("docker %s: %v: %s", args[0], e, o)
	}
	return o, nil
}

func docker(args ...string) (string, error) { return runDocker(args...) }
func container(id string) string            { return "nvr-" + id }
func heartbeat() error {
	usage := map[string]interface{}{}
	if b, e := os.ReadFile("/proc/meminfo"); e == nil {
		for _, line := range strings.Split(string(b), "\n") {
			f := strings.Fields(line)
			if len(f) >= 2 && (f[0] == "MemTotal:" || f[0] == "MemAvailable:") {
				n, _ := strconv.ParseInt(f[1], 10, 64)
				usage[strings.TrimSuffix(f[0], ":")+"Mb"] = n / 1024
			}
		}
	}
	var st syscall.Statfs_t
	if syscall.Statfs(dataRoot, &st) == nil {
		usage["diskFreeMb"] = st.Bavail * uint64(st.Bsize) / 1048576
	}
	usage["cpuCount"] = len(strings.Split(strings.TrimSpace(cpuList()), "\n"))
	status := []map[string]interface{}{}
	running := []string{}
	ids := []string{}
	entries := map[string]map[string]interface{}{}
	stopped := map[string]string{}
	byName := map[string]map[string]interface{}{}
	names, e := docker("ps", "-a", "--filter", "label=fledge.server", "--format", "{{.Names}}|{{.Status}}")
	if e == nil {
		for _, line := range strings.Split(names, "\n") {
			f := strings.SplitN(line, "|", 2)
			if len(f) != 2 || !strings.HasPrefix(f[0], "nvr-") {
				continue
			}
			s := "stopped"
			if strings.HasPrefix(f[1], "Up ") {
				s = "running"
			} else if strings.Contains(f[1], "Restarting") || (strings.HasPrefix(f[1], "Exited (") && !strings.HasPrefix(f[1], "Exited (0)")) {
				s = "failed"
			}
			entry := map[string]interface{}{"id": strings.TrimPrefix(f[0], "nvr-"), "status": s}
			ids = append(ids, strings.TrimPrefix(f[0], "nvr-"))
			byName[f[0]] = entry
			if s == "running" {
				running = append(running, f[0])
				entries[f[0]] = entry
			} else {
				stopped[f[0]] = s
			}
			sroot := filepath.Join(dataRoot, strings.TrimPrefix(f[0], "nvr-"))
			if used, _, ok := volumeUsedBytes(sroot); ok {
				entry["diskBytes"] = used
				entry["diskEnforced"] = true
			} else if used, err := diskUsage(sroot); err == nil {
				entry["diskBytes"] = used
				entry["diskEnforced"] = false
			}
			status = append(status, entry)
		}
		if samples, err := containerStatsBatch(context.Background(), running); err == nil {
			for name, sample := range samples {
				entries[name]["usage"] = sample
			}
		} else {
			log.Printf("stats: %v", err)
		}
		for name, info := range exitInfoFor(stopped) {
			byName[name]["exit"] = info
		}
	} else {
		log.Printf("docker status: %v", e)
	}
	var reply struct {
		Config *panelConfig `json:"config"`
	}
	if e := request("POST", "/api/agent/heartbeat", map[string]interface{}{"version": version, "usage": usage, "servers": status, "agent": agentInfo(), "held": heldIDs(ids)}, &reply, true); e != nil {
		return e
	}
	applyConfig(reply.Config)
	beatOK()
	updateConfirm()
	return nil
}
func cpuList() string {
	b, _ := os.ReadFile("/proc/stat")
	var s []string
	for _, v := range strings.Split(string(b), "\n") {
		if strings.HasPrefix(v, "cpu") && len(v) > 3 && v[3] >= '0' && v[3] <= '9' {
			s = append(s, v)
		}
	}
	return strings.Join(s, "\n")
}
func runJob(j *job) {
	done := make(chan struct{})
	go func() {
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ticker.C:
				if e := request("POST", "/api/agent/jobs/"+j.ID+"/renew", map[string]int{"attempt": j.Attempt}, nil, true); e != nil {
					log.Printf("renew %s: %v", j.ID, e)
				}
			}
		}
	}()
	var result interface{}
	var err error
	func() {
		defer func() {
			if p := recover(); p != nil {
				err = fmt.Errorf("agent panic: %v", p)
			}
		}()
		result, err = executeOnce(j)
	}()
	close(done)
	body := map[string]interface{}{"attempt": j.Attempt, "success": err == nil, "result": result}
	if err != nil {
		body["error"] = err.Error()
		log.Printf("job %s (%s): %v", j.ID, j.Kind, err)
	}
	if e := request("POST", "/api/agent/jobs/"+j.ID+"/result", body, nil, true); e != nil {
		log.Printf("job result %s: %v", j.ID, e)
	}
}
func executeOnce(j *job) (interface{}, error) {
	if j.Kind == "agent.update" {
		return updateAgent(j)
	}
	if j.Kind == "evict" {
		id, _ := j.Payload["serverId"].(string)
		return evictServer(id)
	}
	persistent := map[string]bool{"create": true, "reinstall": true, "configure": true, "start": true, "stop": true, "restart": true, "kill": true, "delete": true, "backup": true, "restore": true, "file.import": true, "file.export": true}[j.Kind]
	if !persistent {
		return execute(j)
	}
	receipts := filepath.Join(dataRoot, ".jobs")
	if e := os.MkdirAll(receipts, 0700); e != nil {
		return nil, e
	}
	file := filepath.Join(receipts, j.ID+".json")
	if b, e := os.ReadFile(file); e == nil {
		var prior interface{}
		if json.Unmarshal(b, &prior) == nil {
			return prior, nil
		}
	}
	result, e := execute(j)
	if e != nil {
		return nil, e
	}
	b, e := json.Marshal(result)
	if e != nil {
		return nil, e
	}
	temp := file + ".tmp"
	if e = os.WriteFile(temp, b, 0600); e != nil {
		return nil, e
	}
	if e = os.Rename(temp, file); e != nil {
		return nil, e
	}
	return result, nil
}
func execute(j *job) (interface{}, error) {
	s := j.Server
	if s == nil {
		return nil, errors.New("missing server")
	}
	n := container(s.ID)
	root := filepath.Join(dataRoot, s.ID)
	switch j.Kind {
	case "create", "reinstall":
		allowed := imageAllowed(s.Image)
		if !allowed {
			return nil, errors.New("image not allowlisted on node")
		}
		if j.Kind == "reinstall" {
			if _, e := docker("rm", "-f", n); e != nil && !strings.Contains(e.Error(), "No such container") {
				return nil, e
			}
			if e := destroyVolume(s.ID); e != nil {
				return nil, e
			}
			if e := os.RemoveAll(root); e != nil {
				return nil, e
			}
		}
		if _, e := docker("inspect", n); e == nil {
			return map[string]bool{"existing": true}, nil
		}
		if e := prepareData(s); e != nil {
			return nil, e
		}
		mount := "/data"
		if s.TemplateID == "valheim" {
			mount = "/config"
		}
		args := []string{"run", "-d", "-i", "--name", n, "--label", "fledge.server=" + s.ID, "--memory", strconv.Itoa(s.MemoryMB) + "m", "--cpus", fmt.Sprintf("%.2f", float64(s.CPUPercent)/100), "--pids-limit", "512", "--security-opt", "no-new-privileges", "--restart", "no", "-v", root + ":" + mount}
		for _, p := range s.InternalPorts {
			args = append(args, "-p", fmt.Sprintf("%d:%d/%s", s.Port+p.Offset, p.Container, p.Protocol))
		}
		// Variables Pterodactyl startup commands expect.
		args = append(args, "-e", "SERVER_MEMORY="+strconv.Itoa(s.MemoryMB), "-e", "SERVER_PORT="+strconv.Itoa(s.Port), "-e", "SERVER_IP=0.0.0.0")
		for k, v := range s.Env {
			if strings.ContainsAny(k, "=\x00") || strings.ContainsRune(v, '\x00') {
				return nil, errors.New("invalid environment variable")
			}
			args = append(args, "-e", k+"="+v)
		}
		// The console pipe lets the panel (and the image's own stop logic) reach the console
		// while the game is still starting, when RCON is not up yet.
		if minecraftImage(s.Image) {
			if _, set := s.Env["CREATE_CONSOLE_IN_PIPE"]; !set {
				args = append(args, "-e", "CREATE_CONSOLE_IN_PIPE=TRUE")
			}
		}
		if s.Startup != "" {
			args = append(args, "--entrypoint", "/bin/sh")
		}
		args = append(args, s.Image)
		if s.Startup != "" {
			args = append(args, "-c", s.Startup)
		}
		_, e := docker(args...)
		return map[string]string{"container": n}, e
	case "start":
		if recreated, e := mountForStart(s); e != nil || recreated {
			return map[string]bool{"ok": e == nil}, e
		}
		_, e := docker("start", n)
		return map[string]bool{"ok": e == nil}, e
	case "stop":
		e := stopServer(s, n)
		return map[string]bool{"ok": e == nil}, e
	case "kill":
		_, e := docker("kill", n)
		return map[string]bool{"ok": e == nil}, e
	case "restart":
		if recreated, e := mountForStart(s); e != nil || recreated {
			return map[string]bool{"ok": e == nil}, e
		}
		e := stopContainer(n, 30)
		if e == nil {
			_, e = docker("start", n)
		}
		return map[string]bool{"ok": e == nil}, e
	case "delete":
		_, e := docker("rm", "-f", n)
		if e != nil && !strings.Contains(e.Error(), "No such container") {
			return nil, e
		}
		if e = destroyVolume(s.ID); e != nil {
			return nil, e
		}
		return map[string]bool{"ok": true}, os.RemoveAll(root)
	case "configure":
		if j.Payload["recreate"] == true {
			if _, e := docker("rm", "-f", n); e != nil && !strings.Contains(e.Error(), "No such container") {
				return nil, e
			}
			return execute(&job{Kind: "create", Server: s})
		}
		if e := resizeData(s); e != nil {
			return nil, e
		}
		_, e := docker("update", "--memory", strconv.Itoa(s.MemoryMB)+"m", "--cpus", fmt.Sprintf("%.2f", float64(s.CPUPercent)/100), n)
		return map[string]bool{"ok": e == nil}, e
	case "logs":
		out, e := docker("logs", "--tail", "200", n)
		if len(out) > maxTransfer {
			out = out[len(out)-maxTransfer:]
		}
		return map[string]string{"output": out}, e
	case "command":
		cmd, e := value(j, "command")
		if e != nil {
			return nil, e
		}
		if strings.HasPrefix(s.Image, "itzg/minecraft-server:") {
			// Force IPv4 loopback: on Alpine-based server images localhost may resolve
			// to ::1 while the Minecraft RCON listener is bound to 0.0.0.0.
			out, e := docker("exec", n, "rcon-cli", "--host", "127.0.0.1", cmd)
			if e != nil && strings.Contains(e.Error(), "Failed to connect to RCON") && !containerStopped(n) {
				// RCON only answers once the world has loaded. Queue the line on the console
				// pipe so it runs as soon as the server is up.
				if pe := sendToConsole(n, cmd); pe == nil {
					return map[string]string{"output": "The server is still starting, so RCON is not ready. The command was queued and runs once the console is up."}, nil
				}
				return nil, errors.New("the server is still starting and cannot take commands yet; try again once it has finished loading")
			}
			return map[string]string{"output": out}, e
		}
		out, e := writeConsoleInput(n, cmd)
		return map[string]string{"output": out}, e
	case "backup":
		u, e := value(j, "url")
		if e != nil {
			return nil, e
		}
		size, e := backupWithLifecycle(root, u, j.ID, n, strings.HasPrefix(s.Image, "itzg/minecraft-server:"))
		return map[string]int64{"sizeBytes": size}, e
	case "verify-backup":
		return verifyBackup(j)
	case "restore":
		u, e := value(j, "url")
		if e != nil {
			return nil, e
		}
		e = restoreWithLifecycle(root, u, j.ID, n)
		return map[string]bool{"ok": e == nil}, e
	case "file.list":
		p, e := value(j, "path")
		if e != nil {
			return nil, e
		}
		return listFiles(root, p)
	case "file.import", "file.export":
		return streamFile(j, root)
	case "file.read":
		p, e := value(j, "path")
		if e != nil {
			return nil, e
		}
		return readFile(root, p, true)
	case "file.download":
		p, e := value(j, "path")
		if e != nil {
			return nil, e
		}
		return readFile(root, p, false)
	case "file.write", "file.upload":
		p, e := value(j, "path")
		if e != nil {
			return nil, e
		}
		key := "content"
		if j.Kind == "file.upload" {
			key = "data"
		}
		v, e := value(j, key)
		if e != nil {
			return nil, e
		}
		data := []byte(v)
		if key == "data" {
			data, e = base64.StdEncoding.DecodeString(v)
			if e != nil {
				return nil, e
			}
		}
		if len(data) > maxTransfer {
			return nil, errors.New("upload exceeds 8 MiB")
		}
		if e := checkWriteBudget(root, p, int64(len(data)), int64(s.DiskMB)*1048576); e != nil {
			return nil, e
		}
		return map[string]bool{"ok": true}, writeSafe(root, p, data)
	case "file.mkdir":
		p, e := value(j, "path")
		if e != nil {
			return nil, e
		}
		return map[string]bool{"ok": true}, mkdirSafe(root, p)
	case "file.extract":
		p, e := value(j, "path")
		if e != nil {
			return nil, e
		}
		return map[string]bool{"ok": true}, extractZip(root, p)
	case "file.fetch":
		return fetchFile(j, root, int64(s.DiskMB))
	case "file.delete":
		return deleteFiles(j, root)
	case "file.rename":
		return renameFile(j, root)
	default:
		return nil, fmt.Errorf("unsupported job kind: %s", j.Kind)
	}
}
func value(j *job, key string) (string, error) {
	s, ok := j.Payload[key].(string)
	if !ok || s == "" {
		return "", fmt.Errorf("missing %s", key)
	}
	return s, nil
}

// prepareData creates the server's data directory: a size-limited volume when this
// node can enforce disk allowances, a plain directory otherwise.
func prepareData(s *server) error {
	root := filepath.Join(dataRoot, s.ID)
	on, e := quotaActive()
	if e != nil {
		return e
	}
	if on || hasVolume(s.ID) {
		return ensureVolume(s.ID, s.DiskMB)
	}
	return os.MkdirAll(root, 0700)
}

// mountForStart makes sure the data volume is mounted before the game starts. A server
// from before disk limits is moved into a volume by recreating its container; the
// returned bool says the container was recreated (and so is already running).
func mountForStart(s *server) (bool, error) {
	root := filepath.Join(dataRoot, s.ID)
	if isMounted(root) {
		return false, nil
	}
	if hasVolume(s.ID) {
		return false, mountVolume(imagePath(s.ID), root)
	}
	on, e := quotaActive()
	if e != nil {
		return false, e
	}
	if !on {
		return false, nil
	}
	if _, e = docker("rm", "-f", container(s.ID)); e != nil && !strings.Contains(e.Error(), "No such container") {
		return false, e
	}
	if e = ensureVolume(s.ID, s.DiskMB); e != nil {
		return false, e
	}
	_, e = execute(&job{Kind: "create", Server: s})
	return true, e
}

// resizeData applies a changed disk allowance to the volume (grow online, shrink
// with the game stopped) and migrates plain directories when enforcement is on.
func resizeData(s *server) error {
	n, root := container(s.ID), filepath.Join(dataRoot, s.ID)
	if !hasVolume(s.ID) {
		on, e := quotaActive()
		if e != nil || !on {
			return e
		}
		state, _ := docker("inspect", "--format", "{{.State.Running}}", n)
		if _, e = mountForStart(s); e != nil {
			return e
		}
		if state != "true" {
			stopContainer(n, 30)
		}
		return nil
	}
	if e := mountVolume(imagePath(s.ID), root); e != nil {
		return e
	}
	cur, e := volumeSizeMB(s.ID)
	if e != nil || cur == s.DiskMB {
		return e
	}
	if s.DiskMB > cur && growOnline(s.ID, s.DiskMB) == nil {
		return nil
	}
	state, _ := docker("inspect", "--format", "{{.State.Running}}", n)
	if state == "true" {
		if e = stopContainer(n, 30); e != nil {
			return e
		}
	}
	e = resizeOffline(s.ID, s.DiskMB)
	if state == "true" {
		if _, se := docker("start", n); se != nil && e == nil {
			e = se
		}
	}
	return e
}

// stopServer stops a game the way its template asks: "^C" sends SIGINT, any other stop
// command is typed into the console. If the game is still up after 30 s, Docker stops it.
func stopServer(s *server, n string) error {
	cmd := strings.TrimSpace(s.StopCommand)
	if cmd == "" {
		return stopContainer(n, 30)
	}
	var e error
	if cmd == "^C" {
		_, e = docker("kill", "--signal", "SIGINT", n)
	} else {
		_, e = writeConsoleInput(n, cmd)
	}
	if e == nil {
		for i := 0; i < 30; i++ {
			if state, _ := docker("inspect", "--format", "{{.State.Running}}", n); state == "false" {
				return nil
			}
			time.Sleep(time.Second)
		}
	}
	_, e = docker("stop", "-t", "10", n)
	return e
}
