param([Parameter(Mandatory=$true)][string]$PrivateRoot)
$ErrorActionPreference = 'Stop'
# Managed Docker mode publishes explicit 127.0.0.1 ports. No legacy fallback.
$taskRoot = (Resolve-Path -LiteralPath $PrivateRoot).Path
$python = (Get-Command python -ErrorAction Stop).Source
& $python (Join-Path $PSScriptRoot 'managed_loopback.py') --private-root $taskRoot
if ($LASTEXITCODE -ne 0) { throw 'Isolated target not validated. No backup or restore authorized by this launcher.' }
