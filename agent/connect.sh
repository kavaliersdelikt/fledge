#!/bin/sh
set -eu

API_URL=
NODE_ID=
REPOSITORY=
ALLOW_HTTP=0
VALIDATE_ONLY=0
FOREGROUND=0

usage() {
  cat <<'EOF'
Fledge Linux node connector
Usage: sudo sh connect.sh --api https://panel.example.com --node NODE_UUID --repo OWNER/REPOSITORY [--allow-insecure-http] [--foreground] [--validate-only]

The one-time enrollment token is requested through a hidden terminal prompt and is never placed in the command line or saved to the service environment.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --api) [ "$#" -ge 2 ] || { usage >&2; exit 2; }; API_URL=$2; shift 2 ;;
    --node) [ "$#" -ge 2 ] || { usage >&2; exit 2; }; NODE_ID=$2; shift 2 ;;
    --repo) [ "$#" -ge 2 ] || { usage >&2; exit 2; }; REPOSITORY=$2; shift 2 ;;
    --allow-insecure-http) ALLOW_HTTP=1; shift ;;
    --foreground) FOREGROUND=1; shift ;;
    --validate-only) VALIDATE_ONLY=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

case "$API_URL" in
  https://[A-Za-z0-9._:/-]*) ;;
  http://[A-Za-z0-9._:/-]*) [ "$ALLOW_HTTP" -eq 1 ] || { echo 'HTTP requires --allow-insecure-http and is for isolated local evaluation only.' >&2; exit 2; } ;;
  *) echo 'API URL must be an HTTPS URL (or explicitly allowed local HTTP URL), without query or fragment.' >&2; exit 2 ;;
esac
case "$NODE_ID" in
  ????????-????-????-????-????????????) case "$NODE_ID" in *[!A-Fa-f0-9-]*) echo 'Node ID must be a UUID.' >&2; exit 2 ;; esac ;;
  *) echo 'Node ID must be a UUID.' >&2; exit 2 ;;
esac
case "$REPOSITORY" in
  */*) owner=${REPOSITORY%%/*}; name=${REPOSITORY#*/} ;;
  *) echo 'Repository must be OWNER/REPOSITORY.' >&2; exit 2 ;;
