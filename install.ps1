[CmdletBinding()]
param(
    [switch]$CheckOnly,
    [switch]$NoWait
)

$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($PSScriptRoot)

if (-not (Test-Path -LiteralPath (Join-Path $root 'compose.yaml') -PathType Leaf)) {
    throw 'compose.yaml was not found. Run this from a Fledge source checkout.'
}
if (-not (Test-Path -LiteralPath (Join-Path $root '.env.example') -PathType Leaf)) {
    throw '.env.example was not found.'
}
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw 'Docker is required. Install Docker Desktop and select Linux containers with the WSL 2 engine.'
}

& docker info *> $null
if ($LASTEXITCODE -ne 0) { throw 'Docker is installed but its engine is not running or reachable.' }
& docker compose version *> $null
if ($LASTEXITCODE -ne 0) { throw 'Docker Compose v2 is required: run docker compose version.' }
if ($CheckOnly) {
    Write-Host 'Install prerequisites are ready. No files or containers were changed.'
    exit 0
}

$envPath = Join-Path $root '.env'
if (Test-Path -LiteralPath $envPath -PathType Leaf) {
    $config = [IO.File]::ReadAllText($envPath)
    if ($config -match '(?m)REPLACE_WITH_|^POSTGRES_PASSWORD\s*=\s*$|^ENCRYPTION_KEY\s*=\s*$') {
        throw '.env contains placeholder or empty required secrets. Edit it first; the installer will not replace an existing .env.'
    }
    Write-Host 'Using the existing .env without modifying it.'
} else {
    $templatePath = Join-Path $root '.env.example'
    $config = [IO.File]::ReadAllText($templatePath)
    $passwordBytes = New-Object byte[] 24
    $keyBytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($passwordBytes); $rng.GetBytes($keyBytes) } finally { $rng.Dispose() }
    $password = [BitConverter]::ToString($passwordBytes).Replace('-', '').ToLowerInvariant()
    $key = [BitConverter]::ToString($keyBytes).Replace('-', '').ToLowerInvariant()
    $config = [regex]::Replace($config, '(?m)^POSTGRES_PASSWORD=.*$', "POSTGRES_PASSWORD=$password")
    $config = [regex]::Replace($config, '(?m)^ENCRYPTION_KEY=.*$', "ENCRYPTION_KEY=$key")
    if ($config -match '(?m)REPLACE_WITH_|^POSTGRES_PASSWORD\s*=\s*$|^ENCRYPTION_KEY\s*=\s*$') {
        throw '.env.example is missing a required secret setting.'
    }
    $encoding = New-Object System.Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($envPath, $config, $encoding)
    if ($env:OS -eq 'Windows_NT') {
        $acl = Get-Acl -LiteralPath $envPath
        $acl.SetAccessRuleProtection($true, $false)
        $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
        $rule = [Security.AccessControl.FileSystemAccessRule]::new($currentSid,'FullControl','Allow')
        [void]$acl.AddAccessRule($rule)
        Set-Acl -LiteralPath $envPath -AclObject $acl
    }
    Write-Host 'Created .env with random database and encryption secrets. Keep this file private.'
}

Push-Location $root
try {
    & docker compose up --build -d
    if ($LASTEXITCODE -ne 0) { throw 'Docker Compose failed. Inspect the output above and run docker compose logs.' }
} finally { Pop-Location }

if ($NoWait) {
    Write-Host 'Compose started. Panel: http://localhost:3000  API: http://localhost:4000/api/health'
    exit 0
}

function Test-LocalHttpEndpoint([string]$Uri) {
    $request = $null
    $response = $null
    try {
        $request = [System.Net.HttpWebRequest]::Create($Uri)
        $request.Proxy = $null
        $request.Timeout = 2000
        $request.ReadWriteTimeout = 2000
        $response = $request.GetResponse()
        return [int]$response.StatusCode -ge 200 -and [int]$response.StatusCode -lt 300
    } catch {
        if ($_.Exception.Response) { $_.Exception.Response.Close() }
        return $false
    } finally {
        if ($response) { $response.Close() }
    }
}

$deadline = [DateTime]::UtcNow.AddMinutes(5)
while ([DateTime]::UtcNow -lt $deadline -and -not (Test-LocalHttpEndpoint 'http://localhost:4000/api/health')) {
    Start-Sleep -Seconds 2
}
if (-not (Test-LocalHttpEndpoint 'http://localhost:4000/api/health')) {
    throw 'The API did not become healthy within 5 minutes. Check docker compose logs api.'
}

$deadline = [DateTime]::UtcNow.AddMinutes(5)
while ([DateTime]::UtcNow -lt $deadline -and -not (Test-LocalHttpEndpoint 'http://localhost:3000/')) {
    Start-Sleep -Seconds 2
}
if (-not (Test-LocalHttpEndpoint 'http://localhost:3000/')) {
    throw 'The panel did not become healthy within 5 minutes. Check docker compose logs web.'
}
Write-Host 'Fledge is ready at http://localhost:3000. The first visit creates the administrator and enrolls two-factor authentication.'
