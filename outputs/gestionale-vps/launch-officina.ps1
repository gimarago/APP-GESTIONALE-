$ErrorActionPreference = 'Stop'
$appDirectory = $PSScriptRoot
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
    Start-Process (Join-Path $appDirectory 'officina-fatturazione.html')
    exit
}
$serviceReady = $false
try { $null = Invoke-RestMethod 'http://localhost:8772/api/email/status' -TimeoutSec 2; $serviceReady = $true } catch {}
if (-not $serviceReady) {
    Start-Process -FilePath $nodeCommand.Source -ArgumentList ('"' + (Join-Path $appDirectory 'email-service.cjs') + '"') -WorkingDirectory $appDirectory -WindowStyle Hidden
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        Start-Sleep -Milliseconds 250
        try { $null = Invoke-RestMethod 'http://localhost:8772/api/email/status' -TimeoutSec 1; $serviceReady = $true; break } catch {}
    }
}
if ($serviceReady) {
    try { $null = Invoke-WebRequest 'http://127.0.0.1:8770/' -UseBasicParsing -TimeoutSec 2; Start-Process 'http://127.0.0.1:8770/' }
    catch { Start-Process 'http://localhost:8772/' }
} else {
    Start-Process (Join-Path $appDirectory 'officina-fatturazione.html')
}
