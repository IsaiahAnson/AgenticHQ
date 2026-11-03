# Start Agentic HQ with Claude Console keys held only in this PowerShell process.
# Run from a fresh PowerShell window after stopping the existing HQ server.
$ErrorActionPreference = 'Stop'
$hqRoot = Split-Path -Parent $PSScriptRoot

$apiSecret = Read-Host 'Claude Console API key (for opt-in API tasks)' -AsSecureString
$adminSecret = Read-Host 'Claude Console Admin or Organization-scoped key (for usage; press Enter to skip)' -AsSecureString

try {
    if ($apiSecret.Length -gt 0) {
        $env:ANTHROPIC_API_KEY = [System.Net.NetworkCredential]::new('', $apiSecret).Password
    }
    if ($adminSecret.Length -gt 0) {
        $env:ANTHROPIC_ADMIN_KEY = [System.Net.NetworkCredential]::new('', $adminSecret).Password
    }
    Push-Location $hqRoot
    try {
        node server.js
    }
    finally {
        Pop-Location
    }
}
finally {
    Remove-Item Env:ANTHROPIC_API_KEY, Env:ANTHROPIC_ADMIN_KEY -ErrorAction SilentlyContinue
}
