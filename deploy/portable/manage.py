"""Manual, versioned Docker upgrades. Backups stay on this server.

Prepare a fixed plan, inspect it, then apply its SHA-256. Never fetches images,
reinitializes credentials, removes containers/backups, or restores an old DB
over newer writes. A failed upgrade reuses the existing DB only when the target
release explicitly declares compatibility with the previous schema.
"""
from __future__ import annotations
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import sqlite3
import subprocess
import tarfile
import time
import uuid
from contextlib import contextmanager


def digest(path: Path) -> str:
    with path.open('rb') as stream:
        value=hashlib.sha256()
        for chunk in iter(lambda:stream.read(1024*1024), b''):
            value.update(chunk)
        return value.hexdigest()


def write_json(path: Path, value: object) -> None:
    temporary = path.with_name(path.name + '.writing')
    with temporary.open('w', encoding='utf-8') as stream:
        os.chmod(temporary, 0o600)
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write('\n'); stream.flush(); os.fsync(stream.fileno())
    os.replace(temporary, path)


def private_dir(path: Path) -> None:
    if path.resolve()!=path.absolute():
        raise ValueError('State directory must not contain symbolic links or indirect paths')
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.is_symlink():
        raise ValueError('State directory must not be a symbolic link')
    os.chmod(path, 0o700)


def safe_source(path: Path) -> Path:
    if not path.is_absolute() or not path.exists() or path.is_symlink():
        raise ValueError('Backup source must be an existing absolute non-symlink path')
    if path.resolve() != path:
        raise ValueError('Backup source contains an indirect path')
    if not path.is_file() and not path.is_dir():
        raise ValueError('Unsupported backup source')
    return path


def database_version(data: Path) -> int:
    with sqlite3.connect((data/'jindu.sqlite').as_uri()+'?mode=ro', uri=True) as db:
        return db.execute('PRAGMA user_version').fetchone()[0]


def business_digest(data: Path) -> dict:
    result = {}
    with sqlite3.connect((data/'jindu.sqlite').as_uri()+'?mode=ro', uri=True) as db:
        for table in ['records','files','jobs','repeats','history','usage','ai_requests']:
            h = hashlib.sha256(); count = 0
            for row in db.execute('SELECT * FROM '+table+' ORDER BY rowid'):
                h.update(json.dumps(row, ensure_ascii=False, separators=(',',':')).encode()); h.update(b'\n'); count += 1
            result[table] = {'rows':count, 'sha256':h.hexdigest()}
    return result


def backup_sources(sources: list[Path], destination: Path) -> dict:
    """Caller must stop all writers first. Never backs up into a source tree."""
    sources = [safe_source(source) for source in sources]
    if destination.exists():
        raise ValueError('Backup destination already exists')
    for source in sources:
        if destination.resolve().is_relative_to(source):
            raise ValueError('Backup destination overlaps a source')
    private_dir(destination)
    entries = []; roots = []
    for number, source in enumerate(sources):
        prefix = f'mount-{number}'
        roots.append({'source':str(source), 'archiveRoot':prefix, 'directory':source.is_dir()})
        paths = [source] if source.is_file() else [source, *sorted(source.rglob('*'))]
        for path in paths:
            if path.is_symlink() or not (path.is_file() or path.is_dir()):
                raise ValueError('Special files and links cannot be included in a backup')
            relative = path.relative_to(source).as_posix() if path != source else ''
            name = prefix + ('/'+relative if relative and relative!='.' else '')
            metadata = path.stat()
            entries.append({'name':name,'directory':path.is_dir(),'size':metadata.st_size if path.is_file() else 0,'sha256':digest(path) if path.is_file() else None,'mode':metadata.st_mode & 0o777,'uid':getattr(metadata,'st_uid',0),'gid':getattr(metadata,'st_gid',0),'source':path})
    required = sum(e['size'] for e in entries)
    if shutil.disk_usage(destination).free < required*2+100_000_000:
        raise ValueError('Insufficient space for complete backup and restore verification')
    archive = destination/'snapshot.tar'
    with tarfile.open(archive, 'x', dereference=True) as tar:
        os.chmod(archive, 0o600)
        for entry in entries:
            tar.add(entry['source'], arcname=entry['name'], recursive=False)
    for entry in entries:
        entry.pop('source')
    manifest = {'format':'jindu-complete-backup','version':1,'archiveSha256':digest(archive),'roots':roots,'entries':entries}
    write_json(destination/'manifest.json', manifest)
    verification = verify_backup(destination, destination/'restore-check')
    return {'directory':str(destination),'archiveSha256':manifest['archiveSha256'],'manifestSha256':digest(destination/'manifest.json'),'verifiedFiles':verification['files'],'databaseChecks':verification['databases']}


