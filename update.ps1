[CmdletBinding()]
param([string]$Version, [switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
function Invoke-Git([string[]]$GitArgs) { & git @GitArgs; if ($LASTEXITCODE -ne 0) { throw "git $($GitArgs -join ' ') failed with exit code $LASTEXITCODE" } }
function Invoke-Compose([string[]]$ComposeArgs) { & docker compose @ComposeArgs; if ($LASTEXITCODE -ne 0) { throw "docker compose $($ComposeArgs -join ' ') failed with exit code $LASTEXITCODE" } }
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot '.git'))) { throw 'Run the updater from a Git checkout of Fledge.' }
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'Git is required.' }
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'Docker is required.' }
& docker compose version *> $null; if ($LASTEXITCODE -ne 0) { throw 'Docker Compose v2 is required.' }
$status = & git status --porcelain; if ($LASTEXITCODE -ne 0) { throw 'Could not inspect Git working tree.' }; if ($status) { throw 'Working tree has changes. Commit or stash them before updating.' }
$previous = (& git rev-parse --verify HEAD).Trim(); if ($LASTEXITCODE -ne 0) { throw 'Could not read current Git revision.' }
if ($Version -and $Version -notmatch '^v\d+\.\d+\.\d+([.-][0-9A-Za-z.-]+)?$') { throw 'Version must look like v1.2.3.' }
if ($CheckOnly) { Write-Host "Updater prerequisites passed. Current revision: $previous"; exit 0 }
$remote = & git remote get-url origin 2>$null; if ($LASTEXITCODE -ne 0 -or -not $remote) { throw 'Git remote origin is required.' }
Invoke-Git @('fetch','--tags','origin')
if (-not $Version) { $Version = (& git tag --list 'v[0-9]*' | Where-Object { $_ -match '^v\d+\.\d+\.\d+$' } | Sort-Object { [version]($_ -replace '^v','') } -Descending | Select-Object -First 1) }
if (-not $Version -or $Version -notmatch '^v\d+\.\d+\.\d+([.-][0-9A-Za-z.-]+)?$') { throw 'No valid versioned release tag was found.' }
& git rev-parse --verify "refs/tags/$Version" *> $null; if ($LASTEXITCODE -ne 0) { throw "Release tag $Version was not fetched." }
$targetCommit = (& git rev-parse "refs/tags/${Version}^{commit}").Trim()
if ($targetCommit -eq $previous) { Write-Host "Already running $Version."; exit 0 }
$envPath = Join-Path $PSScriptRoot '.env'; if (-not (Test-Path -LiteralPath $envPath)) { throw 'The Compose .env file is missing; run the installer first.' }
$backupDir = Join-Path $PSScriptRoot '.backups'; New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
if ($env:OS -eq 'Windows_NT') {
  $acl = Get-Acl -LiteralPath $backupDir; $acl.SetAccessRuleProtection($true,$false)
  foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRule($rule) }
  foreach ($identity in @([Security.Principal.WindowsIdentity]::GetCurrent().Name,'NT AUTHORITY\SYSTEM','BUILTIN\Administrators')) {
    $rule = [Security.AccessControl.FileSystemAccessRule]::new($identity,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
    [void]$acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $backupDir -AclObject $acl
}
$stamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ'); $backup = Join-Path $backupDir "fledge-db-$stamp.sql"; $partial = "$backup.partial"
$envBackup = Join-Path $backupDir "fledge-env-$stamp"; $envChanged = $false
Copy-Item -LiteralPath $envPath -Destination $envBackup
if ($env:OS -eq 'Windows_NT') { $envAcl=Get-Acl -LiteralPath $envBackup; $envAcl.SetAccessRuleProtection($true,$false); foreach ($identity in @([Security.Principal.WindowsIdentity]::GetCurrent().Name,'NT AUTHORITY\SYSTEM','BUILTIN\Administrators')) { $rule=[Security.AccessControl.FileSystemAccessRule]::new($identity,'FullControl','Allow'); [void]$envAcl.AddAccessRule($rule) }; Set-Acl -LiteralPath $envBackup -AclObject $envAcl }
try {
  $errorFile = "$partial.stderr"
  Write-Output 'UPDATE_PROGRESS:backup'
  $process = Start-Process -FilePath (Get-Command docker).Source -ArgumentList 'compose exec -T postgres pg_dump -U fledge -d fledge' -NoNewWindow -Wait -PassThru -RedirectStandardOutput $partial -RedirectStandardError $errorFile
  if ($process.ExitCode -ne 0) { throw 'Database backup failed; update stopped.' }
  if (Test-Path -LiteralPath $errorFile) { Remove-Item -LiteralPath $errorFile -Force }
  if ((Get-Item -LiteralPath $partial).Length -eq 0) { throw 'Database backup is empty; update stopped.' }
  Move-Item -LiteralPath $partial -Destination $backup
  Write-Output 'UPDATE_PROGRESS:backup-complete'
  $config = [IO.File]::ReadAllText($envPath); $appVersion=$Version.TrimStart('v')
  if ($config -match '(?m)^APP_VERSION=') { $config=[regex]::Replace($config,'(?m)^APP_VERSION=.*$',"APP_VERSION=$appVersion") } else { $config=$config.TrimEnd()+"`nAPP_VERSION=$appVersion`n" }
  [IO.File]::WriteAllText($envPath,$config,[Text.UTF8Encoding]::new($false)); $envChanged=$true
  Invoke-Git @('checkout','--detach',$Version)
  Write-Output 'UPDATE_PROGRESS:installing'
  Invoke-Compose @('up','-d','--build','api','web')
  $apiUrl = if ($env:API_HEALTH_URL) { $env:API_HEALTH_URL } else { 'http://127.0.0.1:4000/api/health' }
  $webUrl = if ($env:WEB_HEALTH_URL) { $env:WEB_HEALTH_URL } else { 'http://127.0.0.1:3000/' }
  Write-Output 'UPDATE_PROGRESS:checking-health'
  $healthy = $false
  for ($i=0; $i -lt 36; $i++) { try { Invoke-WebRequest -UseBasicParsing -Uri $apiUrl -TimeoutSec 3 | Out-Null; Invoke-WebRequest -UseBasicParsing -Uri $webUrl -TimeoutSec 3 | Out-Null; $healthy=$true; break } catch { Start-Sleep -Seconds 5 } }
  if (-not $healthy) { throw 'Health checks failed.' }
  Remove-Item -LiteralPath $envBackup -Force
  Get-ChildItem -LiteralPath $backupDir -File -Filter 'fledge-db-*.sql' | Sort-Object LastWriteTime -Descending | Select-Object -Skip 7 | Remove-Item -Force
  Write-Host "Fledge $Version is healthy. PostgreSQL backup: $backup"
  Write-Output 'UPDATE_PROGRESS:complete'
} catch {
  if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial -Force }
  if (Test-Path -LiteralPath "$partial.stderr") { Remove-Item -LiteralPath "$partial.stderr" -Force }
  if ($envChanged -and (Test-Path -LiteralPath $envBackup)) { Copy-Item -LiteralPath $envBackup -Destination $envPath -Force }
  if (Test-Path -LiteralPath $envBackup) { Remove-Item -LiteralPath $envBackup -Force }
  if ((Get-Location).Path -ne $PSScriptRoot -or (& git rev-parse --verify HEAD 2>$null).Trim() -ne $previous) { try { Invoke-Git @('checkout','--detach',$previous); Invoke-Compose @('up','-d','--build','api','web') } catch { Write-Warning 'Automatic code rollback failed; inspect Docker Compose and restore from the database backup if required.' } }
  throw
}
