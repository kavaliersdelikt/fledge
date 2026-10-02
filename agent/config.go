package main

import (
	"runtime"
	"strings"
	"sync"
)

// Settings the panel pushes to every node in the heartbeat reply.
type panelConfig struct {
	AllowedImagePrefixes []string `json:"allowedImagePrefixes"`
	SFTP                 struct {
		Enabled bool `json:"enabled"`
		Port    int  `json:"port"`
	} `json:"sftp"`
	DiskEnforcement string         `json:"diskEnforcement"`
	Failover        failoverConfig `json:"failover"`
}

var (
	cfgMu    sync.Mutex
	prefixes = strings.Split(env("ALLOWED_IMAGE_PREFIXES", "itzg/minecraft-server:,itzg/minecraft-bedrock-server:,ghcr.io/lloesche/valheim-server:,node:,python:,oven/bun:,golang:,eclipse-temurin:,php:,ruby:,mcr.microsoft.com/dotnet/"), ",")
)

func applyConfig(c *panelConfig) {
	if c == nil {
		return
	}
	cfgMu.Lock()
	prefixes = c.AllowedImagePrefixes
	cfgMu.Unlock()
	setQuotaMode(c.DiskEnforcement)
	applySFTP(c.SFTP.Enabled, c.SFTP.Port)
	applyFailover(c.Failover)
}

func imageAllowed(image string) bool {
	cfgMu.Lock()
	defer cfgMu.Unlock()
	for _, p := range prefixes {
		p = strings.TrimSpace(p)
		if p != "" && strings.HasPrefix(image, p) {
			return true
		}
	}
	return false
}

func agentInfo() map[string]interface{} {
	blocker := updateBlocker()
	info := map[string]interface{}{
		"os": runtime.GOOS, "arch": runtime.GOARCH,
		"updatable": blocker == "",
		"quota":     quotaStatus(),
		"sftp":      sftpStatus(),
	}
	if blocker != "" {
		info["updateBlocker"] = blocker
	}
	return info
}
