<#
.SYNOPSIS
  Builds the signed DYX GCS release APK on Windows, start to finish, from one script.

.DESCRIPTION
  1. Installs Git, Node.js LTS and JDK 17 with winget if they are missing.
  2. Installs the Android SDK pieces the app needs (platform 36, build-tools 36.0.0, NDK 27.1.12297006, CMake 3.22.1).
  3. Clones (or fast-forwards) Three_Wheel_v2 into -Root, then npm ci and expo prebuild.
  4. Asks for the release keystore path and passwords, checks the key's SHA-256 against the production key,
     builds with Gradle, and checks that the APK carries that same signer.
  5. Copies the APK to the Desktop.

  Secrets: passwords are typed as SecureString, held only in this process's environment (DYX_RELEASE_*),
  never written to a file or the log, and removed when the script ends. The keystore stays where you put it.
  Nothing here is committed or pushed.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\build-release-windows.ps1
  powershell -ExecutionPolicy Bypass -File .\build-release-windows.ps1 -KeystorePath D:\keys\dyx-gcs-release.keystore
#>
[CmdletBinding()]
param(
  [string]$Root = 'C:\dyx\Three_Wheel_v2',
  [string]$Repo = 'https://github.com/yasarbaiiiii-blip/Three_Wheel_v2.git',
  [string]$Branch = '',
  [string]$KeystorePath = '',
  [string]$KeyAlias = 'dyx-gcs-release',
  [string]$MapboxToken = '',
  [switch]$CleanPrebuild
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# SHA-256 of the production release certificate (public value, not a secret). The build is refused if the
# keystore or the finished APK does not match it, because an APK signed with any other key cannot update
# the apps already installed on the tablets.
$ExpectedSha256 = '5EAACB96AE13DD3CF8E27754E764C6D5E5BB0A14FEC37F1D94F152465DA94C9A'
$SdkPackages = @('platform-tools', 'platforms;android-36', 'build-tools;36.0.0', 'ndk;27.1.12297006', 'cmake;3.22.1')
$CmdlineToolsUrl = 'https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip'

function Step($text) { Write-Host ""; Write-Host "=== $text" -ForegroundColor Cyan }
function Fail($text) { Write-Host "STOP: $text" -ForegroundColor Red; throw $text }
function Have($name) { return [bool](Get-Command $name -ErrorAction SilentlyContinue) }
function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}
function Invoke-Native([string]$What, [scriptblock]$Command) {
  $saved = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $Command } finally { $ErrorActionPreference = $saved }
  if ($LASTEXITCODE -ne 0) { Fail "$What failed (exit code $LASTEXITCODE)" }
}
function Read-Secret([string]$Prompt) {
  $secure = Read-Host $Prompt -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}
function Normalize-Hex([string]$text) { return ($text -replace '[^0-9A-Fa-f]', '').ToUpper() }
function Winget-Install([string]$Id) {
  if (-not (Have 'winget')) { Fail "winget is not available. Install '$Id' by hand, then run this script again." }
  Invoke-Native "winget install $Id" { winget install -e --id $Id --silent --accept-package-agreements --accept-source-agreements }
  Refresh-Path
}

$logDir = Split-Path -Parent $Root
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
Start-Transcript -Path (Join-Path $logDir 'build-release-windows.log') -Force | Out-Null

