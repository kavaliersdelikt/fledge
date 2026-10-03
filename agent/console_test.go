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

func TestStopContainerUsesIPv4RCONForMinecraft(t *testing.T) {
	prior := runDocker
	defer func() { runDocker = prior }()
	running := "true"
	var calls []string
	runDocker = func(args ...string) (string, error) {
		line := strings.Join(args, " ")
		calls = append(calls, line)
		switch {
		case strings.Contains(line, "Config.Image"):
			return "itzg/minecraft-server:java21-alpine", nil
		case args[0] == "exec":
			running = "false"
			return "", nil
		case args[0] == "inspect":
			return running, nil
		}
		return "", errors.New("unexpected docker call: " + line)
	}
	if err := stopContainer("mc", 5); err != nil {
		t.Fatal(err)
	}
	if want := "exec mc rcon-cli --host 127.0.0.1 stop"; calls[1] != want {
		t.Fatalf("expected %q, got %#v", want, calls)
	}
}

func TestStopContainerFallsBackToDockerStop(t *testing.T) {
	prior := runDocker
	defer func() { runDocker = prior }()
	var calls []string
	runDocker = func(args ...string) (string, error) {
		line := strings.Join(args, " ")
		calls = append(calls, line)
		switch {
		case strings.Contains(line, "Config.Image"):
			return "itzg/minecraft-server:java21-alpine", nil
		case args[0] == "exec":
			return "", errors.New("rcon unavailable")
		}
		return "", nil
	}
	if err := stopContainer("mc", 5); err != nil {
		t.Fatal(err)
	}
	if last := calls[len(calls)-1]; last != "stop -t 5 mc" {
		t.Fatalf("expected docker stop fallback, got %#v", calls)
	}
}

func TestStopContainerQueuesStopOnConsolePipeWhileMinecraftIsBooting(t *testing.T) {
	prior := runDocker
	defer func() { runDocker = prior }()
	running := "true"
	var calls []string
	runDocker = func(args ...string) (string, error) {
		line := strings.Join(args, " ")
		calls = append(calls, line)
		switch {
		case strings.Contains(line, "Config.Image"):
			return "itzg/minecraft-server:java21-alpine", nil
		case strings.Contains(line, "rcon-cli"):
			return "", errors.New("Failed to connect to RCON server")
		case strings.Contains(line, "stat -c %u /data"):
			return "1000", nil
		case strings.Contains(line, "test -p /tmp/minecraft-console-in"):
			return "", nil
		case strings.Contains(line, "mc-send-to-console"):
			running = "false"
			return "", nil
		case args[0] == "inspect":
			return running, nil
		}
		return "", errors.New("unexpected docker call: " + line)
	}
	if err := stopContainer("mc", 5); err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(calls, "\n")
	if !strings.Contains(joined, "exec --user 1000 mc mc-send-to-console stop") {
		t.Fatalf("stop was not queued on the console pipe: %s", joined)
	}
	if strings.Contains(joined, "stop -t") {
		t.Fatalf("docker stop (SIGKILL after the timeout) must not be needed: %s", joined)
	}
}

func TestSendToConsoleGivesUpOnAPipeNobodyReads(t *testing.T) {
	prior := runDocker
	defer func() { runDocker = prior }()
	release := make(chan struct{})
	defer close(release)
	runDocker = func(args ...string) (string, error) {
		<-release // a write to a FIFO without a reader blocks forever
		return "", nil
	}
	start := time.Now()
	if _, err := dockerWithin(100*time.Millisecond, "exec", "mc", "mc-send-to-console", "stop"); err == nil {
		t.Fatal("expected a timeout")
	}
	if time.Since(start) > 2*time.Second {
		t.Fatal("did not give up in time")
	}
}

func TestSendToConsoleRefusesWithoutAPipe(t *testing.T) {
	prior := runDocker
	defer func() { runDocker = prior }()
	runDocker = func(args ...string) (string, error) {
		line := strings.Join(args, " ")
		if strings.Contains(line, "test -p /tmp/minecraft-console-in") {
			return "", errors.New("exit status 1")
		}
		if strings.Contains(line, "mc-send-to-console") {
			t.Fatalf("nothing must be written when there is no pipe: %s", line)
		}
		return "1000", nil
	}
	if err := sendToConsole("mc", "stop"); err == nil {
		t.Fatal("expected an error without a console pipe")
	}
}
