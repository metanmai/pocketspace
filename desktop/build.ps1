$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$output = Join-Path $project 'Windows'
$temporaryParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$scratch = Join-Path $temporaryParent ('pocketspace-build-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $scratch | Out-Null

try {
    $version = '1.0.3405.78'
    $package = Join-Path $scratch 'webview2.zip'
    $url = "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$version/microsoft.web.webview2.$version.nupkg"
    Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $package
    $sdk = Join-Path $scratch 'sdk'
    Expand-Archive -LiteralPath $package -DestinationPath $sdk

    $framework = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
    $managed = Join-Path $sdk 'lib\net462'
    $core = Join-Path $managed 'Microsoft.Web.WebView2.Core.dll'
    $forms = Join-Path $managed 'Microsoft.Web.WebView2.WinForms.dll'
    $loader = Join-Path $sdk 'runtimes\win-x64\native\WebView2Loader.dll'
    $exe = Join-Path $scratch 'Pocketspace.exe'
    $compilerArgs = @(
        '/nologo', '/target:winexe', '/platform:x64', '/optimize+', "/out:$exe"
        "/reference:$core", "/reference:$forms", '/reference:System.Drawing.dll'
        '/reference:System.Windows.Forms.dll', "/win32icon:$PSScriptRoot\Pocketspace.ico"
        '/reference:System.Web.Extensions.dll'
        "$PSScriptRoot\Pocketspace.cs"
    )
    & (Join-Path $framework 'csc.exe') @compilerArgs
    if ($LASTEXITCODE -ne 0) { throw 'Pocketspace compilation failed.' }

    New-Item -ItemType Directory -Path $output -Force | Out-Null
    Copy-Item -LiteralPath $exe,$core,$forms,$loader -Destination $output -Force
    Copy-Item -LiteralPath (Join-Path $sdk 'LICENSE.txt') -Destination (Join-Path $output 'WebView2-LICENSE.txt') -Force
    Copy-Item -LiteralPath (Join-Path $project 'dist') -Destination $output -Recurse -Force
    Write-Output (Join-Path $output 'Pocketspace.exe')
}
finally {
    $resolved = (Resolve-Path -LiteralPath $scratch).ProviderPath
    if ($resolved -eq $scratch -and (Split-Path -Parent $resolved).TrimEnd('\') -eq $temporaryParent.TrimEnd('\')) {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
