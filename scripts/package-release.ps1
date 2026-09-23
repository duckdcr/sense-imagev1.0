$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ReleaseRoot = Join-Path $ProjectRoot "release"
$PackageDirectory = Join-Path $ReleaseRoot "sense-imagev1.0"
$RuntimeStash = Join-Path $ReleaseRoot "_runtime_stash"
$ZipPath = Join-Path $ReleaseRoot "sense-imagev1.0.zip"
$RuntimeSource = Join-Path $ProjectRoot "runtime"

if (!(Test-Path -LiteralPath (Join-Path $RuntimeSource "node.exe"))) {
  throw "Bundled Node runtime is missing: $RuntimeSource"
}

if (Test-Path -LiteralPath $RuntimeStash) {
  Remove-Item -LiteralPath $RuntimeStash -Recurse -Force
}
Copy-Item -LiteralPath $RuntimeSource -Destination $RuntimeStash -Recurse -Force

if (Test-Path -LiteralPath $PackageDirectory) {
  Remove-Item -LiteralPath $PackageDirectory -Recurse -Force
}
New-Item -ItemType Directory -Path $PackageDirectory -Force | Out-Null
Move-Item -LiteralPath $RuntimeStash -Destination (Join-Path $PackageDirectory "runtime")

foreach ($Directory in @("assets", "config", "node_modules", "public", "scripts", "src")) {
  Copy-Item -LiteralPath (Join-Path $ProjectRoot $Directory) -Destination (Join-Path $PackageDirectory $Directory) -Recurse -Force
}

foreach ($File in @("server.js", "package.json", "package-lock.json", "README.txt", "启动.bat", "start.bat")) {
  Copy-Item -LiteralPath (Join-Path $ProjectRoot $File) -Destination (Join-Path $PackageDirectory $File) -Force
}

New-Item -ItemType Directory -Path (Join-Path $PackageDirectory "data\history") -Force | Out-Null

foreach ($RequiredPath in @(
  "assets\curtain-product\grommet-template.png",
  "assets\curtain-product\double-pinch-template.png",
  "assets\curtain-scene\scene-1.png",
  "assets\curtain-scene\scene-2.png",
  "assets\curtain-scene\scene-3.png",
  "assets\curtain-scene\scene-4.png",
  "assets\curtain-scene\scene-5.png",
  "config\prompts.json",
  "node_modules\mysql2\package.json",
  "node_modules\sharp\package.json",
  "node_modules\@img\sharp-win32-x64\package.json",
  "public\custom.html",
  "public\custom.js",
  "public\customCore.js",
  "public\generationBatchPoller.js",
  "runtime\node.exe",
  "scripts\start.ps1",
  "scripts\verify-release.mjs",
  "src\promptSettings.js",
  "server.js",
  "启动.bat"
)) {
  $FullRequiredPath = Join-Path $PackageDirectory $RequiredPath
  if (!(Test-Path -LiteralPath $FullRequiredPath)) {
    throw "Release file is missing: $RequiredPath"
  }
}

& (Join-Path $PackageDirectory "runtime\node.exe") `
  (Join-Path $PackageDirectory "scripts\verify-release.mjs") `
  $PackageDirectory
if ($LASTEXITCODE -ne 0) {
  throw "Windows release verification failed."
}

foreach ($CacheDirectory in @(".playwright-cli", "artifacts", "logs", "output")) {
  $CachePath = Join-Path $ProjectRoot $CacheDirectory
  if (Test-Path -LiteralPath $CachePath) {
    Remove-Item -LiteralPath $CachePath -Recurse -Force
  }
}

if (Test-Path -LiteralPath $ZipPath) {
  Remove-Item -LiteralPath $ZipPath -Force
}
Compress-Archive -LiteralPath $PackageDirectory -DestinationPath $ZipPath -CompressionLevel Optimal

Get-Item -LiteralPath $ZipPath | Select-Object FullName, Length, LastWriteTime
