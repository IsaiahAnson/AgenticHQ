# Installs or repairs Agentic HQ's Windows Task Scheduler routines (2026-10-28).
# Deterministic checks run tools\hq-sentinel.mjs; model routines start a deck card through tools\run-card.mjs
# (POST /api/run, like a click). Everything runs hidden through tools\run-hidden.vbs. Re-run this to repair.
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\install-hq-routines.ps1 [-Remove] [-Only '<task name>']
param([switch]$Remove, [string]$Only)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$vbs = Join-Path $PSScriptRoot 'run-hidden.vbs'
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited

# New-ScheduledTaskTrigger writes a UTC start ("...Z") that Task Scheduler pins to that instant, so routines ran an hour early after DST ended.
# A start with no offset is local wall-clock time and follows DST. Daily and weekly starts are their next occurrence, never a time that has
# already passed, so -StartWhenAvailable has no missed run to catch up on right after a reinstall.
function LocalStart($t, [DateTime]$start) { $t.StartBoundary = $start.ToString('s'); $t }
function NextAt($at) { $next = [DateTime]::Today.Add([TimeSpan]$at); if ($next -le [DateTime]::Now) { $next = $next.AddDays(1) }; $next }
function Daily($at) { LocalStart (New-ScheduledTaskTrigger -Daily -At $at) (NextAt $at) }
function Weekly($day, $at) { LocalStart (New-ScheduledTaskTrigger -Weekly -DaysOfWeek $day -At $at) (NextAt $at) }
function Every($hours) { LocalStart (New-ScheduledTaskTrigger -Once -At ([DateTime]::Today) -RepetitionInterval (New-TimeSpan -Hours $hours) -RepetitionDuration (New-TimeSpan -Days 3650)) ([DateTime]::Today) }
function EveryMinutes($minutes) { LocalStart (New-ScheduledTaskTrigger -Once -At ([DateTime]::Today) -RepetitionInterval (New-TimeSpan -Minutes $minutes) -RepetitionDuration (New-TimeSpan -Days 3650)) ([DateTime]::Today) }
function Logon($delay) { $t = New-ScheduledTaskTrigger -AtLogOn -User $user; $t.Delay = $delay; $t }
$logon = Logon 'PT3M'

# One owner keeps HQ up: Start brings it up at sign-in, Watchdog restarts HQ and the native companions every 10 minutes.
$routines = @(
  @{ Name = 'Agentic HQ Start';              Args = 'tools\start-hq.cjs';                             Trigger = (Logon 'PT15S');              Limit = 2 },
  @{ Name = 'Agentic HQ Window';             Args = 'tools\open-hq-window.mjs';                       Trigger = (Logon 'PT20S');              Limit = 5 },
  @{ Name = 'Agentic HQ Watchdog';           Args = 'tools\hq-sentinel.mjs watch';                    Trigger = (EveryMinutes 10);            Limit = 5 },
  @{ Name = 'Agentic HQ Orca Cleanup';       Args = 'tools\orca-reap.mjs';                            Trigger = (EveryMinutes 30);            Limit = 10 },
  @{ Name = 'Agentic HQ Boot Check';         Args = 'tools\hq-sentinel.mjs boot';                     Trigger = $logon;                       Limit = 10 },
  @{ Name = 'Agentic HQ PC Sentinel';        Args = 'tools\hq-sentinel.mjs pc';                       Trigger = (Every 2);                    Limit = 5 },
  @{ Name = 'Agentic HQ Usage Guard';        Args = 'tools\hq-sentinel.mjs usage';                    Trigger = (Every 1);                    Limit = 5 },
  @{ Name = 'Agentic HQ Attention Digest';   Args = 'tools\attention.mjs digest';                     Trigger = (Daily '20:00');              Limit = 5 },
  @{ Name = 'Agentic HQ AI Radar';           Args = 'tools\ai-radar.mjs';                             Trigger = @((Daily '08:00'), (Daily '20:00')); Limit = 45 },   # logs to os-runs\ai-radar.log
  @{ Name = 'Agentic HQ Session Lessons';    Args = 'tools\run-card.mjs session-lessons --ingest';    Trigger = (Daily '02:30');              Limit = 20 },
  @{ Name = 'Agentic HQ Gotcha Proposals';   Args = 'tools\run-card.mjs gotcha-proposals';            Trigger = (Daily '19:00');              Limit = 20 },
  @{ Name = 'Agentic HQ Repeat Check';       Args = 'tools\ranked-dupes.mjs --alert';                 Trigger = (Daily '09:00');              Limit = 5 },
  @{ Name = 'Agentic HQ Weekly Dev Health';  Args = 'tools\run-card.mjs weekly-dev-health';           Trigger = (Weekly Sunday '18:00');      Limit = 5 },
  @{ Name = 'Agentic HQ Artifact Retention'; Args = 'tools\artifact-retention.mjs';                   Trigger = (Weekly Sunday '03:30');      Limit = 5 }
  @{ Name = 'Agentic HQ Repo Backup';        Args = 'tools\repo-backup.mjs';                          Trigger = (Weekly Sunday '03:00');      Limit = 30 }
  @{ Name = 'Agentic HQ Repo Restore Test';  Args = 'tools\repo-backup.mjs -RestoreTest -FirstSundayOnly'; Trigger = (Weekly Sunday '03:15');   Limit = 45 }
)
# Your own routines: os-config.json "windowsRoutines", each { "name", "args", "daily": "HH:mm" or "weekly": "<day>" with "at": "HH:mm", "limit": minutes }.
$config = Get-Content -Raw -LiteralPath (Join-Path $root 'os-config.json') | ConvertFrom-Json
if ($config.PSObject.Properties['windowsRoutines']) {
  foreach ($w in @($config.windowsRoutines)) {
    $trigger = if ($w.PSObject.Properties['weekly']) { Weekly $w.weekly $w.at } else { Daily $w.daily }
    $limit = if ($w.PSObject.Properties['limit']) { [int]$w.limit } else { 5 }
    $routines += @{ Name = $w.name; Args = $w.args; Trigger = $trigger; Limit = $limit }
  }
}

foreach ($r in $routines) {
  if ($Only -and $r.Name -ne $Only) { continue }
  if ($Remove) { Unregister-ScheduledTask -TaskName $r.Name -Confirm:$false -ErrorAction SilentlyContinue; "removed $($r.Name)"; continue }
  $action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbs`" $($r.Args)" -WorkingDirectory $root
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes $r.Limit) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  Register-ScheduledTask -TaskName $r.Name -Action $action -Trigger $r.Trigger -Principal $principal -Settings $settings -Description "Agentic HQ routine: node $($r.Args) (installed by tools\install-hq-routines.ps1)" -Force | Out-Null
  $info = Get-ScheduledTaskInfo -TaskName $r.Name
  "{0,-30} next: {1}" -f $r.Name, $info.NextRunTime
}
