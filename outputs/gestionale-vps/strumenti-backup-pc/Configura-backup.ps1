param(
    [string] $Server = 'api.magomme.it',
    [int] $Port = 22,
    [string] $Destination = (Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'BackupOfficina'),
    [string] $Time = '09:00'
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Backup-common.ps1')

try {
    if ($Server -notmatch '^[a-zA-Z0-9][a-zA-Z0-9.-]*$' -or $Port -lt 1 -or $Port -gt 65535) { throw 'Indirizzo o porta VPS non validi.' }
    if ($Time -notmatch '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$') { throw 'Usare un orario come 09:00.' }
    $ssh = (Get-Command ssh.exe -ErrorAction Stop).Source
    $keygen = (Get-Command ssh-keygen.exe -ErrorAction Stop).Source
    $installationDirectory = Join-Path $env:LOCALAPPDATA 'OfficinaBackup'
    [System.IO.Directory]::CreateDirectory($installationDirectory) | Out-Null
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $currentSid = $identity.User
    # The key has no passphrase for unattended use; its server grant is backup-read only.
    $directoryAcl = New-Object System.Security.AccessControl.DirectorySecurity
    $directoryAcl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @($currentSid, (New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')), (New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')))) {
        $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        $directoryAcl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $installationDirectory -AclObject $directoryAcl
    $keyPath = Join-Path $installationDirectory 'id_ed25519_backup'
    if (-not (Test-Path -LiteralPath $keyPath)) {
        Invoke-BackupProcess -Executable $keygen -Arguments @('-q', '-t', 'ed25519', '-N', '', '-C', 'officina-backup-pc', '-f', $keyPath) | Out-Null
    }
    $keyAcl = New-Object System.Security.AccessControl.FileSecurity
    $keyAcl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @($currentSid, (New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')), (New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')))) {
        $keyAcl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'Allow')))
    }
    Set-Acl -LiteralPath $keyPath -AclObject $keyAcl
    $publicKeyText = [System.IO.File]::ReadAllText("$keyPath.pub").Trim()
    if ($publicKeyText -notmatch '^ssh-ed25519 ([a-zA-Z0-9+/]+={0,2})(?: .*)?$') { throw 'Chiave pubblica non valida.' }
    $publicKey = 'ssh-ed25519 ' + $Matches[1]
    $exporterBase64 = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes((Join-Path $PSScriptRoot 'officina-backup-download.sh')))
    $remoteInstaller = [System.IO.File]::ReadAllText((Join-Path $PSScriptRoot 'install-vps.sh')).Replace('__PUBLIC_KEY__', $publicKey).Replace('__EXPORTER_BASE64__', $exporterBase64).Replace("`r`n", "`n")
    Write-Host 'Configurazione VPS: verra richiesta la password SSH di root (la digitazione non e visibile).'
    Write-Host 'Se e la prima connessione, confronta l impronta SSH con quella mostrata dalla console VPS.'
    Invoke-BackupInteractiveSsh -Executable $ssh -Arguments @('-F', 'none', '-T', '-p', [string] $Port, '-o', 'StrictHostKeyChecking=ask', '-o', 'ConnectTimeout=20', "root@$Server", 'bash -s') -InputScript $remoteInstaller
    $configuration = [ordered]@{
        Server = $Server
        Port = $Port
        Destination = [System.IO.Path]::GetFullPath($Destination)
        KeyPath = $keyPath
        KnownHostsPath = (Join-Path $env:USERPROFILE '.ssh\known_hosts')
    }
    # Verify the restricted key before scheduling anything.
    Invoke-BackupProcess -Executable $ssh -Arguments (Get-BackupSshArguments $configuration 'list') -TimeoutSeconds 90 | Out-Null
    foreach ($fileName in @('Backup-common.ps1', 'Scarica-backup.ps1')) {
        $sourcePath = Join-Path $PSScriptRoot $fileName
        $targetPath = Join-Path $installationDirectory $fileName
        if ([System.IO.Path]::GetFullPath($sourcePath) -ne [System.IO.Path]::GetFullPath($targetPath)) { Copy-Item -LiteralPath $sourcePath -Destination $targetPath -Force }
    }
    $configuration | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $installationDirectory 'config.json') -Encoding UTF8
    Write-Host 'Scarico subito i backup disponibili e controllo i file.'
    $powershellPath = Join-Path $PSHOME 'powershell.exe'
    $downloadScript = Join-Path $installationDirectory 'Scarica-backup.ps1'
    & $powershellPath -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $downloadScript
    if ($LASTEXITCODE -ne 0) { throw 'Il primo download non e riuscito. Nessuna attivita Windows creata.' }
    $taskName = 'Officina - Download backup VPS'
    $taskDescription = 'Scarica e verifica i backup Officina ogni giorno e quando questo utente accede a Windows. Non cancella i backup.'
    $existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($null -ne $existingTask -and $existingTask.Description -ne $taskDescription) { throw 'Esiste gia una diversa attivita con lo stesso nome. Non e stata sostituita.' }
    $actionArguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File ' + (ConvertTo-NativeArgument $downloadScript)
    $action = New-ScheduledTaskAction -Execute $powershellPath -Argument $actionArguments
    $dailyTrigger = New-ScheduledTaskTrigger -Daily -At ([DateTime]::ParseExact($Time, 'HH:mm', [Globalization.CultureInfo]::InvariantCulture))
    $logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $currentSid.Value
    $logonTrigger.Delay = 'PT1M'
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RunOnlyIfNetworkAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 15) -ExecutionTimeLimit (New-TimeSpan -Hours 2)
    $principal = New-ScheduledTaskPrincipal -UserId $currentSid.Value -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $taskName -Description $taskDescription -Action $action -Trigger @($dailyTrigger, $logonTrigger) -Settings $settings -Principal $principal -Force | Out-Null
    Write-Host "Attivato: alle $Time (ora del PC) e un minuto dopo l accesso a Windows."
    Write-Host "Backup salvati in: $($configuration.Destination)"
    Write-Host 'Se il PC e spento o non hai effettuato l accesso a Windows, il download attende il successivo accesso.'
    Write-Host "Per controllare: apri Utilita di pianificazione, attivita '$taskName', oppure il file download.log nella cartella dei backup."
    exit 0
} catch {
    Write-Host "Configurazione incompleta: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host 'Nessun database e stato cancellato. Puoi ripetere la configurazione.'
    exit 1
}
