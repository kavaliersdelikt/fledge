#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
mkdir -p "$tmp/repo" "$tmp/mock-bin"
cp "$root/update.sh" "$tmp/repo/update.sh"
cat > "$tmp/mock-bin/docker" <<'EOF'
#!/bin/sh
[ "$1 $2" = 'compose version' ] || exit 2
exit 0
EOF
chmod +x "$tmp/mock-bin/docker"
cd "$tmp/repo"
git init -q
git config user.email navrylo-test@example.test
git config user.name Fledge-Test
printf 'fixture\n' > README.md
git add README.md update.sh
git commit -qm fixture
PATH="$tmp/mock-bin:$PATH" sh ./update.sh --check
if PATH="$tmp/mock-bin:$PATH" sh ./update.sh not-a-version >/dev/null 2>&1; then echo 'Updater accepted an invalid version.' >&2; exit 1; fi
printf 'dirty\n' >> README.md
if PATH="$tmp/mock-bin:$PATH" sh ./update.sh --check >/dev/null 2>&1; then echo 'Updater accepted a dirty checkout.' >&2; exit 1; fi
echo 'PASS update shell smoke: clean checkout preflight, invalid version and dirty-tree rejection.'
