$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$temp = Join-Path ([IO.Path]::GetTempPath()) ("fledge-installer-test-" + [guid]::NewGuid().ToString('N'))
$project = Join-Path $temp 'project'
$mock = Join-Path $temp 'mock-bin'
New-Item -ItemType Directory -Force -Path $project,$mock | Out-Null
try {
    Copy-Item (Join-Path $root 'install.ps1'),(Join-Path $root 'compose.yaml'),(Join-Path $root '.env.example') -Destination $project
    $dockerCmd = Join-Path $mock 'docker.cmd'
    [IO.File]::WriteAllText($dockerCmd,"@echo off`r`necho %*>>`"%MOCK_LOG%`"`r`nexit /b 0`r`n",[Text.Encoding]::ASCII)
    $env:MOCK_LOG = Join-Path $temp 'docker.log'
    $env:PATH = "$mock;$env:PATH"
    $installer = Join-Path $project 'install.ps1'
    & $installer -CheckOnly
    if (Test-Path (Join-Path $project '.env')) { throw '--CheckOnly created .env.' }
    & $installer -NoWait
    $config = [IO.File]::ReadAllText((Join-Path $project '.env'))
    if ($config -notmatch '(?m)^POSTGRES_PASSWORD=[0-9a-f]{48}$') { throw 'Generated Windows database password is missing or malformed.' }
    if ($config -notmatch '(?m)^ENCRYPTION_KEY=[0-9a-f]{64}$') { throw 'Generated Windows encryption key is missing or malformed.' }
    if ($env:OS -eq 'Windows_NT' -and -not (Get-Acl -LiteralPath (Join-Path $project '.env')).AreAccessRulesProtected) { throw 'Windows .env ACL still inherits permissions.' }
    $key = [regex]::Match($config,'(?m)^ENCRYPTION_KEY=(.*)$').Groups[1].Value
    & $installer -NoWait
    if ([IO.File]::ReadAllText((Join-Path $project '.env')) -notmatch [regex]::Escape("ENCRYPTION_KEY=$key")) { throw 'Existing .env was changed.' }
    [IO.File]::WriteAllText((Join-Path $project '.env'),'POSTGRES_PASSWORD=REPLACE_WITH_secret`nENCRYPTION_KEY=REPLACE_WITH_key')
    try { & $installer -NoWait; throw 'Installer accepted placeholder secrets.' } catch { if ($_.Exception.Message -eq 'Installer accepted placeholder secrets.') { throw } }
    $upCalls = @(Get-Content $env:MOCK_LOG | Where-Object { $_ -eq 'compose up --build -d' }).Count
    if ($upCalls -ne 2) { throw "Expected 2 Compose starts, got $upCalls." }
    Write-Host 'PASS Windows installer smoke: check-only, cryptographic secret generation, existing env preservation, placeholder rejection.'
} finally {
    Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item Env:MOCK_LOG -ErrorAction SilentlyContinue
}
