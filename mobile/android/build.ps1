param(
    [string] $Gradle,
    [string] $AndroidSdk = $env:ANDROID_HOME,
    [string] $Output = (Join-Path $PSScriptRoot 'Pocketspace-Android.apk')
)
$ErrorActionPreference = 'Stop'
if ($AndroidSdk) { $env:ANDROID_HOME = $AndroidSdk }
$tempRoot = (Resolve-Path -LiteralPath ([IO.Path]::GetTempPath())).Path.TrimEnd([IO.Path]::DirectorySeparatorChar)
$run = New-Item -ItemType Directory -Path (Join-Path $tempRoot ('pocketspace-android-' + [Guid]::NewGuid()))
try {
    $android = New-Item -ItemType Directory -Path (Join-Path $run.FullName 'mobile/android') -Force
    foreach ($item in @('settings.gradle', 'gradle.properties')) {
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot $item) -Destination $android.FullName -Recurse
    }
    $app = New-Item -ItemType Directory -Path (Join-Path $android.FullName 'app')
    foreach ($item in @('build.gradle', 'src')) {
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot "app/$item") -Destination $app.FullName -Recurse
    }
    if (!$Gradle) {
        foreach ($item in @('gradle', 'gradlew', 'gradlew.bat')) {
            Copy-Item -LiteralPath (Join-Path $PSScriptRoot $item) -Destination $android.FullName -Recurse
        }
        $Gradle = Join-Path $android.FullName 'gradlew.bat'
    }
    $repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
    Copy-Item -LiteralPath (Join-Path $repoRoot 'dist') -Destination $run.FullName -Recurse
    & $Gradle --no-daemon -p $android.FullName :app:assembleDebug
    if ($LASTEXITCODE -ne 0) { throw "Gradle failed ($LASTEXITCODE)." }
    Copy-Item -LiteralPath (Join-Path $android.FullName 'app/build/outputs/apk/debug/app-debug.apk') -Destination $Output -Force
    Get-Item -LiteralPath $Output
} finally {
    $owned = (Resolve-Path -LiteralPath $run.FullName).Path
    if ([IO.Path]::GetDirectoryName($owned) -eq $tempRoot -and [IO.Path]::GetFileName($owned) -eq $run.Name) {
        Remove-Item -LiteralPath $owned -Recurse -Force
    } else {
        throw "Unexpected temporary workspace path: $owned"
    }
}
