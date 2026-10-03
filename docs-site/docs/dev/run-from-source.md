---
title: Run from source
---

# Run from source

You need Node.js 22, PostgreSQL 15 or newer and (for the agent) Go and Docker.

## Database

```sh
docker run -d --name fledge-dev-pg -p 5432:5432 -e POSTGRES_USER=fledge -e POSTGRES_PASSWORD=devpw -e POSTGRES_DB=fledge postgres:16-alpine
```

## API

```sh
cd api
npm ci
export DATABASE_URL='postgres://fledge:devpw@localhost:5432/fledge'
export ENCRYPTION_KEY="$(openssl rand -hex 32)"
export WEB_ORIGIN='http://localhost:3000'
export PORT=4000
npm start            # tsx src/index.ts; applies db/schema.sql at startup
```

Type-check with `npm run check`.

## Plugin host

```sh
cd plugins/host
npm ci
PORT=4020 PLUGIN_TOKEN_FILE=/tmp/fledge-plugin-token node --import tsx src/server.ts
```

The API creates the shared token file on first use, so start the API first (point it at the same file with
`PLUGIN_TOKEN_FILE` and at the host with `PLUGIN_HOST_URL=http://127.0.0.1:4020`).

## Panel

```sh
cd web
npm ci
NEXT_PUBLIC_API_URL=http://localhost:4000 npm run dev
```

## Agent

The agent is Linux-only. On Linux:

```sh
cd agent && go build -o fledge-agent . && sudo ./fledge-agent   # with API_URL, NODE_ID, ENROLLMENT_TOKEN set
```

On Windows use the [WSL2 helper](/agent/wsl2). Run the agent's tests anywhere with Docker:

```sh
docker run --rm -v "$PWD/agent:/src" -w /src golang:1.25 sh -c "go vet ./... && go test ./..."
```

## The whole stack

`docker compose up --build -d` builds and starts everything (see [Install](/operate/install)).
