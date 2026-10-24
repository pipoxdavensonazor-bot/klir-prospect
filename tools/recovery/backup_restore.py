"""Independent logical backup / LOCAL EMPTY Supabase recovery rehearsal.
Default is preflight. No service key, reset, remote restore or paid provisioning.
Requires Supabase CLI, Docker, psql and age installed by the operator.
Credentials are read from environment; never echoed. Outputs must stay outside Git.
"""
import argparse, hashlib, json, os, shutil, subprocess, tarfile, time
from pathlib import Path
from urllib.parse import urlparse

TEST='pwakjxjjxswdjsapsbxn'
REPO=Path(__file__).resolve().parents[2]

def require(condition,message):
    if not condition: raise RuntimeError(message)

def run(command,*,stdin=None):
    try:
        result=subprocess.run(command,input=stdin,text=True,capture_output=True,timeout=300)
    except subprocess.TimeoutExpired:
        raise RuntimeError('Tool timeout: '+Path(command[0]).name+'; connection details withheld.') from None
    require(result.returncode==0,'Tool failed: '+Path(command[0]).name+'; inspect tool configuration locally; connection details withheld.')
    return result.stdout.strip()

def sql(url,statement):
    return run(['psql','-X','-At','-v','ON_ERROR_STOP=1','--dbname',url,'-c',statement])

def source_guard(url):
    u=urlparse(url)
    require(u.scheme in ('postgres','postgresql') and (u.hostname=='db.'+TEST+'.supabase.co' or (u.hostname or '').endswith('.pooler.supabase.com') and (u.username or '')=='postgres.'+TEST),'Only the named Supabase Test source is allowed.')

def target_guard(url):
    u=urlparse(url)
    require(u.scheme in ('postgres','postgresql') and u.hostname in ('127.0.0.1','localhost','::1'),'Restore target must be LOCAL, never Test or production.')

def fingerprint(url):
    tables=json.loads(sql(url,"select coalesce(jsonb_agg(jsonb_build_array(schemaname,tablename) order by schemaname,tablename),'[]') from pg_tables where schemaname in ('public','private','auth','storage','supabase_migrations')"))
    result={}
    for schema,table in tables:
        qualified='"'+schema.replace('"','""')+'"."'+table.replace('"','""')+'"'
        query="select jsonb_build_object('rows',count(*),'md5',md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by to_jsonb(t)::text),''))) from "+qualified+' t'
        result[schema+'.'+table]=json.loads(sql(url,query))
    return result

parser=argparse.ArgumentParser()
parser.add_argument('mode',choices=['preflight','backup','restore'])
parser.add_argument('--directory',type=Path,required=True,help='Private directory outside the repository')
parser.add_argument('--archive',type=Path)
parser.add_argument('--identity',type=Path,help='Private age identity file, outside repository')
parser.add_argument('--quiet-window-confirmed',action='store_true')
parser.add_argument('--empty-local-confirmed',action='store_true')
args=parser.parse_args()
folder=args.directory.resolve()
require(not folder.is_relative_to(REPO),'Private backup directory must be outside the repository.')
tools={name:bool(shutil.which(name)) for name in ['supabase','docker','psql','age']}
if args.mode=='preflight':
    print(json.dumps({'tools':tools,'source_connection_set':bool(os.getenv('KLIR_TEST_DB_URL')),'local_target_set':bool(os.getenv('KLIR_RECOVERY_DB_URL')),'backup_performed':False,'restore_performed':False}));raise SystemExit(0)