def verify_backup(directory: Path, target: Path) -> dict:
    """Restore to a NEW directory, verify every byte and SQLite integrity."""
    if target.exists():
        raise ValueError('Restore verification requires a new, empty destination')
    manifest = json.loads((directory/'manifest.json').read_text(encoding='utf-8'))
    if manifest.get('format')!='jindu-complete-backup' or manifest.get('version')!=1:
        raise ValueError('Unsupported complete backup format')
    if digest(directory/'snapshot.tar') != manifest['archiveSha256']:
        raise ValueError('Backup archive checksum mismatch')
    entries = {entry['name']:entry for entry in manifest['entries']}
    if len(entries)!=len(manifest['entries']):
        raise ValueError('Duplicate manifest paths')
    for name in entries:
        path=PurePosixPath(name)
        if not path.parts or path.as_posix()!=name or path.is_absolute() or '..' in path.parts or '\\' in name or ':' in name or not re.fullmatch(r'mount-\d+', path.parts[0]):
            raise ValueError('Unsafe archive path')
    private_dir(target)
    databases=[]; files=0
    with tarfile.open(directory/'snapshot.tar') as tar:
        members=tar.getmembers()
        if len(members)!=len(entries) or {m.name for m in members}!=set(entries):
            raise ValueError('Archive and manifest membership differ')
        for member in members:
            entry=entries[member.name]; out=target/member.name
            if not (member.isdir() or member.isfile()) or member.isdir()!=entry['directory'] or member.size!=entry['size']:
                raise ValueError('Unexpected archive member type or size')
            if member.isdir():
                out.mkdir(parents=True, exist_ok=True, mode=0o700);continue
            out.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            with out.open('xb') as sink, tar.extractfile(member) as source:
                os.chmod(out, 0o600); shutil.copyfileobj(source, sink)
            if digest(out)!=entry['sha256']:
                raise ValueError('Restored file checksum mismatch')
            files+=1
        # WAL/SHM files have also been restored before SQLite inspects a database.
        for name,entry in entries.items():
            if not entry['directory'] and PurePosixPath(name).name=='jindu.sqlite':
                with sqlite3.connect((target/name).as_uri()+'?mode=ro',uri=True) as db:
                    if db.execute('PRAGMA integrity_check').fetchall()!=[('ok',)]:
                        raise ValueError('Restored database integrity check failed')
                databases.append(name)
    return {'files':files,'databases':databases,'restoreDirectory':str(target)}


class Docker:
    def run(self, args:list[str], timeout:int=60) -> str:
        result=subprocess.run(['docker',*args],capture_output=True,text=True,encoding='utf-8',timeout=timeout)
        if result.returncode:
            # Docker output can contain environment values. Keep it out of reports.
            raise RuntimeError(f'Docker {args[0]} failed (exit {result.returncode})')
        return result.stdout.strip()

    def inspect(self, identity:str) -> dict:
        return json.loads(self.run(['inspect',identity]))[0]


def contract(image:dict) -> dict:
    labels=image['Config'].get('Labels') or {}
    version=labels.get('org.opencontainers.image.version','')
    if not re.fullmatch(r'\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?',version):
        raise ValueError('Target image has no supported version label')
    try:
        value={'version':version,'schemaVersion':int(labels['org.jindu.schema-version']),'upgradeFromSchemas':[int(n) for n in labels['org.jindu.upgrade-from-schemas'].split(',')],'rollbackToSchemas':[int(n) for n in labels['org.jindu.rollback-to-schemas'].split(',')]}
    except (KeyError,ValueError) as error:
        raise ValueError('Target image is missing its schema compatibility contract') from error
    return value


