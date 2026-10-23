# Install this fork from GitLab without npm or a git+https link.
# Windows form of scripts/install-fork.sh. -DryRun and --dry-run print the steps and run nothing.
# The pack step runs npm ci first because npm pack runs agent-bundle prepack.
# No token is read or printed. Refuse Administrator unless -AllowRoot.
$ErrorActionPreference = "Stop"
$repo = "https://gitlab.com/aa22396584/grok-bot-cli.git"
$Ref = "main"
$Config = ""
$DryRun = $false
$AllowRoot = $false

for ($i = 0; $i -lt $args.Count; $i++) {
  $arg = [string]$args[$i]
  if ($arg -eq "-DryRun" -or $arg -eq "--dry-run" -or $arg -eq "-dry-run") { $DryRun = $true; continue }
  if ($arg -eq "-AllowRoot" -or $arg -eq "--allow-root" -or $arg -eq "--AllowRoot") { $AllowRoot = $true; continue }
  if ($arg -eq "-Config" -or $arg -eq "--config") {
    if ($i + 1 -ge $args.Count) { [Console]::Error.WriteLine("install-fork.ps1: --config needs a file"); exit 2 }
    $i++
    $Config = [string]$args[$i]
    continue
  }
  if ($arg -eq "--") {
    if ($i + 1 -lt $args.Count) { $Ref = [string]$args[$i + 1] }
    break
  }
  if ($arg.StartsWith("-")) { [Console]::Error.WriteLine("install-fork.ps1: unknown option $arg"); exit 2 }
  $Ref = $arg
}

if ($Ref.StartsWith("-") -or $Ref -notmatch '^[A-Za-z0-9._/-]+$') {
  [Console]::Error.WriteLine("install-fork.ps1: invalid ref")
  exit 2
}

if ($Config) {
  if (-not (Test-Path -LiteralPath $Config -PathType Leaf)) {
    [Console]::Error.WriteLine("install-fork.ps1: config is not a readable file: $Config")
    exit 2
  }
  $Config = (Resolve-Path -LiteralPath $Config).Path
}

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) -and -not $AllowRoot) {
  [Console]::Error.WriteLine("install-fork.ps1: refusing to run as Administrator; pass -AllowRoot")
  exit 2
}

if ($env:XDG_CACHE_HOME) {
  $cache = Join-Path $env:XDG_CACHE_HOME "grok-bot-cli\src"
} elseif ($env:LOCALAPPDATA) {
  $cache = Join-Path $env:LOCALAPPDATA "grok-bot-cli\src"
} else {
  $cache = Join-Path $env:USERPROFILE ".cache\grok-bot-cli\src"
}

function Get-AliasNames([string]$Path) {
  if (-not $Path) { return @() }
  $doc = Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
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
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  git -C $cache fetch --tags origin
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} else {
  New-Item -ItemType Directory -Force -Path (Split-Path $cache) | Out-Null
  git clone $repo $cache
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

$dirtyOutput = @(git -C $cache status --porcelain)
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$dirty = ($dirtyOutput -join "`n").Trim()
if ($dirty) {
  [Console]::Error.WriteLine("install-fork.ps1: cache is dirty; refusing to overwrite $cache")
  exit 2
}

$shaOutput = @(git -C $cache rev-parse --verify --quiet "refs/remotes/origin/$Ref^{commit}")
if ($LASTEXITCODE -ne 0) {
  $shaOutput = @(git -C $cache rev-parse --verify --quiet "refs/tags/$Ref^{commit}")
  if ($LASTEXITCODE -ne 0) {
    git -C $cache fetch origin -- $Ref
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    $shaOutput = @(git -C $cache rev-parse --verify "FETCH_HEAD^{commit}")
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  }
}
$sha = ($shaOutput -join "`n").Trim()
if ($sha -cnotmatch '^[0-9a-f]{40}([0-9a-f]{24})?$') {
  [Console]::Error.WriteLine("install-fork.ps1: resolved commit is not a git sha")
  exit 2
}
git -C $cache checkout --detach $sha
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Output "resolved commit $sha"

$packDir = Join-Path ([IO.Path]::GetTempPath()) ("grok-bot-cli-pack-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $packDir | Out-Null
Push-Location $cache
try {
  npm ci
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  $packOutput = @(npm pack --pack-destination $packDir)
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  $tarball = ($packOutput | Where-Object { $_ } | Select-Object -Last 1)
  if (-not $tarball -or -not (Test-Path -LiteralPath (Join-Path $packDir $tarball))) {
    [Console]::Error.WriteLine("install-fork.ps1: npm pack did not create $tarball")
    exit 1
  }
  npm install -g (Join-Path $packDir $tarball)
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
  Pop-Location
  Remove-Item -LiteralPath $packDir -Recurse -Force -ErrorAction SilentlyContinue
}

gbot --version
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
gbot accounts
if ($LASTEXITCODE -ne 0) { Write-Output "gbot accounts exit $LASTEXITCODE" }

$importStatus = 0
$importLog = @()
if ($Config) {
  $importLog = @(gbot config import $Config 2>&1)
  $importStatus = $LASTEXITCODE
  foreach ($line in $importLog) { Write-Output $line }
  if ($importStatus -ne 0 -and $importStatus -ne 3) { exit $importStatus }
}

function Test-ReportedMissing([string]$Name) {
  if ($script:importStatus -ne 3) { return $false }
  $email = ""
  if ($Config) {
    $doc = Get-Content -Raw -LiteralPath $Config | ConvertFrom-Json
    $alias = $doc.aliases.$Name
    if ($alias -and $alias.email) { $email = [string]$alias.email }
  }
  foreach ($line in @($script:importLog)) {
    $text = if ($line -is [System.Management.Automation.ErrorRecord]) { [string]$line.Exception.Message } else { [string]$line }
    if ($text -eq "sign in to $Name in the Grok Bot app") { return $true }
    if ($email -and $text -eq "sign in to $email in the Grok Bot app") { return $true }
  }
  return $false
}

foreach ($name in (Get-AliasNames $Config)) {
  if (Test-ReportedMissing $name) { continue }
  gbot wake --check --account $name
  if ($LASTEXITCODE -ne 0) {
    Write-Output "wake $name exit $LASTEXITCODE"
    exit $LASTEXITCODE
  }
}

if ($importStatus -eq 3) {
  Write-Output "summary: installed $Ref; some imported logins are not signed in on this machine"
  exit 3
}
Write-Output "summary: installed $Ref"
exit 0
