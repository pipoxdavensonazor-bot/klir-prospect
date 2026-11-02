"""Fiction-only socket rehearsal. Never accepts a URL, archive, volume, or secret.

The archive is an in-memory pg_dump of hard-coded fictional data, restored into
another database in the same temporary cluster. It is not a Supabase backup.
"""
import json
from pathlib import Path
import subprocess
import time
import uuid

HERE = Path(__file__).resolve().parent
COMPOSE = HERE / 'synthetic_socket.compose.yaml'


def run(args, data=None, timeout=60):
    result = subprocess.run(args, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    if result.returncode:
        raise RuntimeError(f'{args[0]} failed (exit {result.returncode}); output withheld')
    return result.stdout


def main():
    project = 'klir-socket-fixture-' + uuid.uuid4().hex[:12]
    name = project + '-db-1'
    if subprocess.run(['docker', 'inspect', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
        raise RuntimeError('Fixture container already exists; refusing to alter it.')
    created = False
    compose = ['docker', 'compose', '--project-name', project, '-f', str(COMPOSE)]
    try:
        run(compose + ['up', '-d', '--pull', 'never'])
        created = True
        info = json.loads(run(['docker', 'inspect', name]))[0]
        host = info['HostConfig']
        ports = info['NetworkSettings']['Ports'] or {}
        if host['NetworkMode'] != 'none' or host.get('PortBindings') or any(ports.values()):
            raise RuntimeError('Network isolation or port check failed.')
        if info['Mounts'] or not host['ReadonlyRootfs'] or host['LogConfig']['Type'] != 'none':
            raise RuntimeError('Unexpected persistent mount, writable root, or logging.')
        tmpfs = host.get('Tmpfs') or {}
        if set(tmpfs) != {'/synthetic', '/tmp'}:
            raise RuntimeError('Expected temporary storage missing.')
        ready = False
        for _ in range(20):
            check = subprocess.run(['docker', 'exec', name, 'pg_isready', '-h', '/tmp', '-U', 'postgres'],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if check.returncode == 0:
                ready = True
                break
            time.sleep(1)
        if not ready:
            raise RuntimeError('Synthetic PostgreSQL did not become ready.')
        for database in ['synthetic_source', 'synthetic_restored']:
            run(['docker', 'exec', name, 'createdb', '-h', '/tmp', '-U', 'postgres', database])
        run(['docker', 'exec', '-i', name, 'psql', '-X', '-h', '/tmp', '-U', 'postgres',
             '-d', 'synthetic_source', '-v', 'ON_ERROR_STOP=1'], (HERE / 'synthetic_socket_fixture.sql').read_bytes())
        archive = run(['docker', 'exec', name, 'pg_dump', '-h', '/tmp', '-U', 'postgres',
                       '-Fc', '-d', 'synthetic_source'])
        if not archive.startswith(b'PGDMP'):
            raise RuntimeError('Synthetic dump format invalid.')
        run(['docker', 'exec', '-i', name, 'pg_restore', '-h', '/tmp', '-U', 'postgres',
             '--exit-on-error', '--single-transaction', '-d', 'synthetic_restored'], archive)
        result = run(['docker', 'exec', '-i', name, 'psql', '-X', '-h', '/tmp', '-U', 'postgres',
                      '-d', 'synthetic_restored', '-v', 'ON_ERROR_STOP=1', '-At'],
                     (HERE / 'synthetic_socket_verify.sql').read_bytes())
        if b'SYNTHETIC_SOCKET_RESTORE_PASS' not in result:
            raise RuntimeError('Synthetic reconciliation failed.')
        print(json.dumps({'fixture_only': True, 'network': 'none', 'published_ports': 0,
                          'persistent_mounts': 0, 'archive_bytes': len(archive),
                          'restore': 'PASS', 'rls_and_fixture_reconciliation': 'PASS',
                          'supabase_auth_storage_restored': False, 'real_data_used': False,
                          'roles_migrated_between_clusters': False}))
    finally:
        if created:
            run(compose + ['stop'])
            # This unique fixture container has only tmpfs data; never delete volumes.
            run(['docker', 'rm', name])


if __name__ == '__main__':
    main()