try {
  # ---------------------------------------------------------------- 1. tools
  Step '1/8  Tools: Git, Node.js, JDK 17'
  Refresh-Path
  if (-not (Have 'git')) { Winget-Install 'Git.Git' }
  $nodeOk = $false
  if (Have 'node') { $nodeOk = ([int](((node --version) -replace '^v', '') -split '\.')[0]) -ge 20 }
  if (-not $nodeOk) { Winget-Install 'OpenJS.NodeJS.LTS' }

  $javaOk = $false
  if (Have 'java') {
    $savedEap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    $javaOk = ((java -version 2>&1) -join ' ') -match 'version "17\.'
    $ErrorActionPreference = $savedEap
  }
  if (-not $javaOk) {
    Winget-Install 'Microsoft.OpenJDK.17'
    $jdk = Get-ChildItem 'C:\Program Files\Microsoft' -Directory -Filter 'jdk-17*' -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
    if (-not $jdk) { Fail 'JDK 17 was installed but its folder was not found under C:\Program Files\Microsoft.' }
    $env:JAVA_HOME = $jdk.FullName
  } elseif (-not $env:JAVA_HOME -or -not (Test-Path (Join-Path $env:JAVA_HOME 'bin\keytool.exe'))) {
    $env:JAVA_HOME = Split-Path -Parent (Split-Path -Parent (Get-Command java).Source)
  }
  $env:Path = "$env:JAVA_HOME\bin;$env:Path"
  foreach ($tool in 'git', 'node', 'npm', 'java') { if (-not (Have $tool)) { Fail "$tool is still not on PATH. Close this window, open a new PowerShell and run the script again." } }
  $keytool = Join-Path $env:JAVA_HOME 'bin\keytool.exe'
  if (-not (Test-Path $keytool)) { Fail "keytool not found under JAVA_HOME ($env:JAVA_HOME)." }
  Write-Host ("git " + (git --version)) ; Write-Host ("node " + (node --version)) ; Write-Host "JAVA_HOME $env:JAVA_HOME"

  # Windows' 260-character path limit breaks native (CMake/Ninja) builds in deep node_modules paths.
  Invoke-Native 'git config' { git config --global core.longpaths true }
  try {
    New-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' -Name 'LongPathsEnabled' -Value 1 -PropertyType DWord -Force -ErrorAction Stop | Out-Null
  } catch { Write-Host 'note: long paths not enabled system-wide (needs an administrator window); the short -Root path avoids the problem.' }

  # ---------------------------------------------------------------- 2. SDK
  Step '2/8  Android SDK'
  $Sdk = Join-Path $env:LOCALAPPDATA 'Android\Sdk'
  $sdkmanager = Join-Path $Sdk 'cmdline-tools\latest\bin\sdkmanager.bat'
  if (-not (Test-Path $sdkmanager)) {
    $zip = Join-Path $env:TEMP 'android-cmdline-tools.zip'
    $tmp = Join-Path $env:TEMP 'android-cmdline-tools'
    Write-Host "downloading $CmdlineToolsUrl"
    Invoke-WebRequest -Uri $CmdlineToolsUrl -OutFile $zip
    if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
    Expand-Archive -Path $zip -DestinationPath $tmp -Force
    New-Item -ItemType Directory -Force -Path (Join-Path $Sdk 'cmdline-tools') | Out-Null
    $latest = Join-Path $Sdk 'cmdline-tools\latest'
    if (Test-Path $latest) { Remove-Item -Recurse -Force $latest }
    Move-Item -Path (Join-Path $tmp 'cmdline-tools') -Destination $latest
    Remove-Item -Force $zip
  }
  $env:ANDROID_HOME = $Sdk
  $env:ANDROID_SDK_ROOT = $Sdk
  Write-Host 'accepting SDK licences'
  $saved = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  1..60 | ForEach-Object { 'y' } | & $sdkmanager "--sdk_root=$Sdk" --licenses | Out-Null
  $ErrorActionPreference = $saved
  Write-Host ("installing: " + ($SdkPackages -join ', '))
  Invoke-Native 'sdkmanager' { & $sdkmanager "--sdk_root=$Sdk" @SdkPackages }
  $apksigner = Join-Path $Sdk 'build-tools\36.0.0\apksigner.bat'
  $aapt2 = Join-Path $Sdk 'build-tools\36.0.0\aapt2.exe'
  if (-not (Test-Path $apksigner)) { Fail "apksigner not found at $apksigner" }

  # ---------------------------------------------------------------- 3. source
  Step "3/8  Source: $Repo"
  if (Test-Path (Join-Path $Root '.git')) {
    Invoke-Native 'git fetch' { git -C $Root fetch origin }
    if ($Branch) { Invoke-Native 'git checkout' { git -C $Root checkout $Branch } }
    $dirty = git -C $Root status --porcelain
    if ($dirty) { Write-Host 'note: the working tree has local changes; skipping the pull so they are not disturbed.' }
    else { Invoke-Native 'git pull' { git -C $Root pull --ff-only } }
  } else {
    if (Test-Path $Root) { Fail "$Root exists but is not a git checkout. Move it away or pass a different -Root." }
    Invoke-Native 'git clone' { git clone $Repo $Root }
    if ($Branch) { Invoke-Native 'git checkout' { git -C $Root checkout $Branch } }
  }
  $commit = (git -C $Root rev-parse --short HEAD)
  Write-Host "building commit $commit"

  # ---------------------------------------------------------------- 4. Mapbox token (public pk. token, not a secret)
  Step '4/8  Mapbox public token'
  $token = $MapboxToken
  if (-not $token) { $token = $env:EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN }
  if (-not $token -and (Test-Path (Join-Path $Root '.env'))) {
    $line = Select-String -Path (Join-Path $Root '.env') -Pattern '^\s*EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN\s*=\s*(\S+)' | Select-Object -First 1
    if ($line) { $token = $line.Matches[0].Groups[1].Value.Trim('"', "'") }
  }
  if (-not $token) { $token = (Read-Host 'Mapbox PUBLIC access token (starts with pk.)').Trim() }
  if (-not $token.StartsWith('pk.')) { Fail 'The Mapbox token must be a public token that starts with pk.' }
  $env:EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN = $token
  Write-Host 'token accepted (pk., not shown)'

  # ---------------------------------------------------------------- 5. JS deps + prebuild
  Step '5/8  npm ci and expo prebuild'
  Push-Location $Root
  try {
    $env:CI = '1'
    $env:EXPO_NO_TELEMETRY = '1'
    Invoke-Native 'npm ci' { npm ci }
    $androidDir = Join-Path $Root 'android'
    if ($CleanPrebuild -or -not (Test-Path (Join-Path $androidDir 'gradlew.bat'))) {
      $prebuildArgs = @('expo', 'prebuild', '--platform', 'android', '--no-install')
      if ($CleanPrebuild) { $prebuildArgs += '--clean' }
      Invoke-Native 'expo prebuild' { npx @prebuildArgs }
    } else {
      Write-Host 'android\ already generated; keeping it (use -CleanPrebuild to regenerate).'
    }
    # Guard: the generated project must read the DYX release signing properties, never fall back to debug keys.
    if (-not (Select-String -Path (Join-Path $androidDir 'app\build.gradle') -Pattern 'DYX_RELEASE_STORE_FILE' -Quiet)) {
      Fail 'android\app\build.gradle has no DYX release signing block. Run again with -CleanPrebuild.'
    }
    $sdkDirLine = 'sdk.dir=' + $Sdk.Replace('\', '\\').Replace(':', '\:')
    Set-Content -Path (Join-Path $androidDir 'local.properties') -Value $sdkDirLine -Encoding ASCII
  } finally { Pop-Location }

  # ---------------------------------------------------------------- 6. signing key
  Step '6/8  Release keystore'
  $ks = $KeystorePath
  if (-not $ks) {
    foreach ($candidate in @(
        (Join-Path $env:USERPROFILE '.android\dyx-gcs-release.keystore'),
        (Join-Path $env:USERPROFILE 'Desktop\dyx-gcs-release.keystore'),
        (Join-Path $env:USERPROFILE 'Downloads\dyx-gcs-release.keystore'),
        (Join-Path $env:USERPROFILE 'Documents\dyx-gcs-release.keystore'))) {
      if (Test-Path $candidate) { $ks = $candidate; break }
    }
  }
  if (-not $ks) { $ks = (Read-Host 'Path to dyx-gcs-release.keystore').Trim('"', "'", ' ') }
  if (-not (Test-Path $ks)) { Fail "Keystore not found: $ks" }
  $ks = (Resolve-Path $ks).Path
  Write-Host "keystore: $ks"
  $storePw = Read-Secret 'Keystore (store) password'
  $keyPw = Read-Secret 'Key password (Enter = same as store password)'
  if (-not $keyPw) { $keyPw = $storePw }

  $env:DYX_KS_CHECK_PW = $storePw
  $saved = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  $listing = & $keytool -list -v -keystore $ks -alias $KeyAlias -storepass:env DYX_KS_CHECK_PW 2>&1
  $listCode = $LASTEXITCODE
  $ErrorActionPreference = $saved
  Remove-Item Env:DYX_KS_CHECK_PW -ErrorAction SilentlyContinue
  if ($listCode -ne 0) { Fail "keytool could not open the keystore with alias '$KeyAlias' (wrong password or alias?)." }
  $sha = ($listing | Select-String -Pattern 'SHA256:\s*(\S+)' | Select-Object -First 1)
  if (-not $sha) { Fail 'keytool printed no SHA-256 fingerprint.' }
  $keystoreSha = Normalize-Hex $sha.Matches[0].Groups[1].Value
  if ($keystoreSha -ne $ExpectedSha256) {
    Fail "This keystore is NOT the production key (SHA-256 $keystoreSha, expected $ExpectedSha256). An APK signed with it cannot update the installed apps."
  }
  Write-Host "key matches the production certificate ($($ExpectedSha256.Substring(0, 16))...)" -ForegroundColor Green

  $env:DYX_RELEASE_STORE_FILE = $ks
  $env:DYX_RELEASE_STORE_PASSWORD = $storePw
  $env:DYX_RELEASE_KEY_ALIAS = $KeyAlias
  $env:DYX_RELEASE_KEY_PASSWORD = $keyPw

  # ---------------------------------------------------------------- 7. build
  Step '7/8  Gradle assembleRelease (first run downloads a lot; re-run the script if the network drops, Gradle resumes)'
  Push-Location (Join-Path $Root 'android')
  try {
    Invoke-Native 'gradlew assembleRelease' { .\gradlew.bat assembleRelease --no-daemon }
  } finally { Pop-Location }

  # ---------------------------------------------------------------- 8. verify + deliver
  Step '8/8  Verify the APK'
  $apk = Join-Path $Root 'android\app\build\outputs\apk\release\app-release.apk'
  if (-not (Test-Path $apk)) { Fail "APK not found: $apk" }
  $saved = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  $certs = & $apksigner verify --print-certs $apk 2>&1
  $verifyCode = $LASTEXITCODE
  $ErrorActionPreference = $saved
  if ($verifyCode -ne 0) { Fail "apksigner verify failed:`n$($certs -join "`n")" }
  $apkSha = ($certs | Select-String -Pattern 'Signer #1 certificate SHA-256 digest:\s*(\S+)' | Select-Object -First 1)
  if (-not $apkSha) { Fail 'apksigner printed no signer digest.' }
  if ((Normalize-Hex $apkSha.Matches[0].Groups[1].Value) -ne $ExpectedSha256) { Fail 'The APK is signed with a different key than production. Do not distribute it.' }
  Write-Host 'APK signature verifies and the signer is the production key.' -ForegroundColor Green
  if (Test-Path $aapt2) { $saved = $ErrorActionPreference; $ErrorActionPreference = 'Continue'; (& $aapt2 dump badging $apk 2>&1 | Select-Object -First 1); $ErrorActionPreference = $saved }

  $desktop = [Environment]::GetFolderPath('Desktop')
  $dest = Join-Path $desktop "DYX-GCS-release-$commit.apk"
  Copy-Item -Force $apk $dest
  $hash = (Get-FileHash -Algorithm SHA256 $dest).Hash
  Write-Host ""
  Write-Host "DONE  $dest" -ForegroundColor Green
  Write-Host ("size   {0:N1} MB" -f ((Get-Item $dest).Length / 1MB))
  Write-Host "sha256 $hash"
  Write-Host "log    $(Join-Path $logDir 'build-release-windows.log')"
}
finally {
  foreach ($name in 'DYX_RELEASE_STORE_PASSWORD', 'DYX_RELEASE_KEY_PASSWORD', 'DYX_RELEASE_STORE_FILE', 'DYX_RELEASE_KEY_ALIAS', 'DYX_KS_CHECK_PW') {
    Remove-Item "Env:$name" -ErrorAction SilentlyContinue
  }
  $storePw = $null; $keyPw = $null
  if (Test-Path (Join-Path $Root 'android\gradlew.bat')) {
    try { Push-Location (Join-Path $Root 'android'); $saved = $ErrorActionPreference; $ErrorActionPreference = 'Continue'; .\gradlew.bat --stop | Out-Null; $ErrorActionPreference = $saved } catch { } finally { Pop-Location }
  }
  try { Stop-Transcript | Out-Null } catch { }
}
