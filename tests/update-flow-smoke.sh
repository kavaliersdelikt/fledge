#!/bin/sh
# Runs the real update.sh against a throw-away Git repository with a mocked docker and curl:
# an update that introduces the plugin host rebuilds it too, a rollback to a release without
# it never asks for it, and an unhealthy plugin host only warns.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
mock="$tmp/mock-bin"; mkdir -p "$mock"
cat > "$mock/docker" <<'MOCK'
#!/bin/sh
printf '%s\n' "$*" >> "$MOCK_LOG"
case "$*" in
  "compose version") exit 0 ;;
  "compose exec -T postgres pg_dump"*) echo '-- dump'; exit 0 ;;
  "compose config --services") echo api; echo web; if grep -q '^  plugins:' compose.yaml; then echo plugins; fi; exit 0 ;;
  "compose up -d --build"*) exit 0 ;;
  "compose exec -T plugins"*) [ "${MOCK_PLUGINS_UP:-1}" = 1 ] && exit 0 || exit 1 ;;
  *) echo "Unexpected docker invocation: $*" >&2; exit 91 ;;
esac
MOCK
cat > "$mock/curl" <<'MOCK'
#!/bin/sh
[ "${MOCK_HEALTH:-1}" = 1 ]
MOCK
chmod 755 "$mock/docker" "$mock/curl"

origin="$tmp/origin.git"; work="$tmp/work"
git init -q --bare "$origin"
git clone -q "$origin" "$work" 2>/dev/null
cd "$work"
git config user.email fledge-test@example.test; git config user.name Fledge-Test
printf '.env\n.backups/\n' > .gitignore
cp "$ROOT/update.sh" update.sh
printf 'services:\n  postgres:\n    image: x\n  api:\n    build: .\n  web:\n    build: .\n' > compose.yaml
git add . && git commit -qm old && git tag v0.5.9
printf 'services:\n  postgres:\n    image: x\n  api:\n    build: .\n  plugins:\n    build: .\n  web:\n    build: .\n' > compose.yaml
git add . && git commit -qm new && git tag v0.6.1.1
git push -q origin HEAD:refs/heads/main --tags 2>/dev/null
git checkout -q --detach v0.5.9
printf 'POSTGRES_PASSWORD=x\nAPP_VERSION=0.5.9\n' > .env
export MOCK_LOG="$tmp/docker.log" PATH="$mock:$PATH" UPDATE_POLL_SECONDS=0 API_HEALTH_URL=http://api WEB_HEALTH_URL=http://web

# 1. Updating to a release that has the plugin host rebuilds it together with api and web.
: > "$MOCK_LOG"
sh ./update.sh v0.6.1.1 > "$tmp/out1" 2>&1 || { cat "$tmp/out1" >&2; echo 'Update to a release with the plugin host failed.' >&2; exit 1; }
grep -q '^compose up -d --build api web plugins$' "$MOCK_LOG" || { cat "$MOCK_LOG" >&2; echo 'The plugin host was not rebuilt by the update.' >&2; exit 1; }
grep -q 'Plugin host is healthy' "$tmp/out1" || { cat "$tmp/out1" >&2; echo 'No plugin host health report.' >&2; exit 1; }
grep -q '^APP_VERSION=0.6.1.1$' .env || { echo 'APP_VERSION was not updated in .env.' >&2; exit 1; }

# 2. A failed health check rolls back to the old release, which has no plugin host to rebuild.
git checkout -q --detach v0.5.9; printf 'POSTGRES_PASSWORD=x\nAPP_VERSION=0.5.9\n' > .env; : > "$MOCK_LOG"
if MOCK_HEALTH=0 sh ./update.sh v0.6.1.1 > "$tmp/out2" 2>&1; then echo 'An unhealthy update was reported as success.' >&2; exit 1; fi
[ "$(grep -c '^compose up -d --build' "$MOCK_LOG")" -eq 2 ] || { cat "$MOCK_LOG" >&2; echo 'Expected one forward build and one rollback build.' >&2; exit 1; }
[ "$(grep '^compose up -d --build' "$MOCK_LOG" | tail -n 1)" = 'compose up -d --build api web' ] || { cat "$MOCK_LOG" >&2; echo 'The rollback asked for a service the old release does not define.' >&2; exit 1; }
grep -q '^APP_VERSION=0.5.9$' .env || { echo 'APP_VERSION was not restored after the rollback.' >&2; exit 1; }
[ "$(git rev-parse HEAD)" = "$(git rev-parse v0.5.9^{commit})" ] || { echo 'The rollback did not restore the previous revision.' >&2; exit 1; }

# 3. An unhealthy plugin host is reported but does not fail or roll back the update.
git checkout -q --detach v0.5.9; printf 'POSTGRES_PASSWORD=x\nAPP_VERSION=0.5.9\n' > .env; : > "$MOCK_LOG"
MOCK_PLUGINS_UP=0 sh ./update.sh v0.6.1.1 > "$tmp/out3" 2>&1 || { cat "$tmp/out3" >&2; echo 'A broken plugin host failed the whole update.' >&2; exit 1; }
grep -q 'plugin host is not healthy' "$tmp/out3" || { cat "$tmp/out3" >&2; echo 'No warning for an unhealthy plugin host.' >&2; exit 1; }
[ "$(git rev-parse HEAD)" = "$(git rev-parse v0.6.1.1^{commit})" ] || { echo 'The update was rolled back for a plugin host problem.' >&2; exit 1; }
echo 'PASS update flow smoke: plugin host rebuilt on update, rollback skips services the old release lacks, unhealthy plugin host only warns.'
