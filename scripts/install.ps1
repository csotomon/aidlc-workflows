[CmdletBinding()]
param(
  [Parameter()]
  [ValidatePattern('^[a-z0-9][a-z0-9-]*$')]
  [string[]]$Harness,

  [Parameter()]
  [ValidatePattern('^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$')]
  [string]$Version,

  [Parameter()]
  [string]$From,

  [Parameter()]
  [switch]$Offline,

  [Parameter()]
  [string]$ReleaseBaseUrl = $(if ($env:AIDLC_RELEASE_BASE_URL) {
    $env:AIDLC_RELEASE_BASE_URL
  } else {
    'https://github.com/awslabs/aidlc-workflows/releases'
  }),

  [Parameter()]
  [string]$CaBundle = $env:AIDLC_CA_BUNDLE,

  [Parameter()]
  [switch]$Yes,

  [Parameter()]
  [switch]$Quiet,

  [Parameter()]
  [switch]$Json,

  [Parameter()]
  [switch]$NoColor
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Write-Result {
  param(
    [bool]$Ok,
    [int]$Code,
    [string]$Status,
    [string]$Message,
    [string]$Remediation = ''
  )
  if ($Json) {
    $result = [ordered]@{
      schemaVersion = 1
      ok = $Ok
      code = $Code
      status = $Status
      message = $Message
    }
    if ($Remediation) { $result.remediation = $Remediation }
    $result | ConvertTo-Json -Compress
  } elseif ($Quiet) {
    if ($Remediation -and -not $Ok) { $Remediation } else { $Message }
  } elseif ($Ok) {
    Write-Host "PASS $Message"
  } else {
    [Console]::Error.WriteLine("$(if ($Code -eq 4) { 'FAIL' } else { 'ERROR' }) $Message")
    if ($Remediation) { [Console]::Error.WriteLine("Run: $Remediation") }
  }
  $global:LASTEXITCODE = $Code
}

function Stop-Install {
  param(
    [int]$Code,
    [string]$Status,
    [string]$Message,
    [string]$Remediation = ''
  )
  Write-Result $false $Code $Status $Message $Remediation
  exit $Code
}

function Get-ReleaseFile {
  param([string]$Url, [string]$Output)
  if (-not $Quiet -and -not $Json) {
    [Console]::Error.WriteLine("Downloading $([IO.Path]::GetFileName($Output))...")
  }
  $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
  if ($curl) {
    $arguments = @('--fail', '--silent', '--show-error', '--location')
    if ($CaBundle) { $arguments += @('--cacert', $CaBundle) }
    $arguments += @('--output', $Output, $Url)
    & $curl.Source @arguments
    if ($LASTEXITCODE -ne 0) {
      Stop-Install 3 'unavailable' 'download failed' 'check the release URL, proxy, and CA bundle'
    }
    return
  }
  if ($CaBundle) {
    Stop-Install 1 'failed' 'curl.exe is required when --CaBundle is used'
  }
  try {
    Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Output
  } catch {
    Stop-Install 3 'unavailable' 'download failed' 'check the release URL and proxy'
  }
}

function Get-ExpectedHash {
  param([string]$Checksums, [string]$Name)
  $escaped = [Regex]::Escape($Name)
  $rows = @(Get-Content -LiteralPath $Checksums | Where-Object {
    $_ -match "^([a-f0-9]{64})  $escaped$"
  })
  if ($rows.Count -ne 1) {
    Stop-Install 4 'failed' "checksums.txt has no unique row for $Name"
  }
  return ($rows[0] -split '  ', 2)[0]
}

function Confirm-NotAdministrator {
  if ($env:AIDLC_ALLOW_ADMIN_INSTALL -eq '1') { return }
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Stop-Install 4 'failed' 'refusing an Administrator install; run as the target user'
  }
}

Confirm-NotAdministrator

