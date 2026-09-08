# Flyleaf - Android SDK setup WITHOUT Android Studio
#
# Installs only what `expo run:android` actually needs: a JDK and the Android
# command-line SDK. That is roughly 3-4 GB, not the ~10 GB Android Studio
# wants, and there is no IDE to configure.
#
#   cd D:\Bookmarked\flyleaf
#   .\scripts\setup-android.ps1
#
# Then, in a NEW terminal (so the env vars are picked up):
#
#   cd apps\mobile
#   npx expo run:android
#
# Safe to re-run: every step is skipped if already satisfied.

$ErrorActionPreference = 'Stop'

$SdkRoot = Join-Path $env:LOCALAPPDATA 'Android\Sdk'
$CmdlineDir = Join-Path $SdkRoot 'cmdline-tools'
$LatestDir = Join-Path $CmdlineDir 'latest'
$ToolsUrl = 'https://dl.google.com/android/repository/commandlinetools-win-13114758_latest.zip'

function Step { param([string] $Msg) Write-Host "`n==> $Msg" -ForegroundColor Cyan }
function Ok   { param([string] $Msg) Write-Host "    $Msg" -ForegroundColor Green }
function Note { param([string] $Msg) Write-Host "    $Msg" -ForegroundColor DarkGray }

# ---------------------------------------------------------------- 1. JDK 17
Step 'JDK 17'

$javaOk = $false
try {
    $verText = (& java -version 2>&1) -join ' '
    if ($verText -match 'version "?(\d+)') {
        $major = [int]$Matches[1]
        if ($major -ge 17 -and $major -le 21) {
            Ok "found Java $major"
            $javaOk = $true
        }
        else {
            Note "found Java $major - React Native 0.86 wants 17 (21 usually works, 25+ breaks Gradle)"
        }
    }
}
catch { }

if (-not $javaOk) {
    Note 'installing Microsoft OpenJDK 17 via winget'
    & winget install --id Microsoft.OpenJDK.17 --accept-source-agreements --accept-package-agreements
    Note 'if winget is unavailable, get it from https://learn.microsoft.com/java/openjdk/download'
}

# ---------------------------------------------------------------- 2. cmdline tools
Step 'Android command-line tools'

if (Test-Path (Join-Path $LatestDir 'bin\sdkmanager.bat')) {
    Ok "already at $LatestDir"
}
else {
    New-Item -ItemType Directory -Force -Path $CmdlineDir | Out-Null
    $zip = Join-Path $env:TEMP 'android-cmdline-tools.zip'
    $tmp = Join-Path $env:TEMP 'android-cmdline-extract'

    Note 'downloading (~150 MB)'
    Invoke-WebRequest -Uri $ToolsUrl -OutFile $zip -UseBasicParsing

    Note 'extracting'
    if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
    Expand-Archive -Path $zip -DestinationPath $tmp -Force

    # The zip contains a "cmdline-tools" folder; sdkmanager insists on being
    # at cmdline-tools/latest or it cannot find its own packages.
    $inner = Join-Path $tmp 'cmdline-tools'
    if (-not (Test-Path $inner)) { throw "unexpected archive layout in $tmp" }
    if (Test-Path $LatestDir) { Remove-Item $LatestDir -Recurse -Force }
    Move-Item -Path $inner -Destination $LatestDir

    Remove-Item $zip -Force
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    Ok "installed to $LatestDir"
}

# ---------------------------------------------------------------- 3. env vars
Step 'Environment variables (user scope, permanent)'

[Environment]::SetEnvironmentVariable('ANDROID_HOME', $SdkRoot, 'User')
$env:ANDROID_HOME = $SdkRoot
Ok "ANDROID_HOME = $SdkRoot"

$binDirs = @(
    (Join-Path $LatestDir 'bin'),
    (Join-Path $SdkRoot 'platform-tools')
)
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($null -eq $userPath) { $userPath = '' }

foreach ($dir in $binDirs) {
    if ($userPath -notlike "*$dir*") {
        if ($userPath -ne '' -and -not $userPath.EndsWith(';')) { $userPath += ';' }
        $userPath += $dir
        Ok "PATH += $dir"
    }
    if ($env:Path -notlike "*$dir*") { $env:Path = $env:Path + ';' + $dir }
}
[Environment]::SetEnvironmentVariable('Path', $userPath, 'User')

# ---------------------------------------------------------------- 4. packages
Step 'SDK packages'

$sdkmanager = Join-Path $LatestDir 'bin\sdkmanager.bat'
if (-not (Test-Path $sdkmanager)) { throw "sdkmanager not found at $sdkmanager" }

Note 'accepting licences'
# `y` repeatedly, because --licenses prompts once per licence.
$yes = ('y' + [Environment]::NewLine) * 40
$yes | & $sdkmanager --licenses 2>&1 | Select-String -Pattern 'All SDK package licenses accepted|accepted' | Select-Object -First 1

Note 'installing platform-tools, platform 36, build-tools 36'
& $sdkmanager --install 'platform-tools' 'platforms;android-36' 'build-tools;36.0.0'

# NDK: Reanimated and the RN core compile C++, so it is required. The exact
# version is pinned by the generated Gradle config, so install the current
# LTS and let Gradle name a different one if it disagrees.
Note 'installing NDK 27 (needed because Reanimated compiles native code)'
& $sdkmanager --install 'ndk;27.1.12297006' 'cmake;3.22.1'

# ---------------------------------------------------------------- done
Write-Host ''
Write-Host 'Done.' -ForegroundColor Green
Write-Host ''
Write-Host 'Open a NEW terminal (this one has stale environment variables), then:' -ForegroundColor Yellow
Write-Host ''
Write-Host '    cd D:\Bookmarked\flyleaf\apps\mobile'
Write-Host '    npx expo run:android'
Write-Host ''
Note 'Connect the phone by USB with Developer options + USB debugging enabled.'
Note 'Check the phone is visible with:  adb devices'
Note ''
Note 'If Gradle asks for a different NDK version, install exactly what it names:'
Note '    sdkmanager --install "ndk;<version it printed>"'
Note ''
Note 'First build takes 10-20 minutes. Later builds are ~1-2 minutes, and you'
Note 'only rebuild when a NATIVE dependency changes - JS and TS stream over Metro.'
