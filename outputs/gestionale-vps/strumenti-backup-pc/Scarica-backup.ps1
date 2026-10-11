param([string] $ConfigPath = (Join-Path $PSScriptRoot 'config.json'))
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Backup-common.ps1')
$lock = $null
$stagingDirectory = $null
$configuration = $null
$stagedDatabase = $null
$stagedChecksum = $null

function Clear-DownloadStage {
    if ($null -ne $stagingDirectory -and [System.IO.Directory]::Exists($stagingDirectory)) {
        foreach ($temporaryPath in @($stagedDatabase, $stagedChecksum)) {
            if ($temporaryPath -and [System.IO.File]::Exists($temporaryPath)) { [System.IO.File]::Delete($temporaryPath) }
        }
        [System.IO.Directory]::Delete($stagingDirectory)
    }
}

function Write-BackupLog([string] $Message) {
    $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    Write-Output $line
    if ($null -ne $configuration) {
        Add-Content -LiteralPath (Join-Path $configuration.Destination 'download.log') -Value $line -Encoding UTF8
    }
}

try {
    $configuration = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
    if ($configuration.Server -notmatch '^[a-zA-Z0-9][a-zA-Z0-9.-]*$' -or
        [int] $configuration.Port -lt 1 -or [int] $configuration.Port -gt 65535) {
        throw 'Configurazione VPS non valida.'
    }
    if (-not (Test-Path -LiteralPath $configuration.KeyPath -PathType Leaf)) {
        throw 'Chiave di download non trovata. Ripetere la configurazione.'
    }
    [System.IO.Directory]::CreateDirectory($configuration.Destination) | Out-Null
    try {
        $lock = [System.IO.File]::Open((Join-Path $configuration.Destination '.download.lock'), [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
    } catch [System.IO.IOException] {
        Write-Output 'Un download e gia in corso.'
        exit 0
    }
    $ssh = (Get-Command ssh.exe -ErrorAction Stop).Source
    $listing = Invoke-BackupProcess -Executable $ssh -Arguments (Get-BackupSshArguments $configuration 'list') -TimeoutSeconds 90
    $names = @($listing -split '\r?\n' | Where-Object { $_ } | Sort-Object -Unique)
    foreach ($name in $names) {
        if ($name -notmatch '^officina-[0-9]{8}T[0-9]{6}Z-[0-9]+\.sqlite$') {
            throw 'Il VPS ha restituito un nome di backup non valido.'
        }
    }
    if ($names.Count -eq 0) { throw 'Nessun backup completo disponibile sul VPS.' }
    $downloaded = 0
    $failed = 0
    foreach ($name in $names) {
      try {
        $databasePath = Join-Path $configuration.Destination $name
        $checksumPath = "$databasePath.sha256"
        if ((Test-Path -LiteralPath $databasePath -PathType Leaf) -and (Test-Path -LiteralPath $checksumPath -PathType Leaf)) {
            Test-BackupHash $databasePath (Get-BackupExpectedHash $checksumPath $name)
            continue
        }
        $stagingDirectory = Join-Path $configuration.Destination ('.in-arrivo-' + [guid]::NewGuid().ToString('N'))
        [System.IO.Directory]::CreateDirectory($stagingDirectory) | Out-Null
        $stagedDatabase = Join-Path $stagingDirectory $name
        $stagedChecksum = "$stagedDatabase.sha256"
        Invoke-BackupProcess -Executable $ssh -Arguments (Get-BackupSshArguments $configuration "get $name.sha256") -OutputPath $stagedChecksum
        $expectedHash = Get-BackupExpectedHash $stagedChecksum $name
        Invoke-BackupProcess -Executable $ssh -Arguments (Get-BackupSshArguments $configuration "get $name") -OutputPath $stagedDatabase
        Test-BackupHash $stagedDatabase $expectedHash
        # Never replace an existing database silently; finish a previously interrupted pair.
        if (Test-Path -LiteralPath $databasePath -PathType Leaf) {
            Test-BackupHash $databasePath $expectedHash
        } else {
            [System.IO.File]::Move($stagedDatabase, $databasePath)
        }
        if (Test-Path -LiteralPath $checksumPath -PathType Leaf) {
            if ((Get-BackupExpectedHash $checksumPath $name) -ne $expectedHash) { throw 'La copia locale del checksum e diversa.' }
        } else {
            [System.IO.File]::Move($stagedChecksum, $checksumPath)
        }
        # Delete only this run's known temporary files, never local backup copies.
        foreach ($temporaryPath in @($stagedDatabase, $stagedChecksum)) {
            if (Test-Path -LiteralPath $temporaryPath) { [System.IO.File]::Delete($temporaryPath) }
        }
        [System.IO.Directory]::Delete($stagingDirectory)
        $stagingDirectory = $null
        $downloaded++
        Write-BackupLog "Scaricato e verificato: $name"
      } catch {
        $failed++
        Write-BackupLog "ERRORE su $name : $($_.Exception.Message)"
        Clear-DownloadStage
        $stagingDirectory = $null
      }
    }
    Write-BackupLog "Download: $downloaded nuovi backup verificati; $failed errori su $($names.Count) backup disponibili sul VPS."
    if ($failed -gt 0) { throw "$failed backup richiedono un controllo. Le altre copie disponibili sono state scaricate." }
    exit 0
} catch {
    $failure = $_.Exception.Message
    try { Write-BackupLog "ERRORE: $failure" } catch { Write-Output "ERRORE: $failure" }
    exit 1
} finally {
    Clear-DownloadStage
    if ($null -ne $lock) { $lock.Dispose() }
}
