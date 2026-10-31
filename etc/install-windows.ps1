param([string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'ClawTab'))
$ErrorActionPreference = 'Stop'
# Run from an extracted, checksum-verified Windows host package. No administrator
# privileges or WSL are required. Existing owner executables are never replaced.
if ([Environment]::OSVersion.Version.Build -lt 17763) { throw 'Windows 10 1809 or newer is required for ConPTY.' }
$packageBin = Join-Path $PSScriptRoot 'bin'
foreach ($name in @('cwt.exe', 'clawtab-daemon.exe', 'clawtab-hook.exe')) {
    if (!(Test-Path (Join-Path $packageBin $name))) { throw "Package is missing $name" }
}
$version = (& (Join-Path $packageBin 'cwt.exe') --version).Trim()
if ($LASTEXITCODE -ne 0 -or $version -notmatch '^\d+\.\d+\.\d+[-+A-Za-z0-9.]*$') { throw 'Invalid host version' }
# A unique directory also makes reinstalling the same version safe while its
# launchers are running. Old directories may be removed after their sessions end.
$destination = Join-Path $InstallRoot ("versions\$version-" + [Guid]::NewGuid().ToString('N'))
$shimDirectory = Join-Path $InstallRoot 'bin'
New-Item -ItemType Directory -Force $destination, $shimDirectory | Out-Null
Copy-Item (Join-Path $packageBin '*.exe') $destination
$executable = Join-Path $destination 'cwt.exe'
$shim = Join-Path $shimDirectory 'cwt.cmd'
$oldShim = $shim
if (!(Test-Path $oldShim)) { $oldShim = Join-Path $shimDirectory 'cwtctl.cmd' }
$wasInstalled = Test-Path $oldShim
if ($wasInstalled) {
    & $oldShim daemon stop
    if ($LASTEXITCODE -ne 0) { throw 'Could not stop the previous host; existing sessions have been left running.' }
}
$temporaryShim = Join-Path $shimDirectory ([Guid]::NewGuid().ToString('N') + '.cmd')
@('@echo off', ('"%~dp0..\versions\' + (Split-Path -Leaf $destination) + '\cwt.exe" %*'), 'exit /b %errorlevel%') | Set-Content -Encoding ASCII $temporaryShim
Move-Item -Force $temporaryShim $shim
$config = Join-Path $env:USERPROFILE '.config/clawtab'
$plugins = Join-Path $config 'agent-plugins'
New-Item -ItemType Directory -Force $plugins | Out-Null
$shortcuts = Join-Path $PSScriptRoot 'plugins/local.session-shortcuts'
if ((Test-Path $shortcuts) -and !(Test-Path (Join-Path $plugins 'local.session-shortcuts'))) { Copy-Item -Recurse $shortcuts $plugins }
[string]$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (($userPath -split ';') -notcontains $shimDirectory) {
    [Environment]::SetEnvironmentVariable('Path', (($userPath.TrimEnd(';') + ';' + $shimDirectory).TrimStart(';')), 'User')
}
if (($env:Path -split ';') -notcontains $shimDirectory) { $env:Path += ';' + $shimDirectory }
if ($wasInstalled) {
    & $executable daemon install
    if ($LASTEXITCODE -ne 0) { throw 'Installed, but host startup failed. Run cwt daemon install to retry.' }
}
Write-Host "Installed ClawTab $version. Run cwt setup to pair this computer."
Write-Host 'Start an agent with: cwt session start -- codex'
Write-Host 'Open a new terminal to pick up PATH changes. Existing managed sessions keep their original launcher.'