esac
[ -n "$owner" ] && [ -n "$name" ] || { echo 'Repository must be OWNER/REPOSITORY.' >&2; exit 2; }
case "$owner$name" in *[!A-Za-z0-9_.-]*|*/*|*'..'*) echo 'Invalid GitHub repository name.' >&2; exit 2 ;; esac

if [ "$VALIDATE_ONLY" -eq 1 ]; then
  echo 'Connector arguments are valid. No network, token, or host changes were made.'
  exit 0
fi

[ "$(uname -s)" = Linux ] || { echo 'The Fledge agent requires Linux. On Windows, run this connector through WSL2; macOS nodes are not supported.' >&2; exit 10; }
case "$(uname -m)" in x86_64|amd64) ASSET=fledge-agent_linux_amd64 ;; aarch64|arm64) ASSET=fledge-agent_linux_arm64 ;; *) echo 'Supported Linux architectures are amd64 and arm64.' >&2; exit 11 ;; esac
[ "$(id -u)" -eq 0 ] || { echo 'Run with sudo so the agent can install its service and manage Docker-owned server files.' >&2; exit 12; }
command -v curl >/dev/null 2>&1 || { echo 'curl is required.' >&2; exit 13; }
command -v docker >/dev/null 2>&1 || { echo 'Docker CLI is required.' >&2; exit 15; }
command -v sha256sum >/dev/null 2>&1 || { echo 'sha256sum is required to verify the downloaded agent.' >&2; exit 17; }
command -v stty >/dev/null 2>&1 || { echo 'stty is required to securely prompt for the one-time token.' >&2; exit 17; }
docker info >/dev/null 2>&1 || { echo 'Docker is not reachable. Start Docker Engine and retry.' >&2; exit 18; }
if [ "$FOREGROUND" -eq 0 ]; then
  command -v systemctl >/dev/null 2>&1 || { echo 'systemd is required for background service installation. On WSL2, enable systemd in /etc/wsl.conf or use --foreground for a temporary session.' >&2; exit 16; }
  systemctl show-environment >/dev/null 2>&1 || { echo 'systemd is not running. Enable it in /etc/wsl.conf and restart WSL, or use --foreground for a temporary session.' >&2; exit 19; }
fi

API_URL=${API_URL%/}
tmp=$(mktemp -d)
tty_hidden=0
cleanup() { if [ "$tty_hidden" -eq 1 ]; then stty echo </dev/tty 2>/dev/null || true; fi; rm -rf "$tmp"; }
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
release_base="https://github.com/$REPOSITORY/releases/latest/download"
curl --location --proto '=https' --proto-redir '=https' --tlsv1.2 --fail --silent --show-error "$release_base/$ASSET" -o "$tmp/$ASSET" || { echo 'Could not fetch the latest GitHub agent release. Confirm that a Fledge release has been published.' >&2; exit 20; }
curl --location --proto '=https' --proto-redir '=https' --tlsv1.2 --fail --silent --show-error "$release_base/SHA256SUMS" -o "$tmp/SHA256SUMS" || { echo 'The latest release has no downloadable SHA256SUMS file.' >&2; exit 21; }
checksum_line=$(grep -F "  $ASSET" "$tmp/SHA256SUMS" || true)
[ -n "$checksum_line" ] && (cd "$tmp" && printf '%s\n' "$checksum_line" | sha256sum --check --status) || { echo 'Agent checksum verification failed; no service was installed.' >&2; exit 22; }

if [ ! -r /dev/tty ]; then echo 'A terminal is required for the hidden one-time token prompt.' >&2; exit 23; fi
printf 'Paste the one-time token shown in the panel (input is hidden): ' >/dev/tty
stty -echo </dev/tty
tty_hidden=1
if ! IFS= read -r ENROLLMENT_TOKEN </dev/tty; then echo 'Could not read the enrollment token.' >&2; exit 23; fi
stty echo </dev/tty
tty_hidden=0
printf '\n' >/dev/tty
case "$ENROLLMENT_TOKEN" in ''|*[!A-Za-z0-9_-]*) echo 'Enrollment token is empty or has invalid characters.' >&2; exit 24 ;; esac

install -d -m 0755 /usr/local/bin /etc/fledge /var/lib/fledge /var/lib/fledge/servers
install -m 0755 "$tmp/$ASSET" /usr/local/bin/fledge-agent
umask 077
credential_file=/etc/fledge/agent.credential
env_file=/etc/fledge/agent.env
if [ "$ALLOW_HTTP" -eq 1 ]; then ALLOW_LINE='ALLOW_INSECURE_HTTP=true'; else ALLOW_LINE=''; fi
printf 'API_URL=%s\nNODE_ID=%s\nDATA_ROOT=/var/lib/fledge/servers\nCREDENTIAL_FILE=%s\n%s\n' "$API_URL" "$NODE_ID" "$credential_file" "$ALLOW_LINE" > "$env_file"
chmod 600 "$env_file"
payload=$(printf '{"nodeId":"%s","token":"%s"}' "$NODE_ID" "$ENROLLMENT_TOKEN")
unset ENROLLMENT_TOKEN
enrollment_protocol='=https'
if [ "$ALLOW_HTTP" -eq 1 ]; then enrollment_protocol='=https,http'; fi
printf '%s' "$payload" | curl --proto "$enrollment_protocol" --tlsv1.2 --fail --silent --show-error -H 'Content-Type: application/json' --data-binary @- "$API_URL/api/agent/enroll" -o "$tmp/enrollment.json" || { echo 'Enrollment failed. The token may have expired or already been used; generate a fresh token in the panel.' >&2; rm -f "$env_file"; exit 25; }
credential=$(sed -n 's/.*"credential"[[:space:]]*:[[:space:]]*"\([A-Za-z0-9_-][A-Za-z0-9_-]*\)".*/\1/p' "$tmp/enrollment.json")
[ -n "$credential" ] || { echo 'Enrollment response did not contain a credential.' >&2; rm -f "$env_file"; exit 26; }
printf '%s\n' "$credential" > "$credential_file"
chmod 600 "$credential_file"
unset credential payload
if [ "$FOREGROUND" -eq 1 ]; then
  echo 'Node enrolled. The agent is running in this terminal; press Ctrl+C to stop it.'
  if [ "$ALLOW_HTTP" -eq 1 ]; then export ALLOW_INSECURE_HTTP=true; fi
  export API_URL NODE_ID DATA_ROOT=/var/lib/fledge/servers CREDENTIAL_FILE="$credential_file"
  exec /usr/local/bin/fledge-agent
fi
cat > /etc/systemd/system/fledge-agent.service <<'EOF'
[Unit]
Description=Fledge game server node agent
After=network-online.target docker.service
Wants=network-online.target
Requires=docker.service

[Service]
Type=simple
EnvironmentFile=/etc/fledge/agent.env
ExecStart=/usr/local/bin/fledge-agent
Restart=always
RestartSec=5
UMask=0077

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now fledge-agent.service
echo 'Node enrolled and fledge-agent.service is running. The one-time token was not saved.'
