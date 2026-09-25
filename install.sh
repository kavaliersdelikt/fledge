#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
CHECK_ONLY=0
NO_WAIT=0

usage() {
  cat <<'EOF'
Fledge local panel installer

Usage: sh install.sh [--check] [--no-wait]
  --check    Verify Docker Compose and repository files without changing anything.
  --no-wait  Start Compose without waiting for the panel/API health checks.
EOF
}

for arg in "$@"; do
  case "$arg" in
    --check) CHECK_ONLY=1 ;;
    --no-wait) NO_WAIT=1 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; usage >&2; exit 2 ;;
  esac
done

[ -f "$ROOT/compose.yaml" ] || { echo 'compose.yaml was not found; run this from a Fledge source checkout.' >&2; exit 2; }
[ -f "$ROOT/.env.example" ] || { echo '.env.example was not found.' >&2; exit 2; }
command -v docker >/dev/null 2>&1 || { echo 'Docker is required. Install Docker Desktop (Windows/macOS) or Docker Engine + Compose (Linux).' >&2; exit 10; }
command -v curl >/dev/null 2>&1 || { echo 'curl is required for health checks.' >&2; exit 11; }
docker info >/dev/null 2>&1 || { echo 'Docker is installed but its engine is not running or reachable.' >&2; exit 12; }
docker compose version >/dev/null 2>&1 || { echo 'Docker Compose v2 is required: run `docker compose version`.' >&2; exit 13; }

if [ "$CHECK_ONLY" -eq 1 ]; then
  echo 'Install prerequisites are ready. No files or containers were changed.'
  exit 0
fi

ENV_FILE="$ROOT/.env"
if [ -f "$ENV_FILE" ]; then
  if grep -Eq 'REPLACE_WITH_|^POSTGRES_PASSWORD=$|^ENCRYPTION_KEY=$' "$ENV_FILE"; then
    echo '.env contains placeholder or empty required secrets. Edit it first; the installer will not replace an existing .env.' >&2
    exit 14
  fi
  echo 'Using the existing .env without modifying it.'
else
  command -v openssl >/dev/null 2>&1 || { echo 'OpenSSL is required to generate the initial secrets.' >&2; exit 15; }
  password=$(openssl rand -hex 24)
  encryption_key=$(openssl rand -hex 32)
  umask 077
  temporary="$ROOT/.env.install.$$"
  trap 'rm -f "$temporary"' EXIT HUP INT TERM
  awk -F= -v password="$password" -v key="$encryption_key" '
    $1 == "POSTGRES_PASSWORD" { print "POSTGRES_PASSWORD=" password; next }
    $1 == "ENCRYPTION_KEY" { print "ENCRYPTION_KEY=" key; next }
    { print }
  ' "$ROOT/.env.example" > "$temporary"
  if grep -Eq 'REPLACE_WITH_|^POSTGRES_PASSWORD=$|^ENCRYPTION_KEY=$' "$temporary"; then
    echo '.env.example is missing a required secret setting.' >&2
    exit 16
  fi
  chmod 600 "$temporary"
  mv "$temporary" "$ENV_FILE"
  trap - EXIT HUP INT TERM
  echo 'Created a private .env with new random database and encryption secrets.'
fi

cd "$ROOT"
docker compose up --build -d

if [ "$NO_WAIT" -eq 1 ]; then
  echo 'Compose started. Panel: http://localhost:3000  API: http://localhost:4000/api/health'
  exit 0
fi

attempt=0
until curl --fail --silent http://localhost:4000/api/health >/dev/null; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then
    echo 'The API did not become healthy within 120 seconds. Check `docker compose logs api`.' >&2
    exit 20
  fi
  sleep 2
done
attempt=0
until curl --fail --silent http://localhost:3000/ >/dev/null; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then
    echo 'The panel did not become healthy within 120 seconds. Check `docker compose logs web`.' >&2
    exit 21
  fi
  sleep 2
done
echo 'Fledge is ready at http://localhost:3000. The first visit creates the administrator and enrolls two-factor authentication.'
