param(
  [ValidateSet('debug', 'release')]
  [string]$Profile = 'debug'
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $projectRoot 'src-tauri\Cargo.toml'
$cargoArgs = @('build', '--manifest-path', $manifestPath, '--bin', 'clipcargo-native-host')
if ($Profile -eq 'release') { $cargoArgs += '--release' }

& cargo @cargoArgs
if ($LASTEXITCODE -ne 0) { throw "Native Host build failed with exit code $LASTEXITCODE." }

$hostTripleLine = (& rustc -vV | Select-String '^host:').Line
if (-not $hostTripleLine) { throw 'Unable to read the Rust host target.' }
$hostTriple = $hostTripleLine.Substring(5).Trim()
$source = Join-Path $projectRoot "src-tauri\target\$Profile\clipcargo-native-host.exe"
$binaryDirectory = Join-Path $projectRoot 'src-tauri\binaries'
$destination = Join-Path $binaryDirectory "clipcargo-native-host-$hostTriple.exe"
if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Native Host output is missing: $source" }
New-Item -ItemType Directory -Force -Path $binaryDirectory | Out-Null
Copy-Item -LiteralPath $source -Destination $destination -Force
Write-Output "Prepared Native Host sidecar: $destination"
