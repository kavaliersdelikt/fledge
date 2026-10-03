package main

import (
	"strconv"
	"strings"
	"sync"
)

// Why did a game container stop? The panel shows the exit code, whether the kernel killed it for
// running out of memory, and the last log lines, and uses them in crash notifications. The
// log tail is read once per exit (keyed by the container's FinishedAt) and then remembered.

var exitCache = struct {
	sync.Mutex
	byName map[string]map[string]interface{}
}{byName: map[string]map[string]interface{}{}}

const maxExitLogReads = 5

// exitInfoFor returns exit details for stopped containers. status maps container name to the
// status reported to the panel ("failed" or "stopped"); only failures get a log tail.
func exitInfoFor(status map[string]string) map[string]map[string]interface{} {
	out := map[string]map[string]interface{}{}
	if len(status) == 0 {
		return out
	}
	args := []string{"inspect", "--format", "{{.Name}}|{{.State.ExitCode}}|{{.State.OOMKilled}}|{{.State.FinishedAt}}"}
	for name := range status {
		args = append(args, name)
	}
	text, e := docker(args...)
	if e != nil {
		return out
	}
	exitCache.Lock()
	defer exitCache.Unlock()
	reads := 0
	for _, line := range strings.Split(text, "\n") {
		f := strings.SplitN(strings.TrimSpace(line), "|", 4)
		if len(f) != 4 {
			continue
		}
		name := strings.TrimPrefix(f[0], "/")
		if _, wanted := status[name]; !wanted {
			continue
		}
		code, err := strconv.Atoi(f[1])
		if err != nil {
			continue
		}
		finished := f[3]
		if cached, ok := exitCache.byName[name]; ok && cached["finishedAt"] == finished {
			out[name] = cached
			continue
		}
		info := map[string]interface{}{"code": code, "oomKilled": f[2] == "true", "finishedAt": finished}
		if status[name] == "failed" && reads < maxExitLogReads {
			reads++
			if tail, err := docker("logs", "--tail", "15", name); err == nil {
				if len(tail) > 3000 {
					tail = tail[len(tail)-3000:]
				}
				info["logTail"] = tail
			}
		}
		exitCache.byName[name] = info
		out[name] = info
	}
	// Forget containers that are gone or running again.
	for name := range exitCache.byName {
		if _, still := status[name]; !still {
			delete(exitCache.byName, name)
		}
	}
	return out
}
