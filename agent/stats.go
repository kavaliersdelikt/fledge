package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

type resourceSample struct {
	CPUPercent       float64 `json:"cpuPercent"`
	MemoryBytes      int64   `json:"memoryBytes"`
	MemoryLimitBytes int64   `json:"memoryLimitBytes"`
}

func sizeBytes(s string) (int64, error) {
	s = strings.TrimSpace(s)
	units := []struct {
		suffix string
		factor float64
	}{{"GiB", 1 << 30}, {"MiB", 1 << 20}, {"KiB", 1 << 10}, {"TiB", 1 << 40}, {"GB", 1e9}, {"MB", 1e6}, {"kB", 1e3}, {"B", 1}}
	for _, u := range units {
		if strings.HasSuffix(s, u.suffix) {
			v, e := strconv.ParseFloat(strings.TrimSpace(strings.TrimSuffix(s, u.suffix)), 64)
			if e != nil || math.IsNaN(v) || math.IsInf(v, 0) || v < 0 {
				return 0, errors.New("invalid docker memory size")
			}
			return int64(v*u.factor + 0.5), nil
		}
	}
	return 0, errors.New("unknown docker memory unit")
}
func parseStats(line string) (resourceSample, error) {
	var row struct {
		CPU    string `json:"CPUPerc"`
		Memory string `json:"MemUsage"`
	}
	if e := json.Unmarshal([]byte(line), &row); e != nil {
		return resourceSample{}, e
	}
	cpu, e := strconv.ParseFloat(strings.TrimSuffix(strings.TrimSpace(row.CPU), "%"), 64)
	if e != nil || math.IsNaN(cpu) || math.IsInf(cpu, 0) || cpu < 0 || cpu > 100000 {
		return resourceSample{}, fmt.Errorf("invalid Docker CPU percent: %q", row.CPU)
	}
	fields := strings.Split(row.Memory, "/")
	if len(fields) != 2 {
		return resourceSample{}, errors.New("invalid Docker memory usage")
	}
	used, e := sizeBytes(fields[0])
	if e != nil {
		return resourceSample{}, e
	}
	limit, e := sizeBytes(fields[1])
	if e != nil || limit <= 0 {
		return resourceSample{}, errors.New("invalid Docker memory limit")
	}
	return resourceSample{cpu, used, limit}, nil
}

// One Docker stats invocation samples all running servers; heartbeat must not
// block once per server (the node lease is only 35 seconds).
func containerStatsBatch(ctx context.Context, names []string) (map[string]resourceSample, error) {
	samples := make(map[string]resourceSample)
	if len(names) == 0 {
		return samples, nil
	}
	bounded, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	args := append([]string{"stats", "--no-stream", "--format", "{{json .}}"}, names...)
	out, e := exec.CommandContext(bounded, "docker", args...).Output()
	if e != nil {
		return samples, fmt.Errorf("docker stats batch: %w", e)
	}
	return parseStatsBatch(out, names), nil
}
func parseStatsBatch(out []byte, names []string) map[string]resourceSample {
	samples := make(map[string]resourceSample)
	allowed := make(map[string]bool, len(names))
	for _, n := range names {
		allowed[n] = true
	}
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		var entry struct {
			Name string `json:"Name"`
		}
		if json.Unmarshal([]byte(line), &entry) != nil || !allowed[entry.Name] {
			continue
		}
		if sample, e := parseStats(line); e == nil {
			samples[entry.Name] = sample
		}
	}
	return samples
}
func containerStats(ctx context.Context, name string) (resourceSample, error) {
	bounded, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	out, e := exec.CommandContext(bounded, "docker", "stats", "--no-stream", "--format", "{{json .}}", name).Output()
	if e != nil {
		return resourceSample{}, fmt.Errorf("docker stats %s: %w", name, e)
	}
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	if len(lines) != 1 {
		return resourceSample{}, errors.New("docker stats returned no single sample")
	}
	return parseStats(lines[0])
}
