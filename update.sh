#!/bin/sh
set -eu

usage(){ echo 'Usage: sh ./update.sh [vX.Y.Z] [--check]'; }
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
if [ ! -d .git ]; then echo 'Run the updater from a Git checkout of Navrylo.' >&2; exit 2; fi
command -v git >/dev/null 2>&1 || { echo 'Git is required.' >&2; exit 2; }
command -v docker >/dev/null 2>&1 || { echo 'Docker is required.' >&2; exit 2; }
docker compose version >/dev/null 2>&1 || { echo 'Docker Compose v2 is required.' >&2; exit 2; }
if [ -n "$(git status --porcelain)" ]; then echo 'Working tree has changes. Commit or stash them before updating.' >&2; exit 2; fi
previous=$(git rev-parse --verify HEAD)
if [ "$check_only" -eq 1 ]; then echo "Updater prerequisites passed. Current revision: $previous"; exit 0; fi
origin=$(git remote get-url origin 2>/dev/null || true)
[ -n "$origin" ] || { echo 'Git remote "origin" is required.' >&2; exit 2; }
if [ -z "$target" ]; then
  git fetch --tags origin
  target=$(git tag --list 'v[0-9]*' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -n 1 || true)
else
  git fetch --tags origin
fi
printf '%s\n' "$target" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$' || { echo 'No valid versioned release tag was found.' >&2; exit 2; }
git rev-parse --verify "refs/tags/$target" >/dev/null 2>&1 || { echo "Release tag $target was not fetched." >&2; exit 2; }
if [ "$(git rev-parse "refs/tags/$target^{commit}")" = "$previous" ]; then echo "Already running $target."; exit 0; fi
[ -f .env ] || { echo 'The Compose .env file is missing; run the installer first.' >&2; exit 2; }
mkdir -p .backups
chmod 700 .backups
stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup=".backups/navrylo-db-$stamp.sql"
partial="$backup.partial"
env_backup=".backups/navrylo-env-$stamp"
env_changed=0
cleanup(){ rm -f "$partial" "$env_backup.new"; if [ -f "$env_backup" ]; then rm -f "$env_backup"; fi; }
trap cleanup EXIT HUP INT TERM
docker compose exec -T postgres pg_dump -U navrylo -d navrylo > "$partial" || { echo 'Database backup failed; update stopped.' >&2; exit 3; }
[ -s "$partial" ] || { echo 'Database backup is empty; update stopped.' >&2; exit 3; }
chmod 600 "$partial"
mv "$partial" "$backup"
echo "Database backup saved: $backup"
cp -p .env "$env_backup"
chmod 600 "$env_backup"
version=${target#v}
if grep -q '^APP_VERSION=' .env; then sed "s/^APP_VERSION=.*/APP_VERSION=$version/" .env > "$env_backup.new"; else cat .env > "$env_backup.new"; printf '\nAPP_VERSION=%s\n' "$version" >> "$env_backup.new"; fi
chmod 600 "$env_backup.new"
mv "$env_backup.new" .env
env_changed=1
if ! git checkout --detach "$target" || ! docker compose up -d --build; then
  echo 'Update failed. Rebuilding the previous application revision.' >&2
  if [ "$env_changed" -eq 1 ]; then cp -p "$env_backup" .env; fi
  git checkout --detach "$previous" && docker compose up -d --build || echo 'Automatic code rollback failed; inspect Docker Compose and restore from the database backup if required.' >&2
  exit 4
fi
api_url=${API_HEALTH_URL:-http://127.0.0.1:4000/api/health}
web_url=${WEB_HEALTH_URL:-http://127.0.0.1:3000/}
healthy=0
attempt=0
while [ "$attempt" -lt 36 ]; do
  if command -v curl >/dev/null 2>&1 && curl --fail --silent --max-time 3 "$api_url" >/dev/null && curl --fail --silent --max-time 3 "$web_url" >/dev/null; then healthy=1; break; fi
  attempt=$((attempt+1)); sleep 5
done
if [ "$healthy" -ne 1 ]; then
  echo 'Health checks failed. Rebuilding the previous application revision.' >&2
  if [ "$env_changed" -eq 1 ]; then cp -p "$env_backup" .env; fi
  git checkout --detach "$previous" && docker compose up -d --build || echo 'Automatic code rollback failed; inspect Docker Compose and restore from the database backup if required.' >&2
  exit 5
fi
rm -f "$env_backup"
ls -1t .backups/navrylo-db-*.sql 2>/dev/null | tail -n +8 | while IFS= read -r old_backup; do rm -f "$old_backup"; done
echo "Navrylo $target is healthy. PostgreSQL backup: $backup"
