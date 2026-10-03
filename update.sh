#!/bin/sh
set -eu

usage(){ echo 'Usage: sh ./update.sh [vX.Y.Z[.N]] [--check]'; }
target=
check_only=0
for arg in "$@"; do
  case "$arg" in
    --check) check_only=1 ;;
    -h|--help) usage; exit 0 ;;
    v[0-9]*.[0-9]*.[0-9]*) [ -z "$target" ] || { usage >&2; exit 2; }; target=$arg ;;
    *) echo "Invalid release version: $arg" >&2; usage >&2; exit 2 ;;
  esac
done
if [ ! -d .git ]; then echo 'Run the updater from a Git checkout of Fledge.' >&2; exit 2; fi
command -v git >/dev/null 2>&1 || { echo 'Git is required.' >&2; exit 2; }
command -v docker >/dev/null 2>&1 || { echo 'Docker is required.' >&2; exit 2; }
docker compose version >/dev/null 2>&1 || { echo 'Docker Compose v2 is required.' >&2; exit 2; }
compose_version=$(docker compose version --short 2>/dev/null | sed 's/^v//')
compose_major=${compose_version%%.*}; compose_rest=${compose_version#*.}; compose_minor=${compose_rest%%.*}
case "$compose_major$compose_minor" in
  ''|*[!0-9]*) ;;
  *) if [ "$compose_major" -lt 2 ] || { [ "$compose_major" -eq 2 ] && [ "$compose_minor" -lt 20 ]; }; then echo "Docker Compose 2.20 or newer is required (found $compose_version). Update Docker." >&2; exit 2; fi ;;
esac
if [ -n "$(git status --porcelain)" ]; then echo 'Working tree has changes. Commit or stash them before updating.' >&2; exit 2; fi
previous=$(git rev-parse --verify HEAD)
if [ "$check_only" -eq 1 ]; then echo "Updater prerequisites passed. Current revision: $previous"; exit 0; fi
origin=$(git remote get-url origin 2>/dev/null || true)
[ -n "$origin" ] || { echo 'Git remote "origin" is required.' >&2; exit 2; }
if [ -z "$target" ]; then
  git fetch --tags origin
  target=$(git tag --list 'v[0-9]*' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+(\.[0-9]+)?$' | sort -V | tail -n 1 || true)
else
  git fetch --tags origin
fi
printf '%s\n' "$target" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+(\.[0-9]+)?(-[0-9A-Za-z.-]+)?$' || { echo 'No valid versioned release tag was found.' >&2; exit 2; }
git rev-parse --verify "refs/tags/$target" >/dev/null 2>&1 || { echo "Release tag $target was not fetched." >&2; exit 2; }
if [ "$(git rev-parse "refs/tags/$target^{commit}")" = "$previous" ]; then echo "Already running $target."; exit 0; fi
[ -f .env ] || { echo 'The Compose .env file is missing; run the installer first.' >&2; exit 2; }
mkdir -p .backups
chmod 700 .backups
stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup=".backups/fledge-db-$stamp.sql"
partial="$backup.partial"
env_backup=".backups/fledge-env-$stamp"
env_changed=0
cleanup(){ rm -f "$partial" "$env_backup.new"; if [ -f "$env_backup" ]; then rm -f "$env_backup"; fi; }
# Services rebuilt on every update. The plugin host only exists from 0.6.1.1 on, so ask the
# checked-out revision (this also keeps a rollback to an older release working).
app_services(){
  list='api web'
  if docker compose config --services 2>/dev/null | grep -qx plugins; then list="$list plugins"; fi
  printf '%s' "$list"
}
# The plugin host is optional for the panel: report it, but never fail or roll back an update for it.
plugins_healthy(){
  docker compose exec -T plugins node -e "fetch('http://127.0.0.1:4020/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1
}
trap cleanup EXIT HUP INT TERM
echo 'UPDATE_PROGRESS:backup'
docker compose exec -T postgres pg_dump -U fledge -d fledge > "$partial" || { echo 'Database backup failed; update stopped.' >&2; exit 3; }
[ -s "$partial" ] || { echo 'Database backup is empty; update stopped.' >&2; exit 3; }
chmod 600 "$partial"
mv "$partial" "$backup"
echo "Database backup saved: $backup"
echo 'UPDATE_PROGRESS:backup-complete'
cp -p .env "$env_backup"
chmod 600 "$env_backup"
version=${target#v}
if grep -q '^APP_VERSION=' .env; then sed "s/^APP_VERSION=.*/APP_VERSION=$version/" .env > "$env_backup.new"; else cat .env > "$env_backup.new"; printf '\nAPP_VERSION=%s\n' "$version" >> "$env_backup.new"; fi
chmod 600 "$env_backup.new"
mv "$env_backup.new" .env
env_changed=1
echo 'UPDATE_PROGRESS:installing'
if ! git checkout --detach "$target" || ! docker compose up -d --build $(app_services); then
  echo 'Update failed. Rebuilding the previous application revision.' >&2
  if [ "$env_changed" -eq 1 ]; then cp -p "$env_backup" .env; fi
  git checkout --detach "$previous" && docker compose up -d --build $(app_services) || echo 'Automatic code rollback failed; inspect Docker Compose and restore from the database backup if required.' >&2
  exit 4
fi
poll=${UPDATE_POLL_SECONDS:-5}
api_url=${API_HEALTH_URL:-http://127.0.0.1:4000/api/health}
web_url=${WEB_HEALTH_URL:-http://127.0.0.1:3000/}
echo 'UPDATE_PROGRESS:checking-health'
healthy=0
attempt=0
while [ "$attempt" -lt 36 ]; do
  if command -v curl >/dev/null 2>&1 && curl --fail --silent --max-time 3 "$api_url" >/dev/null && curl --fail --silent --max-time 3 "$web_url" >/dev/null; then healthy=1; break; fi
  attempt=$((attempt+1)); sleep "$poll"
done
if [ "$healthy" -ne 1 ]; then
  echo 'Health checks failed. Rebuilding the previous application revision.' >&2
  if [ "$env_changed" -eq 1 ]; then cp -p "$env_backup" .env; fi
  git checkout --detach "$previous" && docker compose up -d --build $(app_services) || echo 'Automatic code rollback failed; inspect Docker Compose and restore from the database backup if required.' >&2
  exit 5
fi
rm -f "$env_backup"
if docker compose config --services 2>/dev/null | grep -qx plugins; then
  plugins_ok=0
  attempt=0
  while [ "$attempt" -lt 12 ]; do
    if plugins_healthy; then plugins_ok=1; break; fi
    attempt=$((attempt+1)); sleep "$poll"
  done
  if [ "$plugins_ok" -eq 1 ]; then echo 'Plugin host is healthy.'; else echo 'Warning: the plugin host is not healthy yet. The panel works, but plugins are unavailable until it is (docker compose logs plugins).' >&2; fi
fi
ls -1t .backups/fledge-db-*.sql 2>/dev/null | tail -n +8 | while IFS= read -r old_backup; do rm -f "$old_backup"; done
echo "Fledge $target is healthy. PostgreSQL backup: $backup"
echo 'UPDATE_PROGRESS:complete'
