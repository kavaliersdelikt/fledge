package main

import (
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"
)

func TestGenericConsoleUsesOpenStdin(t *testing.T) {
	oldDocker, oldInput := runDocker, writeConsoleInput
	defer func() { runDocker, writeConsoleInput = oldDocker, oldInput }()
	runDocker = func(args ...string) (string, error) { return "true", nil }
	var gotName, gotLine string
	writeConsoleInput = func(name, command string) (string, error) {
		gotName, gotLine = name, command
		return "sent", nil
	}
	result, err := execute(&job{Kind: "command", Payload: map[string]interface{}{"command": "save"}, Server: &server{ID: "server-id", Image: "ghcr.io/lloesche/valheim-server:latest"}})
	if err != nil {
		t.Fatal(err)
	}
	if gotName != "nvr-server-id" || gotLine != "save" {
		t.Fatalf("console input %q %q", gotName, gotLine)
	}
	if result.(map[string]string)["output"] != "sent" {
		t.Fatalf("unexpected result: %#v", result)
	}
}

func TestMinecraftConsoleStillUsesRCON(t *testing.T) {
	oldDocker, oldInput := runDocker, writeConsoleInput
	defer func() { runDocker, writeConsoleInput = oldDocker, oldInput }()
	var args []string
	runDocker = func(got ...string) (string, error) { args = got; return "ok", nil }
	writeConsoleInput = func(string, string) (string, error) { return "", errors.New("must use RCON") }
	_, err := execute(&job{Kind: "command", Payload: map[string]interface{}{"command": "say hi"}, Server: &server{ID: "id", Image: "itzg/minecraft-server:java21-alpine"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(args) < 6 || args[0] != "exec" || args[2] != "rcon-cli" {
		t.Fatalf("expected Minecraft RCON, got %#v", args)
	}
}

func TestConsoleRejectsDetachAndMultilineControlCharacters(t *testing.T) {
	for _, input := range []string{"say\nstop", "say\rstop", "say\x00", "say\x10", "say\x11"} {
		if _, err := writeConsoleInput("container", input); err == nil {
			t.Fatalf("accepted unsafe console input %q", input)
		}
	}
}

func TestDockerConsoleInputIntegration(t *testing.T) {
	image := os.Getenv("FLEDGE_DOCKER_TEST_IMAGE")
	if image == "" {
		t.Skip("set FLEDGE_DOCKER_TEST_IMAGE to run the Docker stdin integration check")
	}
	name := fmt.Sprintf("fledge-console-smoke-%d", time.Now().UnixNano())
	id, err := docker("run", "-d", "-i", "--name", name, "--label", "fledge.console.test=true", "--entrypoint", "/bin/sh", image, "-c", `while IFS= read -r line; do printf 'ACK:%s\n' "$line"; done`)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		metadata, inspectErr := docker("inspect", "--format", `{{.Id}}|{{index .Config.Labels "fledge.console.test"}}`, name)
		parts := strings.Split(strings.TrimSpace(metadata), "|")
		if inspectErr == nil && len(parts) == 2 && parts[0] == id && parts[1] == "true" {
			_, _ = docker("rm", "-f", id)
		}
	}()
	if _, err = writeConsoleInput(name, "fledge console smoke first"); err != nil {
		t.Fatal(err)
	}
	if _, err = writeConsoleInput(name, "fledge console smoke second"); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(4 * time.Second)
	for time.Now().Before(deadline) {
		got, logErr := docker("logs", "--tail", "20", name)
		if logErr == nil && strings.Contains(got, "ACK:fledge console smoke first") && strings.Contains(got, "ACK:fledge console smoke second") {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	got, _ := docker("logs", "--tail", "20", name)
	t.Fatalf("stdin did not reach the container; console log: %q", got)
}