if ($env:AIDLC_OFFLINE -eq '1') {
  $Offline = $true
}
if ($Offline -and -not $From) {
  Stop-Install 3 'unavailable' '--Offline requires --From <release-directory>'
}
if ($From) {
  $Offline = $true
  $From = [IO.Path]::GetFullPath($From)
  if (-not (Test-Path -LiteralPath $From -PathType Container)) {
    Stop-Install 2 'usage' "offline source is not a directory: $From"
  }
  if (-not (Test-Path -LiteralPath (Join-Path $From 'install.ps1') -PathType Leaf)) {
    Stop-Install 4 'failed' 'offline source is missing install.ps1'
  }
}
if (-not $From) {
  try {
    $releaseUri = [Uri]::new($ReleaseBaseUrl)
  } catch {
    Stop-Install 2 'usage' 'release URL is invalid'
  }
  if ($releaseUri.UserInfo -or $releaseUri.Query -or $releaseUri.Fragment) {
    Stop-Install 4 'failed' 'release URL must not include credentials, a query, or a fragment'
  }
  if ($releaseUri.Scheme -ne 'https' -and
    -not ($releaseUri.Scheme -eq 'http' -and $releaseUri.IsLoopback)) {
    Stop-Install 4 'failed' 'release URL must use HTTPS'
  }
}
if ($CaBundle -and -not [IO.Path]::IsPathRooted($CaBundle)) {
  Stop-Install 2 'usage' '--CaBundle must be an absolute path'
}

$installRoot = if ($env:AIDLC_INSTALL_ROOT) {
  [IO.Path]::GetFullPath($env:AIDLC_INSTALL_ROOT)
} else {
  Join-Path $env:LOCALAPPDATA 'aidlc'
}
$binDir = if ($env:AIDLC_BIN_DIR) {
  [IO.Path]::GetFullPath($env:AIDLC_BIN_DIR)
} else {
  Join-Path $installRoot 'bin'
}
$command = Join-Path $binDir 'aidlc.cmd'
$existingAidlc = Get-Command aidlc -CommandType Application -ErrorAction SilentlyContinue |
  Select-Object -First 1
if (-not $env:AIDLC_BIN_DIR -and $existingAidlc -and
  -not [IO.Path]::GetFullPath($existingAidlc.Source).Equals(
    [IO.Path]::GetFullPath($command),
    [StringComparison]::OrdinalIgnoreCase
  )) {
  Stop-Install 4 'failed' "existing aidlc at $($existingAidlc.Source) is outside the native install destination" 'use its package manager, or set AIDLC_BIN_DIR to an explicit empty directory'
}
$temporary = Join-Path ([IO.Path]::GetTempPath()) "aidlc-install-$PID-$([Guid]::NewGuid().ToString('N'))"
[IO.Directory]::CreateDirectory($temporary) | Out-Null