require(all(tools.values()),'Missing local tools; run preflight. No infrastructure provisioned.')
folder.mkdir(parents=True,exist_ok=False)
started=time.monotonic()
if args.mode=='backup':
    source=os.environ.get('KLIR_TEST_DB_URL','');source_guard(source)
    require(args.quiet_window_confirmed,'Confirm an agreed quiet write/schema window; never stop or reset the project automatically.')
    recipient=os.environ.get('KLIR_BACKUP_AGE_RECIPIENT','');require(recipient.startswith('age1'),'Set an independently held age public recipient.')
    run(['docker','info','--format','{{.ServerVersion}}'])
    before=fingerprint(source)
    require('auth.users' in before and 'auth.identities' in before and 'public.workspace_states' in before,'Source inventory incomplete.')
    for name,flags in [('roles.sql',['--role-only']),('schema.sql',['--schema','public,private']),('data.sql',['--data-only','--use-copy'])]:
        run(['supabase','db','dump','--db-url',source,'-f',str(folder/name),*flags])
    data=(folder/'data.sql').read_text(encoding='utf8')
    require(('auth.users' in data or '"auth"."users"' in data) and ('auth.identities' in data or '"auth"."identities"' in data),'Dump lacks Auth tables: archive rejected; do not label complete.')
    hooks=sql(source,"select coalesce(string_agg('DO $hook$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='||quote_literal(t.tgname)||' AND tgrelid=''auth.users''::regclass) THEN '||pg_get_triggerdef(t.oid)||'; END IF; END $hook$;',E'\\n'),'') from pg_trigger t join pg_proc p on p.oid=t.tgfoid join pg_namespace n on n.oid=p.pronamespace where t.tgrelid='auth.users'::regclass and not t.tgisinternal and n.nspname in ('public','private')")
    (folder/'auth-hooks.sql').write_text(hooks,encoding='utf8')
    if any(k.startswith('supabase_migrations.') for k in before):
        for name,flags in [('history-schema.sql',[]),('history-data.sql',['--data-only','--use-copy'])]:
            run(['supabase','db','dump','--db-url',source,'--schema','supabase_migrations','-f',str(folder/name),*flags])
    after=fingerprint(source);require(before==after,'Source changed during export: keep files private, backup is NOT verified; repeat in agreed quiet window.')
    files=list(folder.glob('*.sql'))
    manifest={'test_project':TEST,'inventory':before,'source_pg_version':sql(source,'show server_version'),'supabase_cli':run(['supabase','--version']),'seconds':time.monotonic()-started,'sha256':{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in files},'auth_configuration_restored':False,'independent_archive_restored':False}
    (folder/'manifest.json').write_text(json.dumps(manifest,indent=2),encoding='utf8')
    tar=folder/'bundle.tar'
    with tarfile.open(tar,'w') as archive:
        for file in [*files,folder/'manifest.json']:archive.add(file,arcname=file.name)
    run(['age','--encrypt','--recipient',recipient,'--output',str(folder/'backup.tar.age'),str(tar)])
    # Delete only exact files generated above, after encrypted archive exists.
    require((folder/'backup.tar.age').stat().st_size>0,'Encryption output absent.')
    for file in [*files,folder/'manifest.json',tar]:
        require(file.resolve().parent==folder,'Cleanup path outside private staging directory.');file.unlink()
    print(json.dumps({'encrypted_archive_created':True,'restore_verified':False,'seconds':time.monotonic()-started}))
else:
    target=os.environ.get('KLIR_RECOVERY_DB_URL','');target_guard(target)
    require(args.empty_local_confirmed and args.archive and args.identity,'Require empty local Supabase, encrypted archive and independent decryption identity.')
    require(not args.identity.resolve().is_relative_to(REPO),'Private decryption identity must remain outside repository.')
    require(sql(target,"select (to_regclass('auth.users') is not null and to_regclass('storage.objects') is not null and to_regclass('public.workspace_states') is null)::text")=='true','Not a fresh local Supabase stack.')
    require(sql(target,'select count(*) from auth.users')=='0','Local target has user data; refusing restore.')
    tar=folder/'bundle.tar';run(['age','--decrypt','--identity',str(args.identity),'--output',str(tar),str(args.archive)])
    with tarfile.open(tar) as archive:
        for member in archive.getmembers():
            require(member.isfile() and Path(member.name).name==member.name and (member.name.endswith('.sql') or member.name=='manifest.json'),'Unsafe archive member.')
            (folder/member.name).write_bytes(archive.extractfile(member).read())
    manifest=json.loads((folder/'manifest.json').read_text(encoding='utf8'));require(manifest['test_project']==TEST,'Wrong source project.')
    for name,digest in manifest['sha256'].items():
        require(Path(name).name==name and hashlib.sha256((folder/name).read_bytes()).hexdigest()==digest,'Backup checksum mismatch.')
    command=['psql','-X','--single-transaction','-v','ON_ERROR_STOP=1','--dbname',target,'--file',str(folder/'roles.sql'),'--file',str(folder/'schema.sql'),'--command','SET session_replication_role = replica','--file',str(folder/'data.sql'),'--command','SET session_replication_role = origin','--file',str(folder/'auth-hooks.sql')]
    for name in ['history-schema.sql','history-data.sql']:
        if (folder/name).exists():command+=['--file',str(folder/name)]
    run(command)
    actual=fingerprint(target);require(actual==manifest['inventory'],'Restored table inventory differs: restore NOT validated.')
    run(['psql','-X','-v','ON_ERROR_STOP=1','--dbname',target,'--file',str(Path(__file__).with_name('reconcile.sql'))])
    report={'database_rows_and_fingerprints_equal':True,'ledger_structural_checks':True,'seconds':time.monotonic()-started,'auth_login_and_permissions_e2e':'NOT EXECUTED: configure isolated Auth and test two accounts plus receipt replay before declaring complete','production_or_test_reset':False}
    (folder/'rehearsal-result.json').write_text(json.dumps(report,indent=2),encoding='utf8');print(json.dumps(report))