def bind_mounts(mounts:list[dict]) -> list[tuple]:
    return sorted((m['Source'],m['Destination'],m.get('RW',False)) for m in mounts if m['Type']=='bind')


def validate_service(spec:dict, actual:dict) -> None:
    # The supplied Compose file may have been edited since this container was
    # created. Reject drift before stopping either service or starting a writer.
    mounts=spec.get('volumes') or []
    if any(not isinstance(m,dict) or m.get('type')!='bind' for m in mounts):
        raise ValueError('Compose service volumes must be explicit bind mounts')
    planned=sorted((m['source'],m['target'],not m.get('read_only',False)) for m in mounts)
    if planned!=bind_mounts(actual['Mounts']):
        raise ValueError('Compose mounts differ from the running installation')
    if spec.get('env_file') or spec.get('network_mode') or spec.get('volumes_from') or spec.get('links') or spec.get('external_links'):
        raise ValueError('Service references external runtime objects')
    if any(name not in {'web','worker'} for name in (spec.get('depends_on') or {})):
        raise ValueError('Service depends on an unplanned container')


def prepare(docker:Docker, compose:Path, image:str, state:Path) -> dict:
    current=json.loads(docker.run(['compose','-f',str(compose),'config','--format','json']))
    target_image=docker.inspect(image); release=contract(target_image)
    old={}; sources=set(); data=None
    for service in ['web','worker']:
        identities=docker.run(['compose','-f',str(compose),'ps','-q',service]).splitlines()
        if len(identities)!=1:
            raise ValueError('Exactly one running web and one worker are required')
        item=docker.inspect(identities[0])
        if not item['State']['Running']:
            raise ValueError('Current service is not running')
        validate_service(current['services'][service],item)
        old[service]={'id':item['Id'],'imageId':item['Image'],'restart':item['HostConfig']['RestartPolicy'],'mounts':item['Mounts']}
        mounts={m['Destination']:m for m in item['Mounts'] if m['Type']=='bind'}
        if '/var/lib/jindu' not in mounts or '/run/jindu' not in mounts:
            raise ValueError('Existing data and private configuration bind mounts are required')
        actual=Path(mounts['/var/lib/jindu']['Source'])
        if data is not None and actual!=data:
            raise ValueError('Web and worker use different data directories')
        data=actual
        for mount in item['Mounts']:
            if mount['Type']=='bind':sources.add(str(safe_source(Path(mount['Source']))))
            elif mount['Type']!='tmpfs':raise ValueError('Named volume backup is not supported; retain the existing installation')
    if old['web']['imageId']!=old['worker']['imageId']:
        raise ValueError('Web and worker must use the same application version')
    before_schema=database_version(data)
    if before_schema not in release['upgradeFromSchemas']:
        raise ValueError('Target version does not support the existing database schema')
    if any(state.resolve().is_relative_to(Path(source)) for source in sources):
        raise ValueError('Update state must be outside all backup sources')
    operation=time.strftime('%Y%m%d-%H%M%S')+'-'+uuid.uuid4().hex[:6]
    project='jindu-update-'+operation
    updated={'name':project,'services':{}}
    for service in ['web','worker']:
        spec=copy.deepcopy(current['services'][service])
        if any(key not in {'JINDU_CONFIG','JINDU_PYTHON','TZ','NODE_ENV','PYTHONIOENCODING','PYTHONDONTWRITEBYTECODE'} for key in (spec.get('environment') or {})):
            raise ValueError('Store application secrets in private configuration, not Compose environment')
        spec.pop('build',None); spec.pop('profiles',None)
        spec['image']=target_image['Id'];spec['pull_policy']='never';spec['restart']='no'
        spec['container_name']=project+'-'+service
        spec['labels']={**(spec.get('labels') or {}),'org.jindu.operation':operation}
        if service=='worker':
            spec['healthcheck']={'test':['CMD','node','--experimental-strip-types','deploy/portable/worker-healthcheck.mjs'],'interval':'30s','timeout':'5s','start_period':'30s','retries':3}
        updated['services'][service]=spec
    # Compose named networks/secrets/configs can involve objects outside this app.
    if current.get('secrets') or current.get('configs') or current.get('volumes'):
        raise ValueError('External Compose objects require a separately reviewed deployment')
    if current.get('networks'):
        networks=copy.deepcopy(current['networks'])
        for name,spec in networks.items():
            if spec.get('external'):raise ValueError('External networks require a separately reviewed deployment')
            spec['name']=project+'_'+name
        updated['networks']=networks
    return {'format':1,'operation':operation,'previousCompose':str(compose),'stateDirectory':str(state),'dataDirectory':str(data),'backupSources':sorted(sources),'old':old,'targetImage':target_image['Id'],'release':release,'beforeSchema':before_schema,'compose':updated}


