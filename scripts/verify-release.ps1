param(
  [string]$ExpectedVersion = ''
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$package = Get-Content -Raw -Encoding UTF8 (Join-Path $projectRoot 'package.json') | ConvertFrom-Json
$manifest = Get-Content -Raw -Encoding UTF8 (Join-Path $projectRoot 'extension/manifest.json') | ConvertFrom-Json
$tauri = Get-Content -Raw -Encoding UTF8 (Join-Path $projectRoot 'src-tauri/tauri.conf.json') | ConvertFrom-Json
$cargoText = Get-Content -Raw -Encoding UTF8 (Join-Path $projectRoot 'src-tauri/Cargo.toml')
$cargoVersion = [regex]::Match($cargoText, '(?m)^version\s*=\s*"([^"]+)"').Groups[1].Value
$versions = [ordered]@{
  package = [string]$package.version
  extension = [string]$manifest.version
  tauri = [string]$tauri.version
  cargo = $cargoVersion
}
$uniqueVersions = @($versions.Values | Sort-Object -Unique)
if ($uniqueVersions.Count -ne 1) { throw "Version mismatch: $($versions | ConvertTo-Json -Compress)" }
if ($ExpectedVersion.Trim() -and $versions.package -ne $ExpectedVersion.Trim().TrimStart('v')) {
  throw "Expected version $ExpectedVersion but found $($versions.package)"
}

[pscustomobject]@{ ok = $true; version = $versions.package; sources = $versions } | ConvertTo-Json -Compress
