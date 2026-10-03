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

// minecraftImage reports whether a container image is the itzg Minecraft Java server.
func minecraftImage(image string) bool {
	return strings.HasPrefix(strings.TrimSpace(image), "itzg/minecraft-server:")
}

// bootStopWait is how long a stop waits for a Minecraft server that is still starting.
// The wait is bounded because the agent runs one job at a time; a stop that takes longer falls back to docker stop.
const bootStopWait = 180

func containerStopped(name string) bool {
	state, _ := docker("inspect", "--format", "{{.State.Running}}", name)
	return strings.TrimSpace(state) == "false"
}

// waitStopped polls until the container has exited or the time is up.
func waitStopped(name string, seconds int) bool {
	for i := 0; i < seconds; i++ {
		if containerStopped(name) {
			return true
		}
		time.Sleep(time.Second)
	}
	return containerStopped(name)
}

// dockerWithin runs a docker command but stops waiting for it after d. Used for calls that
// can block forever, such as writing to a console pipe nobody is reading yet.
func dockerWithin(d time.Duration, args ...string) (string, error) {
	type result struct {
		out string
		err error
	}
	done := make(chan result, 1)
	go func() {
		out, err := docker(args...)
		done <- result{out, err}
	}()
	select {
	case r := <-done:
		return r.out, r.err
	case <-time.After(d):
		return "", fmt.Errorf("docker %s did not finish within %s", args[0], d)
	}
}

// gameUID is the user the game runs as inside a Minecraft container: the owner of its data
// directory (the image's UID setting, 1000 by default).
func gameUID(name string) string {
	out, err := docker("exec", name, "stat", "-c", "%u", "/data")
	out = strings.TrimSpace(out)
	if err != nil || out == "" || strings.Trim(out, "0123456789") != "" {
		return "1000"
	}
	return out
}

// sendToConsole queues one console line for a Minecraft container through the named pipe
// the image creates (CREATE_CONSOLE_IN_PIPE). Unlike RCON it works while the server is
// still booting: the line is read as soon as the console comes up. The helper refuses to run
// as root, so it is started as the game user.
func sendToConsole(name, line string) error {
	// Without the pipe (image started without CREATE_CONSOLE_IN_PIPE) mc-send-to-console would just create a
	// plain file and the line would be lost, so refuse instead of waiting for a stop that never comes.
	if _, err := dockerWithin(10*time.Second, "exec", name, "test", "-p", "/tmp/minecraft-console-in"); err != nil {
		return errors.New("the console pipe is not available in this container")
	}
	_, err := dockerWithin(10*time.Second, "exec", "--user", gameUID(name), name, "mc-send-to-console", line)
	return err
}

// stopContainer stops a game container, waiting up to seconds for it to exit.
//
// Minecraft images get a graceful "stop" first. RCON over IPv4 is tried because the runner
// inside the image calls rcon-cli against "localhost", which can resolve to IPv6 and fail.
// RCON only answers once the world has loaded, so for a server that is still starting the
// stop is queued on the console pipe and given time to boot and shut down properly; the
// runner's own fallback (writing to /dev/stdin) cannot work with Docker's read-only stdin
// pipe and would end in a SIGKILL.
func stopContainer(name string, seconds int) error {
	image, err := docker("inspect", "--format", "{{.Config.Image}}", name)
	if err == nil && minecraftImage(image) {
		if _, err = docker("exec", name, "rcon-cli", "--host", "127.0.0.1", "stop"); err == nil {
			if waitStopped(name, seconds) {
				return nil
			}
		} else if !containerStopped(name) {
			if sendToConsole(name, "stop") == nil {
				wait := bootStopWait
				if seconds > wait {
					wait = seconds
				}
				if waitStopped(name, wait) {
					return nil
				}
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