def assert_identity(docker:Docker, expected:dict) -> dict:
    item=docker.inspect(expected['id'])
    # Docker does not promise Mounts array order. Compare every mount attribute
    # while ignoring only array order; permissions/propagation changes still fail.
    signature=lambda mounts:sorted(json.dumps(m,sort_keys=True,separators=(',',':')) for m in mounts)
    if item['Id']!=expected['id'] or item['Image']!=expected['imageId'] or signature(item['Mounts'])!=signature(expected['mounts']):
        raise ValueError('Container identity, image or mounts changed since planning')
    return item


def check_writers(docker:Docker,plan:dict,allowed:set[str]) -> None:
    data=Path(plan['dataDirectory'])
    for identity in docker.run(['ps','-q']).splitlines():
        item=docker.inspect(identity)
        for mount in item['Mounts']:
            if mount['Type']=='bind' and mount.get('RW'):
                source=Path(mount['Source'])
                if (data.is_relative_to(source) or source.is_relative_to(data)) and item['Id'] not in allowed:
                    raise ValueError('An unplanned running container can write the application data')


def graceful_stop(docker:Docker, identity:str, timeout:int=360) -> None:
    docker.run(['update','--restart=no',identity])
    if not docker.inspect(identity)['State']['Running']:return
    docker.run(['kill','--signal=TERM',identity])
    deadline=time.monotonic()+timeout
    while time.monotonic()<deadline:
        if not docker.inspect(identity)['State']['Running']:return
        time.sleep(1)
    raise TimeoutError('Service did not stop gracefully; no forced termination was sent')


def restart_policy(policy:dict) -> str:
    name=policy.get('Name') or 'no'
    return name+(':'+str(policy['MaximumRetryCount']) if name=='on-failure' and policy.get('MaximumRetryCount') else '')


def wait_healthy(docker:Docker,identity:str,timeout:int=120) -> None:
    deadline=time.monotonic()+timeout
    while time.monotonic()<deadline:
        state=docker.inspect(identity)['State']
        if not state['Running']:raise RuntimeError('Candidate service exited')
        if state.get('Health',{}).get('Status')=='healthy':return
        time.sleep(2)
    raise TimeoutError('Candidate health check did not pass')


def owned_candidate(docker:Docker,plan:dict,service:str) -> dict | None:
    name=plan['compose']['services'][service]['container_name']
    ids=docker.run(['ps','-a','--filter','name=^/'+name+'$','--format','{{.ID}}']).splitlines()
    if not ids:return None
    if len(ids)!=1:raise ValueError('Ambiguous candidate container')
    item=docker.inspect(ids[0])
    if item['Name'].lstrip('/')!=name or item['Image']!=plan['targetImage'] or (item['Config'].get('Labels') or {}).get('org.jindu.operation')!=plan['operation']:
        raise ValueError('Candidate container identity does not match this operation')
    if bind_mounts(item['Mounts'])!=bind_mounts(plan['old'][service]['mounts']):
        raise ValueError('Candidate container mounts differ from the preserved installation')
    return item


