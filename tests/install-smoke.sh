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
  compose\ exec\ -T\ plugins*) [ "${MOCK_PLUGINS_UP:-1}" = 1 ] ;;
  *) echo "Unexpected docker invocation: $*" >&2; exit 91 ;;
esac
EOF
printf '#!/bin/sh
exit 0
' > "$mock/curl"
chmod 755 "$mock/docker" "$mock/curl"
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
# Waiting mode also checks the plugin host: healthy is reported, unhealthy only warns.
printf 'POSTGRES_PASSWORD=%s
ENCRYPTION_KEY=%s
' abc123 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef > "$project/.env"
sh "$project/install.sh" > "$tmp/wait.out" 2>&1 || { cat "$tmp/wait.out" >&2; echo 'Installer failed with a healthy stack' >&2; exit 1; }
grep -q 'Fledge is ready' "$tmp/wait.out" || { echo 'No ready message' >&2; exit 1; }
grep -q '^compose exec -T plugins ' "$MOCK_LOG" || { echo 'Plugin host health was not checked' >&2; exit 1; }
MOCK_PLUGINS_UP=0 INSTALL_PLUGIN_WAIT_ATTEMPTS=1 sh "$project/install.sh" > "$tmp/warn.out" 2>&1 || { cat "$tmp/warn.out" >&2; echo 'An unhealthy plugin host failed the install' >&2; exit 1; }
grep -q 'plugin host did not become healthy' "$tmp/warn.out" || { echo 'No warning for the plugin host' >&2; exit 1; }
grep -q 'Fledge is ready' "$tmp/warn.out" || { echo 'The installer stopped before finishing' >&2; exit 1; }
echo 'PASS installer smoke: check-only, secret creation, private permissions, idempotent env preservation, placeholder rejection, and plugin host health check'
