Set-StrictMode -Version Latest

function ConvertTo-NativeArgument([string] $Value) {
    # Windows argv quoting, including empty arguments for ssh-keygen -N.
    return '"' + [regex]::Replace([regex]::Replace($Value, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1') + '"'
}

function Invoke-BackupProcess {
    param(
        [Parameter(Mandatory = $true)][string] $Executable,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string[]] $Arguments,
        [string] $OutputPath,
        [int] $TimeoutSeconds = 600
    )
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $Executable
    $startInfo.Arguments = (($Arguments | ForEach-Object { ConvertTo-NativeArgument $_ }) -join ' ')
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardInput = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $startInfo
    $stream = $null
    try {
        if ($OutputPath) {
            $stream = [System.IO.File]::Open($OutputPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
        } else {
            $stream = New-Object System.IO.MemoryStream
        }
        if (-not $process.Start()) { throw 'Impossibile avviare il trasferimento.' }
        $process.StandardInput.Close()
        $errorRead = $process.StandardError.ReadToEndAsync()
        # Copy bytes directly: Windows PowerShell text redirection corrupts SQLite files.
        $outputCopy = $process.StandardOutput.BaseStream.CopyToAsync($stream)
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            $process.Kill()
            $process.WaitForExit()
            throw 'Tempo massimo di collegamento al VPS superato.'
        }
        $null = $outputCopy.GetAwaiter().GetResult()
        $errorText = $errorRead.GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0) { throw "Collegamento non riuscito: $errorText" }
        if (-not $OutputPath) { return [System.Text.Encoding]::UTF8.GetString($stream.ToArray()) }
    } finally {
        if ($null -ne $stream) { $stream.Dispose() }
        $process.Dispose()
    }
}

function Invoke-BackupInteractiveSsh([string] $Executable, [string[]] $Arguments, [string] $InputScript) {
    # Keep the console available for SSH's password/host-fingerprint prompts,
    # but send script bytes without PowerShell's added CRLF or text conversions.
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $Executable
    $startInfo.Arguments = (($Arguments | ForEach-Object { ConvertTo-NativeArgument $_ }) -join ' ')
    $startInfo.UseShellExecute = $false
    $startInfo.RedirectStandardInput = $true
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $startInfo
    try {
        if (-not $process.Start()) { throw 'Impossibile avviare SSH.' }
        $bytes = [System.Text.Encoding]::ASCII.GetBytes($InputScript)
        $process.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
        $process.StandardInput.Close()
        $process.WaitForExit()
        if ($process.ExitCode -ne 0) { throw 'Configurazione VPS non riuscita. Nessuna attivita Windows creata.' }
    } finally {
        $process.Dispose()
    }
}

function Get-BackupSshArguments($Configuration, [string] $Command) {
    return @(
        '-F', 'none', '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
        '-o', 'IdentitiesOnly=yes', '-o', 'PreferredAuthentications=publickey',
        '-o', 'ConnectTimeout=20', '-o', 'ConnectionAttempts=1',
        '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
        '-o', ('UserKnownHostsFile=' + $Configuration.KnownHostsPath),
        '-i', $Configuration.KeyPath, '-p', [string] $Configuration.Port,
        ('root@' + $Configuration.Server), $Command
    )
}

function Get-BackupExpectedHash([string] $ChecksumPath, [string] $DatabaseName) {
    $checksum = [System.IO.File]::ReadAllText($ChecksumPath).Trim()
    $pattern = '^([0-9a-fA-F]{64})[ \t]+\*?' + [regex]::Escape($DatabaseName) + '$'
    if ($checksum -notmatch $pattern) { throw "File di verifica non valido: $DatabaseName.sha256" }
    return $Matches[1].ToLowerInvariant()
}

function Test-BackupHash([string] $DatabasePath, [string] $ExpectedHash) {
    if ((Get-FileHash -LiteralPath $DatabasePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $ExpectedHash) {
        throw "Controllo SHA256 fallito: $([System.IO.Path]::GetFileName($DatabasePath))"
    }
}