def clear_marker(plan:dict) -> None:
    marker=Path(plan['dataDirectory'])/'.update-maintenance'
    if marker.exists():
        if marker.read_text(encoding='utf-8')!=plan['operation']:
            raise ValueError('Maintenance marker belongs to another operation')
        marker.unlink()


def recover(docker:Docker,plan:dict,receipt:dict,receipt_path:Path) -> None:
    receipt['status']='recovering';write_json(receipt_path,receipt)
    for service in ['worker','web']:
        item=owned_candidate(docker,plan,service)
        if item:graceful_stop(docker,item['Id'])
    check_writers(docker,plan,{item['id'] for item in plan['old'].values()})
    current=database_version(Path(plan['dataDirectory']))
    if current!=plan['beforeSchema'] and (current!=plan['release']['schemaVersion'] or plan['beforeSchema'] not in plan['release']['rollbackToSchemas']):
        raise ValueError('Automatic software rollback is incompatible with the current data; services remain stopped and all backups are retained')
    for service in ['web','worker']:
        original=plan['old'][service];item=assert_identity(docker,original)
        docker.run(['update','--restart='+restart_policy(original['restart']),original['id']])
        if not item['State']['Running']:docker.run(['start',original['id']])
        if service=='web':wait_healthy(docker,original['id'])
    clear_marker(plan)
    receipt['status']='rolled-back';receipt['databaseRestored']=False;write_json(receipt_path,receipt)


@contextmanager
def update_lock(state:Path):
    import fcntl  # This deployment tool intentionally runs on the Linux server.
    private_dir(state)
    with (state/'update.lock').open('a') as lock:
        os.chmod(state/'update.lock',0o600)
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        yield


def apply(docker:Docker,plan:dict) -> dict:
    state=Path(plan['stateDirectory']);data=Path(plan['dataDirectory']);operation=state/plan['operation']
    if operation.exists():raise ValueError('Operation already exists; inspect its receipt and use recover if interrupted')
    if database_version(data)!=plan['beforeSchema']:raise ValueError('Database version changed after planning')
    if contract(docker.inspect(plan['targetImage']))!=plan['release']:raise ValueError('Target image contract changed')
    for original in plan['old'].values():
        if not assert_identity(docker,original)['State']['Running']:raise ValueError('Current services must be running before applying this plan')
    check_writers(docker,plan,{item['id'] for item in plan['old'].values()})
    for service in ['web','worker']:
        if owned_candidate(docker,plan,service):raise ValueError('Candidate name already exists')
    marker=data/'.update-maintenance'
    if marker.exists():raise ValueError('Another maintenance operation is present')
    private_dir(operation)
    receipt_path=operation/'receipt.json';compose_path=operation/'compose.json'
    receipt={'operation':plan['operation'],'status':'prepared','plan':plan,'phase':'preflight'}
    write_json(receipt_path,receipt);write_json(compose_path,plan['compose'])
    touched=False
    def phase(name:str):
        receipt['phase']=name;write_json(receipt_path,receipt);print(json.dumps({'phase':name}),flush=True)
    try:
        phase('stop-worker');touched=True;graceful_stop(docker,plan['old']['worker']['id'])
        phase('stop-web');graceful_stop(docker,plan['old']['web']['id'],180)
        check_writers(docker,plan,set())
        with sqlite3.connect((data/'jindu.sqlite').as_uri()+'?mode=ro',uri=True) as db:
            if db.execute("SELECT COUNT(*) FROM jobs WHERE state='running'").fetchone()[0]:raise ValueError('Running jobs remain after graceful worker shutdown')
        phase('backup-and-restore-check')
        receipt['backup']=backup_sources([Path(source) for source in plan['backupSources']],operation/'backup')
        receipt['businessBefore']=business_digest(data);write_json(receipt_path,receipt)
        with marker.open('x',encoding='utf-8') as stream:
            os.chmod(marker,0o600);stream.write(plan['operation'])
        phase('start-web')
        docker.run(['compose','-f',str(compose_path),'up','-d','--no-build','--pull','never','web'],120)
        web=owned_candidate(docker,plan,'web');wait_healthy(docker,web['Id'])
        if database_version(data)!=plan['release']['schemaVersion']:raise ValueError('New application did not register the expected data version')
        if business_digest(data)!=receipt['businessBefore']:raise ValueError('Business records changed during startup')
        phase('start-worker')
        docker.run(['compose','-f',str(compose_path),'up','-d','--no-deps','--no-build','--pull','never','worker'],120)
        worker=owned_candidate(docker,plan,'worker');wait_healthy(docker,worker['Id'])
        if business_digest(data)!=receipt['businessBefore']:raise ValueError('Business records changed while maintenance was active')
        phase('complete')
        final=copy.deepcopy(plan['compose'])
        for service,item in [('web',web),('worker',worker)]:
            policy=restart_policy(plan['old'][service]['restart']);final['services'][service]['restart']=policy
            docker.run(['update','--restart='+policy,item['Id']])
        write_json(compose_path,final)
        clear_marker(plan)
        receipt['status']='complete';receipt['containers']={'web':web['Id'],'worker':worker['Id']};receipt['activeCompose']=str(compose_path)
        write_json(receipt_path,receipt)
        write_json(state/'active.json',{'compose':str(compose_path),'image':plan['targetImage'],'version':plan['release']['version'],'receipt':str(receipt_path)})
        return {'status':'complete','version':plan['release']['version'],'receipt':str(receipt_path)}
    except BaseException as error:
        receipt['failureType']=type(error).__name__;receipt['status']='failed';write_json(receipt_path,receipt)
        if touched:
            try:recover(docker,plan,receipt,receipt_path)
            except BaseException as recovery_error:
                receipt['status']='needs-attention';receipt['recoveryFailureType']=type(recovery_error).__name__;write_json(receipt_path,receipt)
        raise


