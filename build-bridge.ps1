param([string]$PublicApiDll = $env:TIA_V16_PUBLICAPI_DLL)
$ErrorActionPreference='Stop'
if(-not $PublicApiDll){$PublicApiDll=Join-Path $env:ProgramFiles 'Siemens\Automation\Portal V16\PublicAPI\V16\Siemens.Engineering.dll'}
$PublicApiDll=(Resolve-Path -LiteralPath $PublicApiDll).Path
$name=[Reflection.AssemblyName]::GetAssemblyName($PublicApiDll)
if($name.Name -ne 'Siemens.Engineering' -or $name.Version.Major -ne 16){throw 'V16 Siemens.Engineering.dll required'}
$csc=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$dir=Join-Path $PSScriptRoot 'bin'
[IO.Directory]::CreateDirectory($dir) | Out-Null
$out=Join-Path $dir 'TiaBridgeV16.exe'
& $csc /nologo /target:exe /platform:x64 /codepage:65001 "/reference:$PublicApiDll" /reference:System.Web.Extensions.dll "/out:$out" (Join-Path $PSScriptRoot 'bridge\BridgeV16.cs')
if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}
Get-Item -LiteralPath $out | Select-Object -ExpandProperty FullName
