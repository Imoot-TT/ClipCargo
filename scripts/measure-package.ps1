param([string]$ReportDirectory = "")

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
if (-not $ReportDirectory) {
  $ReportDirectory = Join-Path $projectRoot 'reports\package'
}
New-Item -ItemType Directory -Force -Path $ReportDirectory | Out-Null

function Get-Sha256([string]$Path) {
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    try {
      return ([System.BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
    } finally {
      $algorithm.Dispose()
    }
  } finally {
    $stream.Dispose()
  }
}

$files = @()
$releaseRoot = Join-Path $projectRoot 'src-tauri\target\release'
$candidates = @(
  (Join-Path $releaseRoot 'clipcargo.exe'),
  (Join-Path $releaseRoot 'clipcargo-native-host.exe')
)
$bundleRoot = Join-Path $releaseRoot 'bundle'
if (Test-Path -LiteralPath $bundleRoot) {
  $candidates += Get-ChildItem -LiteralPath $bundleRoot -Recurse -File | Select-Object -ExpandProperty FullName
}
foreach ($candidate in $candidates | Select-Object -Unique) {
  if (Test-Path -LiteralPath $candidate) {
    $item = Get-Item -LiteralPath $candidate
    $files += [ordered]@{
      path = $item.FullName.Substring($projectRoot.Length + 1).Replace('\', '/')
      bytes = $item.Length
      mib = [Math]::Round($item.Length / 1MB, 3)
      sha256 = Get-Sha256 $item.FullName
    }
  }
}

$report = [ordered]@{
  schemaVersion = 1
  measuredAt = (Get-Date).ToUniversalTime().ToString('o')
  project = 'ClipCargo'
  version = '0.1.0'
  status = if ($files.Count) { 'measured' } else { 'no-release-artifacts' }
  note = 'M0 report. Component downloads and WebView2 are not included in these files.'
  files = $files
}
$path = Join-Path $ReportDirectory 'package-report.json'
$report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $path -Encoding UTF8
Write-Output $path
