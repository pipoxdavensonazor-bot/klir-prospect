"""Pinned managed Docker stack; explicit IPv4 loopback, no legacy volume removal.

CLI stack support is experimental. Live verification, not this file, establishes readiness.
CLI stdout/stderr stay in memory; only a redacted audit and DPAPI ciphertext are saved.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tomllib
from urllib.parse import urlparse

STACK = 'klir-recovery-loopback-20261025'
LEGACY = 'klir-recovery-isolated-20261024'
REPO = Path(__file__).resolve().parents[2]


def require(ok, message):
    if not ok:
        raise RuntimeError(message)


def run(args, *, env=None, stdin=None, timeout=40):
    try:
        result = subprocess.run(args, input=stdin, capture_output=True, text=True,
                                encoding='utf8', errors='replace', env=env, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise RuntimeError('Local command timed out; output withheld.') from None
    require(result.returncode == 0,
            f'Local command {Path(args[0]).name} failed (exit {result.returncode}); raw output withheld.')
    return result.stdout


def find_report(value):
    if isinstance(value, dict):
        if isinstance(value.get('identity'), dict) and isinstance(value.get('services'), list) and 'env' in value:
            return value
        for child in value.values():
            found = find_report(child)
            if found is not None:
                return found
    if isinstance(value, list):
        for child in value:
            found = find_report(child)
            if found is not None:
                return found
    return None


def container_ports(containers):
    ports = set()
    for item in containers:
        requested = item.get('HostConfig', {}).get('PortBindings', {}) or {}
        effective = item.get('NetworkSettings', {}).get('Ports', {}) or {}
        for name, mapping in requested.items():
            for binding in mapping or []:
                require(binding.get('HostIp') == '127.0.0.1', 'Container requested a non-127.0.0.1 publish.')
                require(effective.get(name), 'Requested port is not effectively published.')
        for mapping in effective.values():
            for binding in mapping or []:
                require(binding.get('HostIp') == '127.0.0.1', 'Docker published outside 127.0.0.1.')
                port = int(binding['HostPort'])
                require(1 <= port <= 65535, 'Invalid published port.')
                ports.add(port)
    require(ports, 'No effective Docker publications observed.')
    return ports


def check_listeners(ports, listeners):
    for port in ports:
        matches = [r for r in listeners if int(r['LocalPort']) == port]
        require(matches, 'Published endpoint has no Windows listening socket.')
        require(all(r['LocalAddress'] == '127.0.0.1' for r in matches),
                'Windows listener outside 127.0.0.1 (including IPv6) refused.')


def endpoint_ports(report):
    ports = set()
    for endpoint in report.get('endpoints', {}).values():
        require(endpoint.get('address') == '127.0.0.1', 'Stack endpoint is not IPv4 loopback.')
        ports.add(int(endpoint['port']))
    db = urlparse(report.get('env', {}).get('DB_URL', ''))
    require(db.scheme in ('postgres', 'postgresql') and db.hostname == '127.0.0.1' and db.port,
            'Managed target database URL is not IPv4 loopback.')
    ports.add(db.port)
    return ports


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--private-root', type=Path, required=True)
    args = parser.parse_args()
    root = args.private_root.resolve()
    require(root.is_dir() and not root.is_relative_to(REPO), 'Private directory must be outside Git.')
    workdir = root / 'isolated'
    config = tomllib.loads((workdir / 'supabase/config.toml').read_text(encoding='utf8'))
    require(config.get('project_id') == LEGACY and not config['db']['seed']['enabled'], 'Unexpected local config or seeds.')
    require(not (workdir / 'supabase/.temp/project-ref').exists(), 'Remote-linked project refused.')
    require(not list((workdir / 'supabase/migrations').glob('*.sql')), 'Target contains application migrations; refusing initialization.')
    cli = root / 'tools/supabase/supabase.exe'
    require(cli.is_file(), 'Pinned CLI absent.')
    shell = shutil.which('pwsh') or shutil.which('powershell')
    require(shell, 'Windows PowerShell required for listener checks and DPAPI.')
    env = os.environ.copy()
    env['SUPABASE_HOME'] = str(root / 'managed-home')
    before = set(run(['docker', 'volume', 'ls', '--format', '{{.Name}}']).splitlines())
    require(not run(['docker', 'ps', '--filter', f'name={LEGACY}', '--format', '{{.ID}}']).strip(),
            'Legacy target still running; stop only that project preserving volumes first.')
    common = ['--workdir', str(workdir), '--output-format', 'json']
    identity = None
    try:
        # No fallback to the legacy start, which leaves HostIp empty.
        run([str(cli), 'stack', 'start', '--stack', STACK, '--runtime', 'docker', '--eager',
             '--exclude', 'analytics,functions,pooler,realtime,studio', *common], env=env, timeout=1200)
        status = json.loads(run([str(cli), 'stack', 'status', '--stack', STACK, *common], env=env))
        report = find_report(status)
        require(report is not None, 'Managed stack metadata unavailable; target not validated.')
        require(report['identity'].get('name') == STACK and report.get('runtime') == 'docker', 'Wrong stack selected.')
        require(Path(report['identity']['project_root']).resolve() == workdir.resolve(), 'Wrong stack project root.')
        identity = report['identity']['id']
        require(report.get('readiness') == 'ready', 'Managed stack is not ready.')
        services = {s.get('service') for s in report['services'] if s.get('state') == 'running' and s.get('health') == 'healthy'}
        require({'database', 'auth', 'rest', 'storage'} <= services, 'Core services are not all healthy.')
        ids = run(['docker', 'ps', '-a', '--filter', f'label=com.supabase.stack={identity}', '--format', '{{.ID}}']).splitlines()
        require(ids, 'No containers identified for this stack.')
        containers = json.loads(run(['docker', 'container', 'inspect', *ids]))
        require(all(c['Config']['Labels'].get('com.supabase.stack') == identity for c in containers), 'Container scope mismatch.')
        ports = container_ports(containers) | endpoint_ports(report)
        env['KLIR_AUDIT_PORTS'] = ','.join(map(str, sorted(ports)))
        listener_command = "$ports=$env:KLIR_AUDIT_PORTS -split ','; @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalPort -in $ports } | Select-Object LocalAddress,LocalPort) | ConvertTo-Json -Compress"
        listeners = json.loads(run([shell, '-NoProfile', '-Command', listener_command], env=env))
        if isinstance(listeners, dict):
            listeners = [listeners]
        check_listeners(ports, listeners)
        after = set(run(['docker', 'volume', 'ls', '--format', '{{.Name}}']).splitlines())
        require(before <= after, 'A pre-existing volume is missing; refuse further work.')
        # Credential configuration is encrypted, never written to diagnostic logs.
        protect = "$text=[Console]::In.ReadToEnd(); ConvertTo-SecureString $text -AsPlainText -Force | ConvertFrom-SecureString"
        ciphertext = run([shell, '-NoProfile', '-Command', protect], stdin=json.dumps(report['env']))
        (root / 'managed-target-env.dpapi').write_text(ciphertext.strip(), encoding='utf8')
        proof = {'stack_name': STACK, 'stack_id': identity, 'docker_publications': sorted(ports),
                 'windows_listeners': listeners, 'all_ipv4_loopback': True, 'core_services_healthy': sorted(services),
                 'preexisting_volume_names_preserved': sorted(before), 'empty_database_sql_verified': False,
                 'backup_executed': False, 'restore_executed': False}
        (root / 'managed-loopback-proof.json').write_text(json.dumps(proof, indent=2), encoding='utf8')
        print(json.dumps(proof))
    except Exception:
        # Named stack only; stop preserves its data. Never use stop --all or destroy.
        try:
            selector = ['--stack-id', identity] if identity else ['--stack', STACK]
            run([str(cli), 'stack', 'stop', *selector, *common], env=env, timeout=60)
        except Exception:
            print('Named stack stop was not confirmed; inspect it before continuing.')
        raise


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(str(error) if isinstance(error, RuntimeError) else f'Local validation failed ({type(error).__name__}); raw details withheld.')
        raise SystemExit(1)
