param(
  [Parameter(Mandatory = $true)][ValidatePattern('^[a-z]{32}$')][string]$ExtensionId,
  [string]$HostExecutable = ""
)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
if (-not $HostExecutable) {
  $HostExecutable = Join-Path $projectRoot 'src-tauri\target\release\clipcargo-native-host.exe'
}
$hostPath = (Resolve-Path -LiteralPath $HostExecutable).Path
$manifestDirectory = Join-Path $env:LOCALAPPDATA 'net.clipcargo.desktop\native-messaging'
New-Item -ItemType Directory -Force -Path $manifestDirectory | Out-Null
$manifestPath = Join-Path $manifestDirectory 'net.clipcargo.native.json'

$manifest = [ordered]@{
  name = 'net.clipcargo.native'
  description = 'ClipCargo browser bridge'
  path = $hostPath
  type = 'stdio'
  allowed_origins = @("chrome-extension://$ExtensionId/")
}
$manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $manifestPath -Encoding UTF8

$registryPaths = @(
  'HKCU:\Software\Google\Chrome\NativeMessagingHosts\net.clipcargo.native',
  'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\net.clipcargo.native'
)
foreach ($registryPath in $registryPaths) {
  New-Item -Path $registryPath -Force | Out-Null
  Set-Item -Path $registryPath -Value $manifestPath
}

Write-Output "Registered ClipCargo native host for extension $ExtensionId"
Write-Output $manifestPath
