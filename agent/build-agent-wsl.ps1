[CmdletBinding()]
param(
    [string]$Distro = 'Ubuntu',
    [string]$Architecture,
    [string]$OutputPath,
    [switch]$CheckDocker
)

$ErrorActionPreference = 'Stop'

function ConvertTo-BashLiteral([string]$Value) {
    return "'" + $Value.Replace("'", "'\''") + "'"
}

function Invoke-WslScript([string]$Distribution, [string]$Script) {
    # Base64 keeps PowerShell's native-argument quoting from altering the bash script.
    # Here-strings inherit Windows CRLFs, which Bash misreads as part of commands.
    $Script = $Script.Replace("`r`n", "`n").Replace("`r", '')
    $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Script))
    $launcher = "printf '%s' '$encoded' | base64 -d | bash"
    & wsl.exe --distribution $Distribution --exec bash -lc $launcher
    if ($LASTEXITCODE -ne 0) {
        throw "WSL command failed (exit code $LASTEXITCODE). Check the distribution name and WSL setup."
    }
}

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $OutputPath) {
    $OutputPath = Join-Path $PSScriptRoot 'dist/fledge-agent-linux'
}
$outputFullPath = [IO.Path]::GetFullPath($OutputPath)
$outputParent = Split-Path -Parent $outputFullPath
New-Item -ItemType Directory -Force -Path $outputParent | Out-Null

$repoLinux = (& wsl.exe --distribution $Distro --exec wslpath -a $repoRoot)
if ($LASTEXITCODE -ne 0 -or -not $repoLinux) {
    throw "Could not translate repo path into WSL. Keep the checkout on a local Windows drive and verify distro '$Distro' exists."
}
$repoLinux = ($repoLinux | Out-String).Trim()
$outputLinux = (& wsl.exe --distribution $Distro --exec wslpath -a $outputFullPath)
if ($LASTEXITCODE -ne 0 -or -not $outputLinux) {
    throw "Could not translate output path into WSL. Choose a path on a local Windows drive."
}
$outputLinux = ($outputLinux | Out-String).Trim()

if ($Architecture -and @('amd64', 'arm64') -notcontains $Architecture) {
    throw "Architecture must be amd64 or arm64."
}
if (-not $Architecture) {
    $machine = (& wsl.exe --distribution $Distro --exec uname -m)
    if ($LASTEXITCODE -ne 0) {
        throw "Could not detect the WSL Linux architecture."
    }
    switch (($machine | Out-String).Trim()) {
        'x86_64' { $Architecture = 'amd64' }
        'aarch64' { $Architecture = 'arm64' }
        default { throw "Unsupported WSL architecture '$machine'; specify a supported Linux target if appropriate." }
    }
}

$dockerCheck = ''
if ($CheckDocker) {
    $dockerCheck = @'
command -v docker >/dev/null 2>&1 || { echo 'Docker CLI is missing; enable Docker Desktop WSL Integration for this distro.' >&2; exit 20; }
docker version --format 'Docker Engine server: {{.Server.Version}}' || { echo 'Cannot reach Docker Desktop Linux engine from this distro.' >&2; exit 21; }
'@
}

$repoLiteral = ConvertTo-BashLiteral $repoLinux
$outputLiteral = ConvertTo-BashLiteral $outputLinux
$archLiteral = ConvertTo-BashLiteral $Architecture
$script = @"
set -eu
command -v go >/dev/null 2>&1 || { echo 'Go is missing in this WSL distro; install Go 1.19 or newer.' >&2; exit 10; }
go_version=`$(go env GOVERSION)
case "`$go_version" in
  go1.*) go_minor="`$go_version"; go_minor="`${go_minor#go1.}"; go_minor="`${go_minor%%.*}"; [ "`$go_minor" -ge 19 ] || { echo 'Go 1.19 or newer is required.' >&2; exit 11; } ;;
  *) echo 'Unable to verify Go version; install Go 1.19 or newer.' >&2; exit 12 ;;
esac
$dockerCheck
repo=$repoLiteral
out=$outputLiteral
arch=$archLiteral
mkdir -p "`$HOME/.cache" "`$(dirname "`$out")"
test -f "`$repo/agent/go.mod" || { echo 'Agent source not found under the translated repository path.' >&2; exit 13; }
stage=`$(mktemp -d "`$HOME/.cache/fledge-agent-build.XXXXXX")
trap 'rm -rf "`$stage"' EXIT
cp -a "`$repo/agent/." "`$stage/"
cd "`$stage"
GOOS=linux GOARCH="`$arch" CGO_ENABLED=0 go build -trimpath -o "`$stage/fledge-agent" .
install -m 0755 "`$stage/fledge-agent" "`$out"
printf 'Built Linux/%s agent at %s\n' "`$arch" "`$out"
"@

Invoke-WslScript -Distribution $Distro -Script $script
Write-Host "Linux agent built at: $outputFullPath"
Write-Host 'This is a Linux executable; install and run it inside the WSL Linux distro, not in Windows.'
