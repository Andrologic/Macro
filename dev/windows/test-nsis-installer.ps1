param(
  [string]$InstallerPath,
  [switch]$FailAfterStateIsolation
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($env:OS -ne 'Windows_NT') {
  throw 'The NSIS installer smoke test requires Windows.'
}

$runningMacro = Get-Process -Name 'macro' -ErrorAction SilentlyContinue
if ($runningMacro) {
  throw 'Close Macro before running the installer smoke test. The test must not interrupt a working session.'
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
if (-not $InstallerPath) {
  $candidate = Get-ChildItem (Join-Path $repoRoot 'src-tauri\target\release\bundle\nsis') `
    -Filter '*-setup.exe' -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if (-not $candidate) {
    throw 'No NSIS installer was found. Run bun run tauri:build:nsis first or pass -InstallerPath.'
  }
  $InstallerPath = $candidate.FullName
}
$InstallerPath = (Resolve-Path $InstallerPath).Path

$manufacturerKey = 'HKCU:\Software\macro\Macro'
$uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Macro'
$manufacturerRegKey = 'HKCU\Software\macro\Macro'
$uninstallRegKey = 'HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Macro'
$defaultInstallPath = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Programs\Macro'
$legacyInstallPath = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Macro'
$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) "macro-nsis-$([guid]::NewGuid().ToString('N'))"
$registryBackup = Join-Path $testRoot 'registry-backup'
$directoryBackup = Join-Path $testRoot 'existing-default-install'
$legacyDirectoryBackup = Join-Path $testRoot 'existing-legacy-install'
$installedPaths = [System.Collections.Generic.List[string]]::new()
$registryIsolationStarted = $false
$testStateMutationStarted = $false
$testFailure = $null
$registrySnapshots = @(
  @{ Key = $manufacturerRegKey; ProviderPath = $manufacturerKey; File = Join-Path $registryBackup 'manufacturer.reg'; Existed = Test-Path -LiteralPath $manufacturerKey },
  @{ Key = $uninstallRegKey; ProviderPath = $uninstallKey; File = Join-Path $registryBackup 'uninstall.reg'; Existed = Test-Path -LiteralPath $uninstallKey }
)
$defaultDirectoryExisted = Test-Path -LiteralPath $defaultInstallPath
$legacyDirectoryExisted = Test-Path -LiteralPath $legacyInstallPath

function Remove-TestRegistry {
  Remove-Item -LiteralPath $manufacturerKey -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $uninstallKey -Recurse -Force -ErrorAction SilentlyContinue
}

function Invoke-RegCommand {
  param([string]$Arguments)

  $process = Start-Process -FilePath 'reg.exe' -ArgumentList $Arguments -Wait -PassThru -WindowStyle Hidden
  return $process.ExitCode
}

function Get-FileSha256 {
  param([string]$Path)

  $stream = [System.IO.File]::OpenRead($Path)
  try {
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
      return [BitConverter]::ToString($sha256.ComputeHash($stream)).Replace('-', '')
    }
    finally {
      $sha256.Dispose()
    }
  }
  finally {
    $stream.Dispose()
  }
}

function Export-RegistrySnapshot {
  param([hashtable]$Snapshot)

  if (-not $Snapshot.Existed) {
    return
  }
  $exitCode = Invoke-RegCommand "export `"$($Snapshot.Key)`" `"$($Snapshot.File)`" /y"
  if ($exitCode -ne 0) {
    throw "Could not back up registry key $($Snapshot.Key)."
  }
}

function Restore-TestState {
  $cleanupErrors = [System.Collections.Generic.List[string]]::new()

  foreach ($path in $installedPaths) {
    $uninstaller = Join-Path $path 'uninstall.exe'
    if (Test-Path -LiteralPath $uninstaller) {
      try {
        $process = Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait -PassThru -WindowStyle Hidden
        if ($process.ExitCode -ne 0) {
          $cleanupErrors.Add("Uninstaller cleanup failed for '$path' with exit code $($process.ExitCode).")
        }
      }
      catch {
        $cleanupErrors.Add("Could not run the uninstaller cleanup for '$path': $($_.Exception.Message)")
      }
    }
  }

  if ($registryIsolationStarted) {
    foreach ($snapshot in $registrySnapshots) {
      try {
        Remove-Item -LiteralPath $snapshot.ProviderPath -Recurse -Force -ErrorAction SilentlyContinue
      }
      catch {
        $cleanupErrors.Add("Could not remove test registry key '$($snapshot.Key)': $($_.Exception.Message)")
      }
    }
    foreach ($snapshot in $registrySnapshots) {
      if ($snapshot.Existed) {
        try {
          if (-not (Test-Path -LiteralPath $snapshot.File)) {
            throw "The backup file '$($snapshot.File)' is missing."
          }
          $exitCode = Invoke-RegCommand "import `"$($snapshot.File)`""
          if ($exitCode -ne 0) {
            throw "reg.exe exited with code $exitCode."
          }
        }
        catch {
          $cleanupErrors.Add("Could not restore registry key '$($snapshot.Key)': $($_.Exception.Message)")
        }
      }
    }
  }

  try {
    if (Test-Path -LiteralPath $directoryBackup) {
      Remove-Item -LiteralPath $defaultInstallPath -Recurse -Force -ErrorAction SilentlyContinue
      New-Item -ItemType Directory -Path (Split-Path $defaultInstallPath) -Force | Out-Null
      Move-Item -LiteralPath $directoryBackup -Destination $defaultInstallPath
    }
    elseif ($testStateMutationStarted -and -not $defaultDirectoryExisted) {
      Remove-Item -LiteralPath $defaultInstallPath -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
  catch {
    $cleanupErrors.Add("Could not restore '$defaultInstallPath': $($_.Exception.Message)")
  }

  try {
    if (Test-Path -LiteralPath $legacyDirectoryBackup) {
      Remove-Item -LiteralPath $legacyInstallPath -Recurse -Force -ErrorAction SilentlyContinue
      Move-Item -LiteralPath $legacyDirectoryBackup -Destination $legacyInstallPath
    }
    elseif ($testStateMutationStarted -and -not $legacyDirectoryExisted) {
      Remove-Item -LiteralPath $legacyInstallPath -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
  catch {
    $cleanupErrors.Add("Could not restore '$legacyInstallPath': $($_.Exception.Message)")
  }

  if ($registryIsolationStarted) {
    foreach ($snapshot in $registrySnapshots) {
      try {
        if ($snapshot.Existed -ne (Test-Path -LiteralPath $snapshot.ProviderPath)) {
          throw 'The key existence does not match its initial state.'
        }
        if ($snapshot.Existed) {
          $verificationFile = Join-Path $registryBackup "$([System.IO.Path]::GetFileNameWithoutExtension($snapshot.File))-restored.reg"
          $exitCode = Invoke-RegCommand "export `"$($snapshot.Key)`" `"$verificationFile`" /y"
          if ($exitCode -ne 0) {
            throw "reg.exe exited with code $exitCode while verifying the restored key."
          }
          if ((Get-FileSha256 $snapshot.File) -ne (Get-FileSha256 $verificationFile)) {
            throw 'The restored key differs from its backup.'
          }
        }
      }
      catch {
        $cleanupErrors.Add("Registry verification failed for '$($snapshot.Key)': $($_.Exception.Message)")
      }
    }
  }

  try {
    if ($defaultDirectoryExisted -ne (Test-Path -LiteralPath $defaultInstallPath)) {
      throw "The directory existence does not match its initial state."
    }
    if ($legacyDirectoryExisted -ne (Test-Path -LiteralPath $legacyInstallPath)) {
      throw "The directory existence does not match its initial state."
    }
  }
  catch {
    $cleanupErrors.Add("Installation directory verification failed: $($_.Exception.Message)")
  }

  if ($cleanupErrors.Count -eq 0) {
    try {
      if (Test-Path -LiteralPath $testRoot) {
        Remove-Item -LiteralPath $testRoot -Recurse -Force
      }
    }
    catch {
      $cleanupErrors.Add("Could not remove test directory '$testRoot': $($_.Exception.Message)")
    }
  }

  if ($cleanupErrors.Count -gt 0) {
    $details = $cleanupErrors -join [Environment]::NewLine
    throw "The NSIS test could not restore the original Windows state. Recovery files remain in '$testRoot'.$([Environment]::NewLine)$details"
  }
}

function Set-RegisteredInstallPath {
  param([string]$Path)

  if (-not (Test-Path -LiteralPath $manufacturerKey)) {
    New-Item -Path $manufacturerKey -Force | Out-Null
  }
  Set-Item -Path $manufacturerKey -Value $Path
}

function Set-UninstallEntryPath {
  param([string]$Path)

  Set-ItemProperty -LiteralPath $uninstallKey -Name 'DisplayIcon' -Value "`"$Path\macro.exe`""
  Set-ItemProperty -LiteralPath $uninstallKey -Name 'InstallLocation' -Value "`"$Path`""
  Set-ItemProperty -LiteralPath $uninstallKey -Name 'UninstallString' -Value "`"$Path\uninstall.exe`""
}

function Assert-EqualPath {
  param(
    [string]$Actual,
    [string]$Expected,
    [string]$Message
  )

  if ([string]::IsNullOrWhiteSpace($Actual)) {
    throw "$Message The registry value is empty."
  }
  $normalizedActual = $Actual.Trim().Trim('"')
  try {
    $actualFullPath = [System.IO.Path]::GetFullPath($normalizedActual).TrimEnd('\')
  }
  catch {
    throw "$Message The registry path '$Actual' is invalid."
  }
  $expectedFullPath = [System.IO.Path]::GetFullPath($Expected).TrimEnd('\')
  if (-not $actualFullPath.Equals($expectedFullPath, [StringComparison]::OrdinalIgnoreCase)) {
    throw "$Message Expected '$expectedFullPath', received '$actualFullPath'."
  }
}

function Assert-InstalledAt {
  param([string]$ExpectedPath)

  $binary = Join-Path $ExpectedPath 'macro.exe'
  $uninstaller = Join-Path $ExpectedPath 'uninstall.exe'
  if (-not (Test-Path -LiteralPath $binary) -or -not (Test-Path -LiteralPath $uninstaller)) {
    throw "The installer did not create Macro and its uninstaller under '$ExpectedPath'."
  }
  $savedPath = (Get-Item -LiteralPath $manufacturerKey).GetValue('')
  $uninstallLocation = Get-ItemPropertyValue -LiteralPath $uninstallKey -Name 'InstallLocation'
  Assert-EqualPath $savedPath $ExpectedPath 'The saved manufacturer install path is wrong.'
  Assert-EqualPath $uninstallLocation $ExpectedPath 'The uninstall entry install path is wrong.'
}

function Assert-RegistryClean {
  if ((Test-Path -LiteralPath $manufacturerKey) -or (Test-Path -LiteralPath $uninstallKey)) {
    throw 'The uninstaller left a Macro manufacturer or uninstall registry key behind.'
  }
}

function Invoke-Installer {
  param(
    [int]$Language,
    [string]$Destination
  )

  if (-not (Test-Path -LiteralPath $manufacturerKey)) {
    New-Item -Path $manufacturerKey -Force | Out-Null
  }
  Set-ItemProperty -LiteralPath $manufacturerKey -Name 'Installer Language' -Value ([string]$Language)

  $arguments = '/S'
  if ($Destination) {
    $arguments = "/S /D=$Destination"
  }
  $process = Start-Process -FilePath $InstallerPath -ArgumentList $arguments -Wait -PassThru -WindowStyle Hidden
  if ($process.ExitCode -ne 0) {
    throw "The installer failed with exit code $($process.ExitCode) for language $Language."
  }
}

function Uninstall-TestInstallation {
  param([string]$InstallPath)

  $uninstaller = Join-Path $InstallPath 'uninstall.exe'
  $process = Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait -PassThru -WindowStyle Hidden
  if ($process.ExitCode -ne 0) {
    throw "The uninstaller failed with exit code $($process.ExitCode) for '$InstallPath'."
  }
  $installedPaths.Remove($InstallPath) | Out-Null
  Remove-TestRegistry
  if (Test-Path -LiteralPath $InstallPath) {
    throw "The uninstaller left the temporary installation '$InstallPath' behind."
  }
  Assert-RegistryClean
}

try {
  New-Item -ItemType Directory -Path $registryBackup -Force | Out-Null
  foreach ($snapshot in $registrySnapshots) {
    Export-RegistrySnapshot $snapshot
  }
  if ($defaultDirectoryExisted) {
    Move-Item -LiteralPath $defaultInstallPath -Destination $directoryBackup
  }
  if ($legacyDirectoryExisted) {
    Move-Item -LiteralPath $legacyInstallPath -Destination $legacyDirectoryBackup
  }

  $registryIsolationStarted = $true
  $testStateMutationStarted = $true
  Remove-TestRegistry
  if ($FailAfterStateIsolation) {
    throw 'Intentional failure after isolating the installer test state.'
  }

  Write-Host 'Testing a clean per-user installation.'
  Invoke-Installer -Language 1033
  Assert-InstalledAt $defaultInstallPath

  Write-Host 'Testing preservation of an existing installation.'
  $existingPath = Join-Path $testRoot 'existing-install'
  Move-Item -LiteralPath $defaultInstallPath -Destination $existingPath
  Set-RegisteredInstallPath $existingPath
  Set-UninstallEntryPath $existingPath
  $installedPaths.Add($existingPath)
  Invoke-Installer -Language 1036
  Assert-InstalledAt $existingPath
  if (Test-Path -LiteralPath $defaultInstallPath) {
    throw 'The reinstall ignored the existing location and created the clean-install default.'
  }
  Uninstall-TestInstallation $existingPath

  Write-Host 'Testing an explicit legacy /D destination.'
  $installedPaths.Add($legacyInstallPath)
  Invoke-Installer -Language 1031 -Destination $legacyInstallPath
  Assert-InstalledAt $legacyInstallPath
  if (Test-Path -LiteralPath $defaultInstallPath) {
    throw 'The installer ignored the explicit /D destination and created the clean-install default.'
  }
  Uninstall-TestInstallation $legacyInstallPath

  Write-Host 'Testing rejection of a stale installation path.'
  $stalePath = Join-Path ([System.IO.Path]::GetTempPath()) "installer-language-smoke-$([guid]::NewGuid().ToString('N'))"
  Set-RegisteredInstallPath $stalePath
  Invoke-Installer -Language 1034
  Assert-InstalledAt $defaultInstallPath
  $installedPaths.Add($defaultInstallPath)
  if (Test-Path -LiteralPath $stalePath) {
    throw "The installer reused the stale test destination '$stalePath'."
  }
  Uninstall-TestInstallation $defaultInstallPath

  $languages = @(
    @{ Name = 'English'; Id = 1033 },
    @{ Name = 'French'; Id = 1036 },
    @{ Name = 'Spanish'; Id = 1034 },
    @{ Name = 'German'; Id = 1031 },
    @{ Name = 'Japanese'; Id = 1041 },
    @{ Name = 'Korean'; Id = 1042 }
  )
  foreach ($language in $languages) {
    Write-Host "Testing the $($language.Name) language table."
    Invoke-Installer -Language $language.Id
    Assert-InstalledAt $defaultInstallPath
    $installedPaths.Add($defaultInstallPath)
    Uninstall-TestInstallation $defaultInstallPath
  }

  Write-Host 'NSIS installer smoke test passed for clean, existing, explicit, stale, cleanup, and six language cases.'
}
catch {
  $testFailure = $_
}
finally {
  try {
    Restore-TestState
  }
  catch {
    if ($testFailure) {
      throw "The installer smoke test failed: $($testFailure.Exception.Message)$([Environment]::NewLine)Cleanup also failed: $($_.Exception.Message)"
    }
    throw
  }
}

if ($testFailure) {
  throw $testFailure
}
