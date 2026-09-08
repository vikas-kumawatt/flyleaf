# Flyleaf - repair the Gradle wrapper download
#
# Symptom this fixes:
#
#   Downloading https://services.gradle.org/distributions/gradle-9.3.1-bin.zip
#   Exception in thread "main" java.io.IOException: ... failed: timeout (10000ms)
#   Caused by: java.net.SocketTimeoutException: Connect timed out
#
# Cause: gradle-wrapper.properties ships networkTimeout=10000. Ten seconds is
# not enough to open a TLS connection to services.gradle.org on a lot of
# connections, and the wrapper treats a slow handshake as a hard failure. The
# download itself is ~130 MB, so even a successful connect is a long transfer.
#
# What this does:
#   1. Raises networkTimeout in gradle-wrapper.properties.
#   2. Downloads the distribution itself, verifies its SHA-256, and places it
#      in the wrapper cache under the exact name the wrapper looks for.
#
# After it runs, `npx expo run:android` finds the zip already cached, unzips
# it, and never touches the network for Gradle again.
#
#   cd D:\Bookmarked\flyleaf
#   .\scripts\fix-gradle.ps1
#
# Safe to re-run. Re-run it after `expo prebuild --clean`, which regenerates
# gradle-wrapper.properties with the 10-second timeout back in place.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # PS 5.1 draws a progress bar so slowly it dominates the download

function Step { param([string] $Msg) Write-Host "`n==> $Msg" -ForegroundColor Cyan }
function Ok   { param([string] $Msg) Write-Host "    $Msg" -ForegroundColor Green }
function Note { param([string] $Msg) Write-Host "    $Msg" -ForegroundColor DarkGray }

$Root = Split-Path -Parent $PSScriptRoot
$Props = Join-Path $Root 'apps\mobile\android\gradle\wrapper\gradle-wrapper.properties'

if (-not (Test-Path $Props)) {
    throw "Not found: $Props`n    The android/ folder is generated. Run 'npx expo prebuild --platform android' in apps\mobile first."
}

# ------------------------------------------------------------ 1. read the URL
Step 'Reading gradle-wrapper.properties'

$lines = Get-Content $Props
$urlLine = $lines | Where-Object { $_ -match '^\s*distributionUrl\s*=' }
if (-not $urlLine) { throw "no distributionUrl in $Props" }

# The properties format escapes the colon: https\://...
$Url = ($urlLine -replace '^\s*distributionUrl\s*=\s*', '').Trim() -replace '\\:', ':'
$ZipName = $Url.Split('/')[-1]                       # gradle-9.3.1-bin.zip
$DistName = $ZipName -replace '\.zip$', ''           # gradle-9.3.1-bin

Ok "url  $Url"
Ok "dist $DistName"

# ------------------------------------------------------------ 2. raise the timeout
Step 'Raising networkTimeout'

$TimeoutMs = 120000
if ($lines | Where-Object { $_ -match '^\s*networkTimeout\s*=' }) {
    $current = [int](($lines | Where-Object { $_ -match '^\s*networkTimeout\s*=' } | Select-Object -First 1) -replace '\D', '')
    if ($current -ge $TimeoutMs) {
        Ok "already $current ms"
    }
    else {
        ($lines -replace '^\s*networkTimeout\s*=.*', "networkTimeout=$TimeoutMs") | Set-Content $Props -Encoding Ascii
        Ok "$current ms -> $TimeoutMs ms"
    }
}
else {
    Add-Content $Props "networkTimeout=$TimeoutMs" -Encoding Ascii
    Ok "added networkTimeout=$TimeoutMs"
}

# ------------------------------------------------------------ 3. locate the cache slot
Step 'Locating the wrapper cache slot'

# GRADLE_USER_HOME wins if set, which it is on some corporate images.
$GradleHome = if ($env:GRADLE_USER_HOME) { $env:GRADLE_USER_HOME } else { Join-Path $env:USERPROFILE '.gradle' }
$DistParent = Join-Path $GradleHome "wrapper\dists\$DistName"

# The wrapper puts each distribution in a subfolder named after a hash of the
# URL string: base36 of the unsigned MD5, exactly as Java's
# BigInteger(1, md5).toString(36) produces it. A failed run has usually
# created that folder already, so prefer what is on disk over recomputing.
$existing = if (Test-Path $DistParent) { Get-ChildItem $DistParent -Directory -ErrorAction SilentlyContinue } else { $null }

