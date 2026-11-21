param(
  [string]$Version = '',
  [switch]$Store
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$extensionRoot = Join-Path $projectRoot 'extension'
$manifestPath = Join-Path $extensionRoot 'manifest.json'
$manifest = Get-Content -Raw -Encoding UTF8 -LiteralPath $manifestPath | ConvertFrom-Json
$resolvedVersion = if ($Version.Trim()) { $Version.Trim() } else { [string]$manifest.version }
$outputDirectory = Join-Path $projectRoot 'reports\package'
$packageSuffix = if ($Store) { '-store' } else { '' }
$outputPath = Join-Path $outputDirectory ("ClipCargo-extension-$resolvedVersion$packageSuffix.zip")
$stagingDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("clipcargo-extension-$resolvedVersion-" + [guid]::NewGuid().ToString('N'))

New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $stagingDirectory -Force | Out-Null
try {
  $files = @(
    'background.js', 'content.js', 'popup.html', 'popup.css', 'popup.js',
    'icons/32.png', 'icons/64.png', 'icons/128.png', 'icons/download.svg', 'icons/folder.svg'
  )
  $stagedManifest = if ($Store) {
    $copy = $manifest | ConvertTo-Json -Depth 16 | ConvertFrom-Json
    $copy.PSObject.Properties.Remove('key')
    $copy | ConvertTo-Json -Depth 16
  } else {
    Get-Content -Raw -Encoding UTF8 -LiteralPath $manifestPath
  }
  [System.IO.File]::WriteAllText((Join-Path $stagingDirectory 'manifest.json'), $stagedManifest, [System.Text.UTF8Encoding]::new($false))
  foreach ($relative in $files) {
    $source = Join-Path $extensionRoot $relative
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "扩展文件缺失：$relative" }
    $destination = Join-Path $stagingDirectory $relative
    New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
    Copy-Item -LiteralPath $source -Destination $destination -Force
  }
  if (Test-Path -LiteralPath $outputPath) { Remove-Item -LiteralPath $outputPath -Force }
  Compress-Archive -Path (Join-Path $stagingDirectory '*') -DestinationPath $outputPath -CompressionLevel Optimal
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try { $hash = ([System.BitConverter]::ToString($sha256.ComputeHash([System.IO.File]::ReadAllBytes($outputPath)))).Replace('-', '') }
  finally { $sha256.Dispose() }
  [pscustomobject]@{ path = $outputPath; version = $resolvedVersion; storePackage = [bool]$Store; sha256 = $hash; bytes = (Get-Item -LiteralPath $outputPath).Length } | ConvertTo-Json -Compress
}
finally {
  if (Test-Path -LiteralPath $stagingDirectory) { Remove-Item -LiteralPath $stagingDirectory -Recurse -Force }
}
