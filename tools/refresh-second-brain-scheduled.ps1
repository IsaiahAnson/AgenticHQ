param(
  [string]$BaseUrl = 'http://127.0.0.1:50000',
  [string]$EngineUrl = 'http://127.0.0.1:50201'
)

$ErrorActionPreference = 'Stop'
$kit = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $kit 'os-runs'
$logFile = Join-Path $logDir 'second-brain-scheduled.jsonl'
$started = [DateTime]::UtcNow
$record = [ordered]@{ at = $started.ToString('o'); ok = $false; refreshAt = $null; scannedAt = $null; totalFiles = $null; warnings = @(); audit = $null; error = $null }

try {
  $refresh = Invoke-RestMethod -Uri "$BaseUrl/local/refresh" -Method Post -TimeoutSec 240
  if (-not $refresh.ok -or @($refresh.steps).Count -ne 3 -or @($refresh.steps | Where-Object { -not $_.ok }).Count) {
    throw "Second Brain refresh failed: $($refresh | ConvertTo-Json -Compress -Depth 5)"
  }
  $record.refreshAt = $refresh.at

  $meta = Invoke-RestMethod -Uri "$EngineUrl/api/meta" -TimeoutSec 30
  $health = Invoke-RestMethod -Uri "$BaseUrl/api/health" -TimeoutSec 30
  $scanned = [DateTime]::Parse($meta.scannedAt).ToUniversalTime()
  $snapshot = Get-Item -LiteralPath (Join-Path $kit 'brain/snapshot.js')
  if ($scanned -lt $started -or $snapshot.LastWriteTimeUtc -lt $started -or -not $meta.workspaceSet -or $meta.totalFiles -le 0 -or -not $health.engine) {
    throw "Refresh completed but the engine did not confirm a fresh, populated scan"
  }
  $node = (Get-Command node -ErrorAction Stop).Source
  $auditOutput = & $node (Join-Path $kit 'tools/hq-knowledge-audit.mjs') 2>&1
  if ($LASTEXITCODE -ne 0) { throw "Knowledge audit failed: $auditOutput" }
  $record.audit = ($auditOutput | Out-String).Trim()
  $record.scannedAt = $meta.scannedAt
  $record.totalFiles = $meta.totalFiles
  $record.warnings = @($meta.warnings)
  $record.ok = $true
} catch {
  $record.error = $_.Exception.Message
} finally {
  New-Item -ItemType Directory -Path $logDir -Force | Out-Null
  Add-Content -LiteralPath $logFile -Value ($record | ConvertTo-Json -Compress -Depth 5) -Encoding UTF8
}

function Send-HqEvent([string]$type, [string]$severity, [string]$summary) {
  try {
    $body = @{ type = $type; source = 'brain-refresh-schedule'; severity = $severity; key = "$type`:$($started.ToString('yyyyMMddHH'))"; summary = $summary; ref = 'os-runs/second-brain-scheduled.jsonl'; data = @{ scannedAt = $record.scannedAt; totalFiles = $record.totalFiles } } | ConvertTo-Json -Compress -Depth 4
    Invoke-RestMethod -Uri "$BaseUrl/local/event" -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 5 | Out-Null
  } catch {
    # Event delivery is best-effort. A stopped HQ must not replace the refresh result.
  }
}

if (-not $record.ok) {
  Send-HqEvent 'brain.refresh.failed' 'error' "Second Brain scheduled refresh failed: $($record.error)"
  Write-Error $record.error
  exit 1
}
Write-Output "Second Brain refreshed and verified: $($record.totalFiles) files; scanned $($record.scannedAt)"
Send-HqEvent 'brain.refresh.ok' 'info' "Second Brain refreshed and verified: $($record.totalFiles) files"
