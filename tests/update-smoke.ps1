$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$temp = Join-Path ([IO.Path]::GetTempPath()) ("navrylo-updater-test-" + [guid]::NewGuid().ToString('N'))
$repo = Join-Path $temp 'repo'; $mock = Join-Path $temp 'mock-bin'
New-Item -ItemType Directory -Force -Path $repo,$mock | Out-Null
$oldPath = $env:PATH
try {
    Copy-Item (Join-Path $root 'update.ps1') -Destination $repo
    [IO.File]::WriteAllText((Join-Path $mock 'docker.cmd'),"@echo off`r`nexit /b 0`r`n",[Text.Encoding]::ASCII)
    $env:PATH = "$mock;$oldPath"
    Push-Location $repo
    & git init -q
    & git config user.email navrylo-test@example.test
    & git config user.name Fledge-Test
    [IO.File]::WriteAllText((Join-Path $repo 'README.md'),'fixture')
    & git add README.md update.ps1
    & git commit -qm fixture
    & (Join-Path $repo 'update.ps1') -CheckOnly
    try { & (Join-Path $repo 'update.ps1') -Version 'not-a-version'; throw 'Updater accepted an invalid version.' }
    catch { if ($_.Exception.Message -eq 'Updater accepted an invalid version.') { throw } }
    [IO.File]::AppendAllText((Join-Path $repo 'README.md'),'dirty')
    try { & (Join-Path $repo 'update.ps1') -CheckOnly; throw 'Updater accepted a dirty checkout.' }
    catch { if ($_.Exception.Message -eq 'Updater accepted a dirty checkout.') { throw } }
    Write-Host 'PASS Windows updater smoke: clean checkout preflight, invalid version and dirty-tree rejection.'
} finally {
    Pop-Location -ErrorAction SilentlyContinue
    $env:PATH = $oldPath
    Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
