#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
project="$tmp/project"
mock="$tmp/mock-bin"
mkdir -p "$project" "$mock"
cp "$ROOT/install.sh" "$ROOT/compose.yaml" "$ROOT/.env.example" "$project/"
cat > "$mock/docker" <<'EOF'
#!/bin/sh
set -eu
printf '%s\n' "$*" >> "$MOCK_LOG"
case "$*" in
  info|compose\ version|compose\ up\ --build\ -d) exit 0 ;;
  *) echo "Unexpected docker invocation: $*" >&2; exit 91 ;;
esac
EOF
chmod 755 "$mock/docker"
export MOCK_LOG="$tmp/docker.log"
export PATH="$mock:$PATH"

sh "$project/install.sh" --check
[ ! -e "$project/.env" ] || { echo '--check wrote .env' >&2; exit 1; }
sh "$project/install.sh" --no-wait
grep -Eq '^POSTGRES_PASSWORD=[0-9a-f]{48}$' "$project/.env"
grep -Eq '^ENCRYPTION_KEY=[0-9a-f]{64}$' "$project/.env"
if [ "$(stat -c '%a' "$project/.env" 2>/dev/null || stat -f '%Lp' "$project/.env")" != 600 ]; then
  echo '.env permissions are not private (0600)' >&2
  exit 1
fi
expected_key=$(sed -n 's/^ENCRYPTION_KEY=//p' "$project/.env")
sh "$project/install.sh" --no-wait
[ "$(sed -n 's/^ENCRYPTION_KEY=//p' "$project/.env")" = "$expected_key" ] || { echo 'Existing .env was overwritten' >&2; exit 1; }
printf 'POSTGRES_PASSWORD=REPLACE_WITH_secret\nENCRYPTION_KEY=REPLACE_WITH_key\n' > "$project/.env"
if sh "$project/install.sh" --no-wait >/dev/null 2>&1; then echo 'Placeholder .env was accepted' >&2; exit 1; fi
[ "$(grep -c '^compose up --build -d$' "$MOCK_LOG")" -eq 2 ] || { echo 'Compose was called unexpectedly' >&2; exit 1; }
echo 'PASS installer smoke: check-only, secret creation, private permissions, idempotent env preservation, and placeholder rejection'
