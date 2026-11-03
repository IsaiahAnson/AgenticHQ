$ErrorActionPreference = 'Stop'
$taskName = 'Agentic HQ Second Brain Refresh'
$refreshScript = Join-Path $PSScriptRoot 'refresh-second-brain-scheduled.ps1'
$powershell = Join-Path $PSHOME 'powershell.exe'
$action = New-ScheduledTaskAction -Execute $powershell -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$refreshScript`""
$trigger = New-ScheduledTaskTrigger -Once -At ([DateTime]::Today) -RepetitionInterval (New-TimeSpan -Hours 3) -RepetitionDuration (New-TimeSpan -Days 3650)
# Local midnight with no offset: the UTC start New-ScheduledTaskTrigger writes would shift the 3-hour grid an hour at each DST change.
$trigger.StartBoundary = [DateTime]::Today.ToString('s')
$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10)

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
$info = Get-ScheduledTaskInfo -TaskName $taskName
Write-Output "$taskName installed; next run: $($info.NextRunTime)"
