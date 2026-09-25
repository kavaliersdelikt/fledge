[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ApiUrl,
    [Parameter(Mandatory = $true)][string]$NodeId,
    [Parameter(Mandatory = $true)][string]$Repository,
    [string]$Distro = 'Ubuntu-24.04',
    [switch]$AllowInsecureHttp,
    [switch]$ValidateOnly
)

$ErrorActionPreference = 'Stop'
if ($NodeId -notmatch '^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$') { throw 'NodeId must be a UUID.' }
if ($Repository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' -or $Repository.Contains('..')) { throw 'Repository must be OWNER/REPOSITORY.' }
$uri = $null
if (-not [Uri]::TryCreate($ApiUrl, [UriKind]::Absolute, [ref]$uri)) { throw 'ApiUrl must be an absolute URL.' }
if ($uri.Scheme -ne 'https' -and -not ($uri.Scheme -eq 'http' -and $AllowInsecureHttp)) { throw 'HTTPS is required. HTTP is only allowed with -AllowInsecureHttp for isolated local evaluation.' }
if ($uri.Query -or $uri.Fragment -or $ApiUrl -match "['`r`n]") { throw 'ApiUrl cannot contain a query, fragment, quote, or newline.' }
if ($ValidateOnly) { Write-Host 'Connector arguments are valid. No WSL command, token, or host changes were made.'; exit 0 }

if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) { throw 'WSL is not installed. Install a WSL2 Linux distro and retry.' }
$distros = & wsl.exe --list --quiet
if ($LASTEXITCODE -ne 0 -or -not (($distros | ForEach-Object { $_.Trim() }) -contains $Distro)) { throw "WSL distro '$Distro' was not found. Check `wsl --list --verbose`." }

function ConvertTo-BashLiteral([string]$Value) { return "'" + $Value.Replace("'", "'\''") + "'" }
$repoLiteral = ConvertTo-BashLiteral $Repository
$apiLiteral = ConvertTo-BashLiteral $ApiUrl.TrimEnd('/')
$nodeLiteral = ConvertTo-BashLiteral $NodeId
$allow = if ($AllowInsecureHttp) { ' --allow-insecure-http' } else { '' }
$linuxScript = @"
set -eu
command -v curl >/dev/null 2>&1 || { echo 'Install curl inside the selected WSL distro first.' >&2; exit 10; }
connect_url="https://raw.githubusercontent.com/$Repository/main/agent/connect.sh"
temporary="`$(mktemp "`$HOME/fledge-connect.XXXXXX")"
trap 'rm -f "`$temporary"' EXIT HUP INT TERM
curl --proto '=https' --tlsv1.2 --fail --silent --show-error "`$connect_url" -o "`$temporary"
sudo sh "`$temporary" --api $apiLiteral --node $nodeLiteral --repo $repoLiteral --foreground$allow
"@
$linuxScript = $linuxScript.Replace("`r`n", "`n").Replace("`r", '')
$encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($linuxScript))
$launcher = "printf '%s' '$encoded' | base64 -d | bash"
Write-Host "Connecting node $NodeId through WSL distro $Distro. The one-time token will be requested privately in the Linux terminal."
& wsl.exe --distribution $Distro --exec bash -lc $launcher
if ($LASTEXITCODE -ne 0) { throw "WSL connector failed (exit code $LASTEXITCODE). Check Docker Desktop WSL integration and the API URL reachable from WSL." }
