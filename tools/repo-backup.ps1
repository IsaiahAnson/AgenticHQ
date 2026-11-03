# Creates local Git bundles in the backup folder and optionally proves they restore.
# os-config.json "backup": root (the folder; a second drive is best) and repos (repo folder names next to this
# HQ folder). Without it, this HQ repo goes to ~\AgenticHQ-backups. tools/hq-doctor.mjs checks the same folder.
# The scheduled restore task runs weekly but exits unless today is the first Sunday.
[CmdletBinding()]
param([switch]$RestoreTest, [switch]$FirstSundayOnly)

Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'

$hq = Split-Path $PSScriptRoot -Parent
$backupRoot = Join-Path $env:USERPROFILE 'AgenticHQ-backups'
$repoNames = @(Split-Path $hq -Leaf)
$config = Get-Content -Raw -LiteralPath (Join-Path $hq 'os-config.json') | ConvertFrom-Json
if ($config.PSObject.Properties['backup']) {
    $backup = $config.backup
    if ($backup.PSObject.Properties['root'] -and $backup.root) { $backupRoot = $backup.root }
    if ($backup.PSObject.Properties['repos'] -and $backup.repos) { $repoNames = @($backup.repos) }
}
$repos = @($repoNames | ForEach-Object { Join-Path (Split-Path $hq -Parent) $_ })

if ($FirstSundayOnly -and ((Get-Date).Day -gt 7 -or (Get-Date).DayOfWeek -ne [DayOfWeek]::Sunday)) {
    Write-Host 'Restore test skipped: today is not the first Sunday of the month.'
    exit 0
}
$drive = [IO.Path]::GetPathRoot($backupRoot)
if (-not (Test-Path -LiteralPath $drive)) { throw "Backup drive $drive is not available." }
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'git was not found on PATH.' }

function Invoke-Git {
    param([string[]]$Arguments, [string]$Failure)
    & git @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Failure (git exit $LASTEXITCODE)" }
}

function Format-Size {
    param([long]$Bytes)
    if ($Bytes -ge 1GB) { return ('{0:N2} GB' -f ($Bytes / 1GB)) }
    if ($Bytes -ge 1MB) { return ('{0:N2} MB' -f ($Bytes / 1MB)) }
    return ('{0:N1} KB' -f ($Bytes / 1KB))
}

$bundles = @()
foreach ($repo in $repos) {
    if (-not (Test-Path -LiteralPath (Join-Path $repo '.git'))) { throw "Not a local Git repository: $repo" }
    $name = Split-Path $repo -Leaf
    $dir = Join-Path $backupRoot $name
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    $bundle = Join-Path $dir ("{0}-{1}.bundle" -f $name, (Get-Date -Format 'yyyyMMdd'))
    $temporary = Join-Path $dir (".{0}.{1}.tmp" -f $name, [Guid]::NewGuid().ToString('N'))
    try {
        Invoke-Git -Arguments @('-C', $repo, 'bundle', 'create', $temporary, '--all') -Failure "Bundle creation failed for $name"
        Invoke-Git -Arguments @('bundle', 'verify', $temporary) -Failure "Bundle verification failed for $name"
        Move-Item -LiteralPath $temporary -Destination $bundle -Force
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
    }
    Get-ChildItem -LiteralPath $dir -File -Filter '*.bundle' |
        Sort-Object Name -Descending |
        Select-Object -Skip 8 |
        ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force }
    $item = Get-Item -LiteralPath $bundle
    $bundles += [pscustomobject]@{ Repo = $name; Path = $bundle; Bytes = $item.Length }
    Write-Host ("BACKUP {0}: {1} ({2})" -f $name, $bundle, (Format-Size $item.Length))
}

if ($RestoreTest) {
    $tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    $restoreRoot = Join-Path $tempBase ('hq-backup-restore-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $restoreRoot | Out-Null
    try {
        foreach ($row in $bundles) {
            $clone = Join-Path $restoreRoot $row.Repo
            Invoke-Git -Arguments @('clone', '--quiet', $row.Path, $clone) -Failure "Restore clone failed for $($row.Repo)"
            Invoke-Git -Arguments @('-C', $clone, 'fsck', '--full') -Failure "Restored repository failed fsck for $($row.Repo)"
            if ($row.Repo -eq 'rubric-agentic-os-v2') {
                Push-Location $clone
                try {
                    & node --test
                    if ($LASTEXITCODE -ne 0) { throw "Restored HQ tests failed (node exit $LASTEXITCODE)" }
                } finally { Pop-Location }
            }
            Write-Host "RESTORE PASS $($row.Repo)"
        }
    } finally {
        $resolved = [IO.Path]::GetFullPath($restoreRoot)
        if ($resolved.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase) -and (Split-Path $resolved -Leaf) -like 'hq-backup-restore-*') {
            Remove-Item -LiteralPath $resolved -Recurse -Force
        } else { Write-Warning "Refused to remove unexpected restore path: $resolved" }
    }
}

Write-Host ("Completed {0} verified bundles{1}." -f $bundles.Count, $(if ($RestoreTest) { ' and restore tests' } else { '' }))