def main() -> None:
    parser=argparse.ArgumentParser(description=__doc__)
    sub=parser.add_subparsers(dest='action',required=True)
    p=sub.add_parser('plan');p.add_argument('--compose',type=Path,required=True);p.add_argument('--image',required=True);p.add_argument('--state-dir',type=Path,required=True);p.add_argument('--output',type=Path,required=True)
    p=sub.add_parser('apply');p.add_argument('--plan',type=Path,required=True);p.add_argument('--sha256',required=True)
    p=sub.add_parser('recover');p.add_argument('--receipt',type=Path,required=True)
    p=sub.add_parser('verify-backup');p.add_argument('--backup',type=Path,required=True);p.add_argument('--destination',type=Path,required=True)
    args=parser.parse_args();docker=Docker()
    if args.action=='plan':
        if args.output.exists():raise ValueError('Plan output already exists')
        plan=prepare(docker,args.compose.resolve(),args.image,args.state_dir.resolve())
        private_dir(args.output.parent);write_json(args.output,plan)
        print(json.dumps({'plan':str(args.output),'sha256':digest(args.output),'version':plan['release']['version'],'operation':plan['operation']}))
    elif args.action=='apply':
        if digest(args.plan)!=args.sha256:raise ValueError('Plan SHA-256 does not match the approved plan')
        plan=json.loads(args.plan.read_text(encoding='utf-8'))
        with update_lock(Path(plan['stateDirectory'])):print(json.dumps(apply(docker,plan)))
    elif args.action=='recover':
        receipt=json.loads(args.receipt.read_text(encoding='utf-8'))
        if receipt['status'] in ['complete','rolled-back']:raise ValueError('Completed operations require a newly prepared plan')
        plan=receipt['plan']
        with update_lock(Path(plan['stateDirectory'])):recover(docker,plan,receipt,args.receipt)
        print(json.dumps({'status':receipt['status']}))
    else:print(json.dumps(verify_backup(args.backup.resolve(),args.destination.resolve())))


if __name__=='__main__':
    try:main()
    except Exception as error:
        # Do not dump paths, credentials, subprocess output or database rows.
        print(json.dumps({'ok':False,'errorType':type(error).__name__,'message':str(error) if isinstance(error,(ValueError,TimeoutError)) else 'Operation failed; inspect the private receipt on this server.'}))
        raise SystemExit(1)
