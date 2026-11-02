"""Fiction-only concurrent PostgreSQL rehearsal, with no network or volumes."""
import json
from pathlib import Path
import subprocess
import time
import uuid

HERE = Path(__file__).resolve().parent
COMPOSE = HERE.parent / 'recovery' / 'synthetic_socket.compose.yaml'
ORDER = '11111111-1111-1111-1111-111111111111'
ORDER_TWO = '22222222-2222-2222-2222-222222222222'
ORDER_THREE = '33333333-3333-3333-3333-333333333333'
USER = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'


def run(args, data=None):
    result = subprocess.run(args, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
    if result.returncode:
        raise RuntimeError(f'{args[0]} failed (exit {result.returncode}); output withheld')
    return result.stdout


def main():
    project = 'klir-stripe-fixture-' + uuid.uuid4().hex[:12]
    name = project + '-db-1'
    compose = ['docker', 'compose', '--project-name', project, '-f', str(COMPOSE)]
    if subprocess.run(['docker', 'inspect', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
        raise RuntimeError('Fixture container already exists.')
    started = False
    try:
        run(compose + ['up', '-d', '--pull', 'never'])
        started = True
        info = json.loads(run(['docker', 'inspect', name]))[0]
        host = info['HostConfig']
        if host['NetworkMode'] != 'none' or host.get('PortBindings') or any((info['NetworkSettings']['Ports'] or {}).values()):
            raise RuntimeError('Network isolation or port check failed.')
        if info['Mounts'] or not host['ReadonlyRootfs'] or host['LogConfig']['Type'] != 'none':
            raise RuntimeError('Unexpected persistent mount, writable root, or logging.')
        if set(host.get('Tmpfs') or {}) != {'/synthetic', '/tmp'}:
            raise RuntimeError('Expected temporary storage missing.')
        for _ in range(20):
            if subprocess.run(['docker','exec',name,'pg_isready','-h','/tmp','-U','postgres'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode == 0:
                break
            time.sleep(1)
        else:
            raise RuntimeError('Synthetic PostgreSQL unavailable.')
        psql = ['docker','exec','-i',name,'psql','-X','-h','/tmp','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-At']
        run(psql, b'create role anon; create role authenticated; create role service_role; create schema auth; create table auth.users(id uuid primary key);')
        run(psql, (HERE / 'candidate.sql').read_bytes())
        setup=(f"insert into auth.users values ('{USER}'); insert into private.stripe_test_orders(id,user_id,session_id,offer_id,amount_minor,currency,credits,duration_days) values ('{ORDER}','{USER}','cs_test_fixture','fiction',4900,'cad',90,30),('{ORDER_TWO}','{USER}','cs_test_other','fiction',4900,'cad',90,30),('{ORDER_THREE}','{USER}','cs_test_rollback','fiction',4900,'cad',90,30);")
        run(psql, setup.encode())
        def race(order, session, events):
            processes=[subprocess.Popen(psql,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE) for _ in events]
            for proc,event in zip(processes,events):
                statement=(f"begin; set role service_role; select private.stripe_test_apply_paid('{order}','{session}','{event}'); select pg_sleep(1); commit;").encode()
                proc.stdin.write(statement); proc.stdin.close()
            outputs=[]
            for proc in processes:
                output=proc.stdout.read(); proc.wait(timeout=30)
                if proc.returncode: raise RuntimeError('Concurrent synthetic transaction failed; output withheld.')
                outputs.append(output.decode())
            if sum('applied' in result for result in outputs)!=1 or sum('duplicate' in result for result in outputs)!=1:
                raise RuntimeError('Concurrent idempotence check failed.')
        race(ORDER,'cs_test_fixture',['evt_concurrent','evt_concurrent'])
        race(ORDER_TWO,'cs_test_other',['evt_first','evt_second'])
        rollback=(f"begin; set role service_role; select private.stripe_test_apply_paid('{ORDER_THREE}','cs_test_rollback','evt_rollback'); rollback;").encode()
        run(psql,rollback)
        rollback_check=run(psql,b"select count(*) from private.stripe_test_events where event_id='evt_rollback'; select count(*) from private.stripe_test_entitlements where order_id='33333333-3333-3333-3333-333333333333';").decode().split()
        if rollback_check != ['0','0']:
            raise RuntimeError('Synthetic rollback left partial activation.')
        counts=run(psql,b"select count(*) from private.stripe_test_entitlements; select count(*) from private.stripe_test_events;").decode().split()
        if counts != ['2','3']:
            raise RuntimeError('Unexpected entitlement or event count.')
        print(json.dumps({'fixture_only':True,'network':'none','published_ports':0,'persistent_mounts':0,
                          'independent_connections':2,'same_and_distinct_event_races':['applied','duplicate'],
                          'rollback_without_partial_activation':True,'entitlements':2,'events':3,'real_data_used':False}))
    finally:
        if started:
            run(compose + ['stop'])
            run(['docker','rm',name])  # No -v; only this uniquely named synthetic container.


if __name__ == '__main__':
    main()
