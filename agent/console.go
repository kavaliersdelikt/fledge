package main

import (
	"errors"
	"fmt"
	"io"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
)

// stopContainer stops a game container, waiting up to seconds for it to exit.
// Minecraft images get a graceful RCON "stop" over IPv4 first: the runner
// inside the image calls rcon-cli against "localhost", which can resolve to
// IPv6 and fail, and its stdin fallback cannot write to Docker's read-only
// stdin pipe, so Docker's stop would otherwise end in a SIGKILL.
func stopContainer(name string, seconds int) error {
	image, err := docker("inspect", "--format", "{{.Config.Image}}", name)
	if err == nil && strings.HasPrefix(strings.TrimSpace(image), "itzg/minecraft-server:") {
		if _, err = docker("exec", name, "rcon-cli", "--host", "127.0.0.1", "stop"); err == nil {
			for i := 0; i < seconds; i++ {
				if state, _ := docker("inspect", "--format", "{{.State.Running}}", name); strings.TrimSpace(state) == "false" {
					return nil
				}
				time.Sleep(time.Second)
			}
		}
	}
	_, err = docker("stop", "-t", strconv.Itoa(seconds), name)
	return err
}

type consoleSession struct {
	input io.WriteCloser
	write sync.Mutex
	done  chan error
}

var consoleSessions = struct {
	sync.Mutex
	byContainer map[string]*consoleSession
}{byContainer: make(map[string]*consoleSession)}

// Open one persistent Docker attach stream per console-used container. Keeping
// that stream alive avoids repeatedly piping into `docker attach`, which can
// hang waiting for logs or drop input when stdin closes after a single write.
func stdinSession(name string) (*consoleSession, error) {
	consoleSessions.Lock()
	defer consoleSessions.Unlock()
	if current := consoleSessions.byContainer[name]; current != nil {
		select {
		case <-current.done:
			delete(consoleSessions.byContainer, name)
		default:
			return current, nil
		}
	}
	open, err := docker("inspect", "--format", "{{.Config.OpenStdin}}", name)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(open) != "true" {
		return nil, errors.New("this server container does not have interactive stdin enabled. Recreate it from Settings after taking a backup, then retry")
	}
	reader, writer := io.Pipe()
	cmd := exec.Command("docker", "attach", "--sig-proxy=false", name)
	cmd.Stdin = reader
	cmd.Stdout, cmd.Stderr = io.Discard, io.Discard
	if err = cmd.Start(); err != nil {
		_ = reader.Close()
		_ = writer.Close()
		return nil, fmt.Errorf("start Docker console attachment: %w", err)
	}
	session := &consoleSession{input: writer, done: make(chan error, 1)}
	consoleSessions.byContainer[name] = session
	go func() {
		err := cmd.Wait()
		_ = reader.CloseWithError(io.EOF)
		_ = writer.CloseWithError(io.EOF)
		session.done <- err
		consoleSessions.Lock()
		if consoleSessions.byContainer[name] == session {
			delete(consoleSessions.byContainer, name)
		}
		consoleSessions.Unlock()
	}()
	return session, nil
}

var writeConsoleInput = func(name, command string) (string, error) {
	if strings.ContainsAny(command, "\x00\r\n\x10\x11") {
		return "", errors.New("console input must be a single line without control characters")
	}
	session, err := stdinSession(name)
	if err != nil {
		return "", err
	}
	session.write.Lock()
	defer session.write.Unlock()
	select {
	case err = <-session.done:
		return "", fmt.Errorf("server console attachment ended: %w", err)
	default:
	}
	if _, err = io.WriteString(session.input, command+"\n"); err != nil {
		return "", fmt.Errorf("write to server console: %w", err)
	}
	return "Input forwarded to container stdin. The game must support console input this way.", nil
}
