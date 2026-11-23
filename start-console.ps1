$ErrorActionPreference = 'Stop'
$python = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
$electron = Join-Path $PSScriptRoot 'desktop\node_modules\electron\dist\electron.exe'
if (!(Test-Path -LiteralPath $python)) { throw 'Set up .venv first; see README.md.' }
if (!(Test-Path -LiteralPath $electron)) { throw 'Install Electron first; see README.md.' }
if (!(Test-Path -LiteralPath (Join-Path $PSScriptRoot 'bin\TiaBridgeV16.exe'))) { throw 'Run build-bridge.ps1 first.' }
& $electron (Join-Path $PSScriptRoot 'desktop')
exit $LASTEXITCODE
