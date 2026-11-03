# Check Anthropic Cost Report access without storing or printing the key.
$ErrorActionPreference = 'Stop'
$secret = Read-Host 'New Organization-scoped reporting key' -AsSecureString
$key = [System.Net.NetworkCredential]::new('', $secret).Password
$utc = [DateTime]::UtcNow
$monthStart = [DateTime]::new($utc.Year, $utc.Month, 1, 0, 0, 0, [DateTimeKind]::Utc).ToString('o')
$url = 'https://api.anthropic.com/v1/organizations/cost_report?starting_at=' + [Uri]::EscapeDataString($monthStart) + '&limit=1'
try {
    $null = Invoke-WebRequest -UseBasicParsing -Uri $url -Headers @{ 'x-api-key' = $key; 'anthropic-version' = '2023-06-01' } -TimeoutSec 15
    Write-Host 'Cost Report access works (HTTP 200). Use this key at the launcher reporting prompt.'
}
catch {
    $status = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 'connection error' }
    Write-Host "Cost Report access failed ($status). Keep using Console Usage/Billing; another HQ restart will not fix this key."
}
finally {
    Remove-Variable key, secret -ErrorAction SilentlyContinue
}
