param([string]$InstallerPath)

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
$defaultDirectoryMoved = $false
$legacyDirectoryMoved = $false
$registrySnapshots = @(
  @{ Key = $manufacturerRegKey; ProviderPath = $manufacturerKey; File = Join-Path $registryBackup 'manufacturer.reg'; Existed = $false },
  @{ Key = $uninstallRegKey; ProviderPath = $uninstallKey; File = Join-Path $registryBackup 'uninstall.reg'; Existed = $false }
)

function Remove-TestRegistry {
  Remove-Item -LiteralPath $manufacturerKey -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $uninstallKey -Recurse -Force -ErrorAction SilentlyContinue
}

function Invoke-RegCommand {
  param([string]$Arguments)

  $process = Start-Process -FilePath 'reg.exe' -ArgumentList $Arguments -Wait -PassThru -WindowStyle Hidden
  return $process.ExitCode
}

function Export-RegistrySnapshot {
  param([hashtable]$Snapshot)

  if (-not (Test-Path -LiteralPath $Snapshot.ProviderPath)) {
    return
  }
  $exitCode = Invoke-RegCommand "export `"$($Snapshot.Key)`" `"$($Snapshot.File)`" /y"
  if ($exitCode -ne 0) {
    throw "Could not back up registry key $($Snapshot.Key)."
  }
  $Snapshot.Existed = $true
}

function Restore-TestState {
  foreach ($path in $installedPaths) {
    $uninstaller = Join-Path $path 'uninstall.exe'
    if (Test-Path -LiteralPath $uninstaller) {
      try {
        $process = Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait -PassThru -WindowStyle Hidden
        if ($process.ExitCode -ne 0) {
          Write-Warning "Uninstaller cleanup failed for $path with exit code $($process.ExitCode)."
        }
      }
      catch {
        Write-Warning "Could not run the uninstaller cleanup for $path. $($_.Exception.Message)"
      }
    }
  }

  Remove-TestRegistry
  foreach ($snapshot in $registrySnapshots) {
    if ($snapshot.Existed -and (Test-Path -LiteralPath $snapshot.File)) {
      $exitCode = Invoke-RegCommand "import `"$($snapshot.File)`""
      if ($exitCode -ne 0) {
        Write-Warning "Could not restore registry key $($snapshot.Key) from $($snapshot.File)."
      }
    }
  }

  if (Test-Path -LiteralPath $defaultInstallPath) {
    Remove-Item -LiteralPath $defaultInstallPath -Recurse -Force
  }
  if ($defaultDirectoryMoved -and (Test-Path -LiteralPath $directoryBackup)) {
    New-Item -ItemType Directory -Path (Split-Path $defaultInstallPath) -Force | Out-Null
    Move-Item -LiteralPath $directoryBackup -Destination $defaultInstallPath
  }
  if (Test-Path -LiteralPath $legacyInstallPath) {
    Remove-Item -LiteralPath $legacyInstallPath -Recurse -Force
  }
  if ($legacyDirectoryMoved -and (Test-Path -LiteralPath $legacyDirectoryBackup)) {
    Move-Item -LiteralPath $legacyDirectoryBackup -Destination $legacyInstallPath
  }

  if (Test-Path -LiteralPath $testRoot) {
    Remove-Item -LiteralPath $testRoot -Recurse -Force
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
  param([int]$Language)

  if (-not (Test-Path -LiteralPath $manufacturerKey)) {
    New-Item -Path $manufacturerKey -Force | Out-Null
  }
  Set-ItemProperty -LiteralPath $manufacturerKey -Name 'Installer Language' -Value ([string]$Language)

  $process = Start-Process -FilePath $InstallerPath -ArgumentList '/S' -Wait -PassThru -WindowStyle Hidden
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

New-Item -ItemType Directory -Path $registryBackup -Force | Out-Null
foreach ($snapshot in $registrySnapshots) {
  Export-RegistrySnapshot $snapshot
}
if (Test-Path -LiteralPath $defaultInstallPath) {
  Move-Item -LiteralPath $defaultInstallPath -Destination $directoryBackup
  $defaultDirectoryMoved = $true
}
if (Test-Path -LiteralPath $legacyInstallPath) {
  Move-Item -LiteralPath $legacyInstallPath -Destination $legacyDirectoryBackup
  $legacyDirectoryMoved = $true
}

try {
  Remove-TestRegistry

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

  Write-Host 'Testing rejection of a stale installation path.'
  $stalePath = Join-Path $testRoot 'missing-old-install'
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

  Write-Host 'NSIS installer smoke test passed for clean, existing, stale, cleanup, and six language cases.'
}
finally {
  Restore-TestState
}