try {
  $metadataSegment = if ($Version) { "download/v$Version" } else { 'latest/download' }
  $metadata = @('version.json', 'checksums.txt')
  foreach ($name in $metadata) {
    $output = Join-Path $temporary $name
    if ($From) {
      $source = Join-Path $From $name
      if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        Stop-Install 4 'failed' "offline source is missing $name"
      }
      Copy-Item -LiteralPath $source -Destination $output
    } else {
      Get-ReleaseFile "$($ReleaseBaseUrl.TrimEnd('/'))/$metadataSegment/$name" $output
    }
  }

  $manifestPath = Join-Path $temporary 'version.json'
  $checksumsPath = Join-Path $temporary 'checksums.txt'
  foreach ($metadataPath in @($manifestPath, $checksumsPath)) {
    if ((Get-Item -LiteralPath $metadataPath).Length -gt 1MB) {
      Stop-Install 4 'failed' "$([IO.Path]::GetFileName($metadataPath)) exceeds the 1 MiB metadata limit"
    }
  }
  $manifestHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $manifestPath).Hash.ToLowerInvariant()
  if ($manifestHash -ne (Get-ExpectedHash $checksumsPath 'version.json')) {
    Stop-Install 4 'failed' 'checksum mismatch for version.json'
  }
  $verifiedInstaller = Join-Path $temporary 'install.ps1'
  if ($From) {
    Copy-Item -LiteralPath (Join-Path $From 'install.ps1') -Destination $verifiedInstaller
  } else {
    Get-ReleaseFile "$($ReleaseBaseUrl.TrimEnd('/'))/$metadataSegment/install.ps1" $verifiedInstaller
  }
  $installerHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $verifiedInstaller).Hash.ToLowerInvariant()
  if ($installerHash -ne (Get-ExpectedHash $checksumsPath 'install.ps1')) {
    Stop-Install 4 'failed' 'checksum mismatch for install.ps1'
  }
  $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
  if ($manifest.schemaVersion -ne 1 -or $manifest.version -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') {
    Stop-Install 4 'failed' 'version.json has an invalid schema or version'
  }
  if ($Version -and $manifest.version -ne $Version) {
    Stop-Install 4 'failed' "release endpoint returned $($manifest.version), not requested $Version"
  }
  $Version = $manifest.version

  if (-not $Harness -or $Harness.Count -eq 0) {
    if ([Console]::IsInputRedirected -or $Json -or $Quiet -or $Yes) {
      Stop-Install 2 'usage' 'a harness is required in non-interactive installs; pass -Harness <name>'
    }
    $available = @($manifest.distributions)
    for ($index = 0; $index -lt $available.Count; $index++) {
      Write-Host "$($index + 1)) $($available[$index].name) - $($available[$index].productName)"
    }
    $selection = Read-Host "Harness [1-$($available.Count)]"
    if ($selection -notmatch '^[0-9]+$' -or [int]$selection -lt 1 -or [int]$selection -gt $available.Count) {
      Stop-Install 2 'usage' 'invalid harness selection'
    }
    $Harness = @($available[[int]$selection - 1].name)
  }

  $assets = @("aidlc-windows-x64.exe") +
    @($Harness | ForEach-Object { "aidlc-data-$_.tgz" })
  foreach ($name in $assets) {
    $asset = @($manifest.assets | Where-Object { $_.name -eq $name })
    if ($asset.Count -ne 1) {
      Stop-Install 3 'unavailable' "release does not provide $name"
    }
    $expected = Get-ExpectedHash $checksumsPath $name
    if ($asset[0].sha256 -ne $expected) {
      Stop-Install 4 'failed' "$name checksum metadata does not match version.json"
    }
    $output = Join-Path $temporary $name
    if ($From) {
      $source = Join-Path $From $name
      if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        Stop-Install 4 'failed' "offline source is missing $name"
      }
      Copy-Item -LiteralPath $source -Destination $output
    } else {
      Get-ReleaseFile "$($ReleaseBaseUrl.TrimEnd('/'))/download/v$Version/$name" $output
    }
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $output).Hash.ToLowerInvariant()
    if ($actual -ne $expected) {
      Stop-Install 4 'failed' "checksum mismatch for $name"
    }
    if ((Get-Item -LiteralPath $output).Length -ne [long]$asset[0].bytes) {
      Stop-Install 4 'failed' "size mismatch for $name"
    }
    Unblock-File -LiteralPath $output -ErrorAction SilentlyContinue
  }

  $binary = Join-Path $temporary 'aidlc-windows-x64.exe'
  $arguments = @('__delegate', 'lifecycle', 'install-apply', '--version', $Version, '--from', $temporary)
  foreach ($name in $Harness) { $arguments += @('--harness', $name) }
  $applyOutput = (& $binary @arguments --json | Out-String).Trim()
  $applyCode = $LASTEXITCODE
  try {
    $applyResult = $applyOutput | ConvertFrom-Json
  } catch {
    Stop-Install 1 'failed' 'verified installer binary returned an invalid result'
  }
  if ($applyCode -ne 0) {
    Stop-Install $applyCode $applyResult.status $applyResult.message $applyResult.remediation
  }

  $pathCommand = ''
  $resolvedAidlc = Get-Command aidlc -CommandType Application -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if (-not $resolvedAidlc -or
    -not [IO.Path]::GetFullPath($resolvedAidlc.Source).Equals(
      [IO.Path]::GetFullPath($command),
      [StringComparison]::OrdinalIgnoreCase
    )) {
    $pathCommand = "`$env:Path = '$($binDir.Replace("'", "''"));' + `$env:Path"
    $env:Path = "$binDir;$env:Path"
    $resolvedAidlc = Get-Command aidlc -CommandType Application -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if (-not $resolvedAidlc -or
      -not [IO.Path]::GetFullPath($resolvedAidlc.Source).Equals(
        [IO.Path]::GetFullPath($command),
        [StringComparison]::OrdinalIgnoreCase
      )) {
      Stop-Install 4 'failed' 'installed aidlc is not resolvable after applying the PATH update'
    }
  }
  if ($pathCommand -and -not $Quiet -and -not $Json) {
    Write-Host "For each new PowerShell session, run: $pathCommand"
  }
  $message = "installed AI-DLC $Version; command: $command"
  if ($pathCommand -and $Quiet) { $message = "$message; run $pathCommand in a new session" }
  Write-Result $true 0 'ok' $message
} catch {
  Stop-Install 4 'failed' "installer validation failed: $($_.Exception.Message)"
} finally {
  Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction SilentlyContinue
}
