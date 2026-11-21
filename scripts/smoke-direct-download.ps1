param(
    [string]$Fixture,
    [int]$Port = 8765,
    [switch]$UsePythonModule
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($Fixture)) {
    $Fixture = Join-Path $projectRoot "reports\processing-smoke-2026-10-17\vfr-source.mp4"
}
$outputDirectory = Join-Path $PSScriptRoot "..\reports\download-smoke"
$downloadedFile = Join-Path $outputDirectory "local-fixture.mp4"
$fixtureDirectory = Split-Path -LiteralPath $Fixture
$fixtureName = [Uri]::EscapeDataString((Split-Path -Leaf $Fixture))

if (-not (Test-Path -LiteralPath $Fixture -PathType Leaf)) {
    throw "Fixture does not exist: $Fixture"
}

New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
Remove-Item -LiteralPath $downloadedFile -Force -ErrorAction SilentlyContinue

$server = Start-Process -FilePath "python" `
    -ArgumentList @("-m", "http.server", "$Port", "--bind", "127.0.0.1", "--directory", $fixtureDirectory) `
    -WindowStyle Hidden `
    -PassThru

try {
    Start-Sleep -Seconds 2
    $ytDlpCommand = if ($UsePythonModule) { "python" } else { "yt-dlp" }
    $ytDlpPrefix = if ($UsePythonModule) { @("-m", "yt_dlp") } else { @() }
    & $ytDlpCommand @ytDlpPrefix --ignore-config --no-part --no-playlist -o $downloadedFile "http://127.0.0.1:$Port/$fixtureName"
    if ($LASTEXITCODE -ne 0) {
        throw "yt-dlp exited with code $LASTEXITCODE"
    }

    $sourceHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $Fixture).Hash
    $downloadHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $downloadedFile).Hash
    $bytes = [System.IO.File]::ReadAllBytes($downloadedFile)
    $signature = [System.Text.Encoding]::ASCII.GetString($bytes, 4, [Math]::Min(4, $bytes.Length - 4))

    [pscustomobject]@{
        sourceBytes = (Get-Item -LiteralPath $Fixture).Length
        downloadedBytes = (Get-Item -LiteralPath $downloadedFile).Length
        sha256Match = ($sourceHash -eq $downloadHash)
        mp4Signature = $signature
        runner = if ($UsePythonModule) { "python-module" } else { "yt-dlp-exe" }
    } | ConvertTo-Json
}
finally {
    if ($null -ne $server -and -not $server.HasExited) {
        $server.Kill()
        $server.WaitForExit()
    }
}
