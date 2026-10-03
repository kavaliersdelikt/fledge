# Fledge node agent

A **Linux** Go program that runs on each game node. It does not listen on a port: it polls the panel over HTTPS for durable jobs, heartbeats
every 10 seconds and opens an outbound WebSocket for console logs and resource samples. It runs jobs with the local Docker CLI.

> The agent is root-equivalent (it controls Docker and server files). Install it only on hosts you administer, use HTTPS, and restrict its
> network egress. Windows and macOS are not node targets; Docker Desktop with a WSL2 distro works for local evaluation only.

Documentation: **<https://kavaliersdelikt.github.io/fledge/agent/>**

| Topic | Page |
| --- | --- |
| What the agent does and its configuration | [Overview](https://kavaliersdelikt.github.io/fledge/agent/) |
| Connecting a node (connector, manual, re-enrolling) | [Connect a node](https://kavaliersdelikt.github.io/fledge/agent/connect) |
| Windows evaluation with WSL2 (`build-agent-wsl.ps1`, `connect-wsl.ps1`) | [WSL2 evaluation node](https://kavaliersdelikt.github.io/fledge/agent/wsl2) |
| Kernel-enforced disk limits and snapshot backups | [Disk limits and volumes](https://kavaliersdelikt.github.io/fledge/agent/disk-limits) |
| Console, RCON, the console pipe and stopping booting servers | [Console and stopping](https://kavaliersdelikt.github.io/fledge/agent/console) |
| Self-updates | [Agent updates](https://kavaliersdelikt.github.io/fledge/agent/updates) |
| Every job kind | [Job reference](https://kavaliersdelikt.github.io/fledge/reference/jobs) |
| The protocol (to debug or write an agent) | [Agent protocol](https://kavaliersdelikt.github.io/fledge/api/agent-protocol) |

## Build

```sh
cd agent
go build -o fledge-agent .      # Linux only; plain `go build` on Windows targets Windows and fails on syscalls
fledge-agent --version
```

On Windows build inside WSL: `.\agent\build-agent-wsl.ps1 -Distro Ubuntu-24.04 -CheckDocker`. Run the tests anywhere with Docker:

```sh
docker run --rm -v "$PWD/agent:/src" -w /src golang:1.25 sh -c "go vet ./... && go test ./..."
```

`FLEDGE_DOCKER_TEST_IMAGE=postgres:16-alpine` enables an extra live stdin test against an image already on the local Docker engine.
