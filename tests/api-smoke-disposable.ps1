$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dbName = 'navrylo-smoke-' + [guid]::NewGuid().ToString('N').Substring(0,10)
$stdout = [IO.Path]::GetTempFileName(); $stderr = [IO.Path]::GetTempFileName()
$apiProcess = $null; $startedDb = $false
$envKeys = @('DATABASE_URL','ENCRYPTION_KEY','WEB_ORIGIN','PORT','TEST_API_URL','GITHUB_REPOSITORY','GITHUB_TOKEN','S3_BUCKET','S3_ACCESS_KEY','S3_SECRET_KEY','S3_REGION','S3_ENDPOINT','FLEDGE_SMOKE_S3')
$savedEnv = @{}; foreach ($key in $envKeys) { $savedEnv[$key] = [Environment]::GetEnvironmentVariable($key,'Process') }
try {
    $dbId = & docker run -d --name $dbName -e POSTGRES_DB=navrylo_ci -e POSTGRES_USER=navrylo_ci -e POSTGRES_PASSWORD=ci_test_password_only -p '127.0.0.1::5432' --health-cmd 'pg_isready -U navrylo_ci -d navrylo_ci' --health-interval 2s --health-timeout 3s --health-retries 30 postgres:16-alpine
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the disposable PostgreSQL container.' }; $startedDb = $true
    $dbPort = $null
    for ($i=0; $i -lt 60; $i++) { & docker exec $dbName pg_isready -U navrylo_ci -d navrylo_ci *> $null; if ($LASTEXITCODE -eq 0) { $map = & docker port $dbName 5432/tcp; $dbPort = [int](($map -split ':')[-1]); break }; Start-Sleep -Seconds 1 }
    if (-not $dbPort) { throw 'Disposable PostgreSQL did not become ready.' }
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0); $listener.Start(); $apiPort = $listener.LocalEndpoint.Port; $listener.Stop()
    $env:DATABASE_URL = "postgres://navrylo_ci:ci_test_password_only@127.0.0.1:$dbPort/navrylo_ci"
    $env:ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
    $env:WEB_ORIGIN = 'http://localhost:3000'; $env:PORT = [string]$apiPort
    $env:TEST_API_URL = "http://127.0.0.1:$apiPort"; $env:GITHUB_REPOSITORY = 'kavaliersdelikt/fledge'; $env:GITHUB_TOKEN = ''
    if ($env:FLEDGE_SMOKE_S3 -eq 'true') {
        foreach ($key in @('S3_BUCKET','S3_ACCESS_KEY','S3_SECRET_KEY')) { if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($key,'Process'))) { throw "S3 integration mode requires $key." } }
        if ([string]::IsNullOrWhiteSpace($env:S3_ENDPOINT)) { throw 'S3 integration mode requires S3_ENDPOINT.' }
        if (-not $env:S3_REGION) { $env:S3_REGION = 'us-east-1' }
    } else {
        foreach ($key in @('S3_BUCKET','S3_ACCESS_KEY','S3_SECRET_KEY','S3_ENDPOINT','S3_REGION')) { [Environment]::SetEnvironmentVariable($key,'','Process') }
    }
    $apiDir = Join-Path $root 'api'; $node = (Get-Command node.exe).Source
    $apiProcess = Start-Process -FilePath $node -ArgumentList @('--import','tsx','src/index.ts') -WorkingDirectory $apiDir -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    $ready = $false
    for ($i=0; $i -lt 60; $i++) { try { $health=Invoke-RestMethod -UseBasicParsing -Uri "http://127.0.0.1:$apiPort/api/health" -TimeoutSec 2; $ready=$true; break } catch { if ($apiProcess.HasExited) { break }; Start-Sleep -Seconds 1 } }
    if (-not $ready) { throw "Disposable API did not become healthy. $([IO.File]::ReadAllText($stderr))" }
    Push-Location $apiDir
    try { & $node 'test/smoke.mjs'; if ($LASTEXITCODE -ne 0) { throw "API smoke suite failed with exit code $LASTEXITCODE." } }
    finally { Pop-Location }
} finally {
    if ($apiProcess -and -not $apiProcess.HasExited) { Stop-Process -Id $apiProcess.Id -Force -ErrorAction SilentlyContinue }
    if ($startedDb) { & docker rm -f $dbName *> $null }
    foreach ($key in $envKeys) { [Environment]::SetEnvironmentVariable($key,$savedEnv[$key],'Process') }
    Remove-Item -LiteralPath $stdout,$stderr -Force -ErrorAction SilentlyContinue
}
