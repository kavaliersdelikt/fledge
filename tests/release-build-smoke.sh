#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
mkdir -p "$tmp/project/agent" "$tmp/project/release"
cp "$ROOT"/agent/*.go "$ROOT/agent/go.mod" "$ROOT/agent/go.sum" "$tmp/project/agent/"
version=0.1.0-test
for arch in amd64 arm64; do
  (cd "$tmp/project/agent" && GOOS=linux GOARCH="$arch" CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=$version" -o "../release/fledge-agent_linux_$arch" .)
done
(cd "$tmp/project/release" && sha256sum fledge-agent_linux_amd64 fledge-agent_linux_arm64 > SHA256SUMS && sha256sum --check SHA256SUMS)
echo 'PASS release build smoke: Linux amd64/arm64 artifacts, release filenames, and SHA256SUMS verification'
