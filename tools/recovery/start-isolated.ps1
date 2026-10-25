param([Parameter(Mandatory=$true)][string]$PrivateRoot)
$ErrorActionPreference = 'Stop'
$taskRoot = (Resolve-Path -LiteralPath $PrivateRoot).Path
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
if ($taskRoot -eq $repoRoot -or $taskRoot.StartsWith($repoRoot + '\')) { throw 'Private root must be outside Git.' }
$project = 'klir-recovery-isolated-20261024'
$network = 'klir-recovery-isolated-20261024'
$workdir = Join-Path $taskRoot 'isolated'
$config = Get-Content -LiteralPath (Join-Path $workdir 'supabase/config.toml') -Raw
if ($config -notmatch ('project_id = "' + $project + '"') -or $config -notmatch 'port = 55432') { throw 'Unexpected local configuration.' }
if (Test-Path -LiteralPath (Join-Path $workdir 'supabase/.temp/project-ref')) { throw 'Remote link detected; refusing.' }
. (Join-Path $taskRoot 'enable-tools.ps1')
$supabaseCli = Join-Path $taskRoot 'tools/supabase/supabase.exe'
if (-not (Test-Path -LiteralPath $supabaseCli)) { throw 'Pinned local Supabase CLI absent.' }
docker info --format '{{.ServerVersion}}' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Local Docker Linux engine unavailable. No target started.' }
$found = docker network ls --filter "name=^$network`$" --format '{{.Name}}'
if (-not $found) {
    docker network create --driver bridge --opt com.docker.network.bridge.host_binding_ipv4=127.0.0.1 --label "klir.recovery.project=$project" $network | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Cannot create local recovery network.' }
}
$net = (docker network inspect $network | ConvertFrom-Json)[0]
if ($net.Driver -ne 'bridge' -or $net.Options.'com.docker.network.bridge.host_binding_ipv4' -ne '127.0.0.1' -or $net.Labels.'klir.recovery.project' -ne $project) { throw 'Unexpected network; refusing reuse.' }
foreach ($entry in $net.Containers.PSObject.Properties) {
    if ($entry.Value.Name -notmatch ('_' + [regex]::Escape($project) + '$')) { throw 'Unrelated container on recovery network.' }
}
& $supabaseCli start --workdir $workdir --network-id $network --exclude logflare,vector,edge-runtime *> (Join-Path $taskRoot 'start-private.log')
if ($LASTEXITCODE -ne 0) { throw 'Local stack did not start. Inspect private log; no restore attempted.' }
$ids = @(docker ps --filter "network=$network" --format '{{.ID}}')
if (-not $ids.Count) { throw 'No local containers running.' }
foreach ($id in $ids) {
    $container = (docker inspect $id | ConvertFrom-Json)[0]
    foreach ($port in $container.NetworkSettings.Ports.PSObject.Properties) {
        foreach ($binding in $port.Value) {
            if ($binding.HostIp -notin @('127.0.0.1','::1')) {
                & $supabaseCli stop --workdir $workdir *> (Join-Path $taskRoot 'stop-private.log')
                throw 'Non-loopback port found. Stack stopped preserving volumes; no restore attempted.'
            }
        }
    }
}
& $supabaseCli status --workdir $workdir --output json *> (Join-Path $taskRoot 'status-private.json')
if ($LASTEXITCODE -ne 0) { throw 'Cannot obtain private local status.' }
Write-Output 'Local stack started and published ports checked. Empty target, schema compatibility and Auth still require verification. No backup or restore executed.'
