# Install this fork from GitLab without npm or a git+https link.
# Windows form of scripts/install-fork.sh. --dry-run prints the steps and runs nothing.
# The pack step runs npm ci first because npm pack runs agent-bundle prepack.
# No token is read or printed. Refuse Administrator unless -AllowRoot.
param(
  [string]$Ref = "main",
  [string]$Config = "",
  [switch]$DryRun,
  [switch]$AllowRoot
)

$ErrorActionPreference = "Stop"
$repo = "https://gitlab.com/aa22396584/grok-bot-cli.git"

if ($args -contains "--dry-run") { $DryRun = $true }
if ($args -contains "--allow-root") { $AllowRoot = $true }

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) -and -not $AllowRoot) {
  Write-Error "install-fork.ps1: refusing to run as Administrator; pass -AllowRoot"
  exit 2
}

$cacheRoot = if ($env:XDG_CACHE_HOME) { $env:XDG_CACHE_HOME } elseif ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA "grok-bot-cli\cache" } else { Join-Path $env:USERPROFILE ".cache" }
$cache = Join-Path $cacheRoot "grok-bot-cli\src"

function Get-AliasNames([string]$Path) {
  if (-not $Path) { return @() }
  $doc = Get-Content -Raw -Path $Path | ConvertFrom-Json
  if ($null -eq $doc.aliases) { return @() }
  return @($doc.aliases.PSObject.Properties.Name)
}

$steps = @(
  "git clone or fetch $repo into $cache",
  "git checkout $Ref",
  "npm ci",
  "npm pack",
  "npm install -g ./grok-bot-cli-*.tgz",
  "gbot --version",
  "gbot accounts"
)
if ($Config) { $steps += "gbot config import $Config" }
foreach ($name in (Get-AliasNames $Config)) {
  $steps += "gbot wake --check --account $name"
}
$steps += "summary: install ref $Ref from $repo"

if ($DryRun) {
  $steps | ForEach-Object { Write-Output $_ }
  exit 0
}

if (Test-Path (Join-Path $cache ".git")) {
  git -C $cache remote set-url origin $repo
  git -C $cache fetch --tags origin
} else {
  New-Item -ItemType Directory -Force -Path (Split-Path $cache) | Out-Null
  git clone $repo $cache
}
git -C $cache checkout $Ref
git -C $cache rev-parse --verify --quiet "origin/$Ref" 2>$null
if ($LASTEXITCODE -eq 0) {
  git -C $cache merge --ff-only "origin/$Ref"
}

Push-Location $cache
try {
  npm ci
  npm pack
  $tarball = Get-ChildItem -Name "grok-bot-cli-*.tgz" | Select-Object -First 1
  npm install -g (Join-Path $cache $tarball)
} finally {
  Pop-Location
}

gbot --version
gbot accounts

$importStatus = 0
if ($Config) {
  gbot config import $Config
  $importStatus = $LASTEXITCODE
  if ($importStatus -eq 2) { exit 2 }
}

foreach ($name in (Get-AliasNames $Config)) {
  gbot wake --check --account $name
  Write-Output "wake $name exit $LASTEXITCODE"
}

if ($importStatus -eq 3) {
  Write-Output "summary: installed $Ref; some imported logins are not signed in on this machine"
  exit 3
}
Write-Output "summary: installed $Ref"
exit 0
