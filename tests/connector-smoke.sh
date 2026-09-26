#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
connector="$ROOT/agent/connect.sh"
node=7d5ec69e-311c-4014-827b-12b6de10241f
sh "$connector" --api https://panel.example.com --node "$node" --repo example/fledge --validate-only >/dev/null
sh "$connector" --api http://localhost:4000 --node "$node" --repo example/fledge --allow-insecure-http --validate-only >/dev/null
reject() { if "$@" >/dev/null 2>&1; then echo 'Unsafe connector arguments were accepted.' >&2; exit 1; fi; }
reject sh "$connector" --api http://panel.example.com --node "$node" --repo example/fledge --validate-only
reject sh "$connector" --api https://panel.example.com --node invalid --repo example/fledge --validate-only
reject sh "$connector" --api https://panel.example.com --node "$node" --repo ../fledge --validate-only
reject sh "$connector" --api https://panel.example.com --node "$node" --repo 'example/fledge;touch$HOME' --validate-only
echo 'PASS connector smoke: HTTPS enforcement, explicit local HTTP opt-in, UUID/repository validation, and command-injection rejection'
