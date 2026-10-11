$ErrorActionPreference = 'Stop'
try {
    $runtimeCandidates = @()
    $installedNode = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($installedNode) { $runtimeCandidates += $installedNode.Source }
    $runtimeCandidates += (Join-Path $env:ProgramFiles 'nodejs\node.exe')
    $runtimeCandidates += (Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe')
    $selectedRuntime = $null
    foreach ($candidate in ($runtimeCandidates | Select-Object -Unique)) {
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
        $runtimeVersion = & $candidate -p 'process.versions.node' 2>$null
        if ($LASTEXITCODE -eq 0 -and [int]($runtimeVersion.Split('.')[0]) -ge 24) { $selectedRuntime = $candidate; break }
    }
    if (-not $selectedRuntime) { throw 'Node.js 24 o successivo non trovato. Installa Node.js 24 e riapri questo file.' }
    Set-Location -LiteralPath $PSScriptRoot
    & $selectedRuntime (Join-Path $PSScriptRoot 'server\local.mjs')
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} catch {
    Write-Host ('Avvio non riuscito: ' + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