if ($existing -and $existing.Count -eq 1) {
    $SlotDir = $existing[0].FullName
    Note 'using the folder the failed run created'
}
else {
    $md5 = [System.Security.Cryptography.MD5]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($Url))
    $be = [byte[]]::new($md5.Length)
    [Array]::Copy($md5, $be, $md5.Length)
    [Array]::Reverse($be)                       # .NET BigInteger reads little-endian
    $bytes = [byte[]]($be + [byte]0)            # trailing zero byte forces a positive value
    $n = [System.Numerics.BigInteger]::new($bytes)

    $digits = '0123456789abcdefghijklmnopqrstuvwxyz'
    $thirtySix = [System.Numerics.BigInteger]36
    $hash = ''
    if ($n -eq 0) {
        $hash = '0'
    }
    else {
        while ($n -gt 0) {
            $hash = [string]$digits[[int]($n % $thirtySix)] + $hash
            $n = [System.Numerics.BigInteger]::Divide($n, $thirtySix)
        }
    }
    $SlotDir = Join-Path $DistParent $hash
    Note "computed slot name $hash"
}

New-Item -ItemType Directory -Force -Path $SlotDir | Out-Null
Ok $SlotDir

$Zip = Join-Path $SlotDir $ZipName

# Already unpacked? Then Gradle is fine and there is nothing to download.
if (Get-ChildItem $SlotDir -Directory -Filter 'gradle-*' -ErrorAction SilentlyContinue) {
    Ok 'distribution is already unpacked - nothing to download'
    Write-Host ''
    Write-Host 'Done.' -ForegroundColor Green
    exit 0
}

# ------------------------------------------------------------ 4. checksum
Step 'Fetching the official SHA-256'

# Fetched rather than hardcoded, so this keeps working when React Native
# bumps its Gradle version.
$Expected = $null
try {
    $Expected = (Invoke-WebRequest -Uri "$Url.sha256" -UseBasicParsing -TimeoutSec 60).Content
    $Expected = ([string]$Expected).Trim().ToLower()
    if ($Expected -notmatch '^[0-9a-f]{64}$') { $Expected = $null }
}
catch { }

if ($Expected) { Ok $Expected } else { Note 'could not fetch it - will download without verifying' }

# ------------------------------------------------------------ 5. download
Step "Downloading $ZipName (~130 MB)"

if ((Test-Path $Zip) -and (Get-Item $Zip).Length -gt 50MB) {
    Ok 'zip already present'
}
else {
    $part = "$Zip.part"
    $done = $false
    for ($attempt = 1; $attempt -le 3 -and -not $done; $attempt++) {
        try {
            Note "attempt $attempt"
            Invoke-WebRequest -Uri $Url -OutFile $part -UseBasicParsing -TimeoutSec 1800
            $done = $true
        }
        catch {
            Note "failed: $($_.Exception.Message)"
            Remove-Item $part -Force -ErrorAction SilentlyContinue
            if ($attempt -eq 3) { throw }
            Start-Sleep -Seconds 5
        }
    }
    Move-Item -Path $part -Destination $Zip -Force
    Ok ('downloaded {0:N0} MB' -f ((Get-Item $Zip).Length / 1MB))
}

# ------------------------------------------------------------ 6. verify
Step 'Verifying'

if ($Expected) {
    $actual = (Get-FileHash -Path $Zip -Algorithm SHA256).Hash.ToLower()
    if ($actual -ne $Expected) {
        Remove-Item $Zip -Force
        throw "SHA-256 mismatch. Expected $Expected, got $actual. The file has been deleted; re-run this script."
    }
    Ok 'SHA-256 matches'
}
else {
    Note 'skipped - checksum was unavailable'
}

# ------------------------------------------------------------ done
Write-Host ''
Write-Host 'Done.' -ForegroundColor Green
Write-Host ''
Write-Host 'Now, in apps\mobile:' -ForegroundColor Yellow
Write-Host ''
Write-Host '    npx expo run:android'
Write-Host ''
Note 'Gradle will find the zip already cached and unpack it locally.'
Note 'The first build after that is 10-20 minutes: it compiles the native'
Note 'modules. Later builds are 1-2 minutes.'
