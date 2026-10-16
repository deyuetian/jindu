"""Offline lifecycle tests: synthetic files and a stateful Docker substitute."""
import copy
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('jindu_manage',ROOT/'deploy/portable/manage.py')
manage=importlib.util.module_from_spec(spec);spec.loader.exec_module(manage)


class FakeDocker:
    def __init__(self,root):
        self.root=root;self.data=root/'data';self.private=root/'private'
        self.data.mkdir();self.private.mkdir();(self.data/'files').mkdir()
        (self.data/'files/fixture').write_bytes(b'synthetic attachment')
        (self.private/'config.json').write_text(json.dumps({'fixture':'synthetic secret'}),encoding='utf-8')
        with sqlite3.connect(self.data/'jindu.sqlite') as db:
            for table in ['records','files','jobs','repeats','history','usage','ai_requests']:
                db.execute('CREATE TABLE '+table+'(id TEXT,state TEXT,data TEXT)')
            db.execute("INSERT INTO records VALUES('task','active','preserve-me')")
        self.mounts=[{'Type':'bind','Source':str(self.data),'Destination':'/var/lib/jindu','RW':True},{'Type':'bind','Source':str(self.private),'Destination':'/run/jindu','RW':False}]
        self.current={'name':'jindu-old','services':{name:{'image':'old','command':['node','backend/'+('app' if name=='web' else 'worker')+'.ts'],'environment':{'JINDU_CONFIG':'/run/jindu/config.json'},'volumes':[{'type':'bind','source':m['Source'],'target':m['Destination'],'read_only':not m['RW']} for m in self.mounts],'restart':'unless-stopped'} for name in ['web','worker']},'networks':{'default':{'name':'jindu-old_default'}}}
        self.image={'Id':'sha256:'+'2'*64,'Config':{'Labels':{'org.opencontainers.image.version':'0.15.0','org.jindu.schema-version':'1','org.jindu.upgrade-from-schemas':'0,1','org.jindu.rollback-to-schemas':'0,1'}}}
        self.items={};self.calls=[];self.fail_start=None;self.mutate_business=False;self.ignore_term=False
        for name in ['web','worker']:
            self.items['old-'+name]=self.container('old-'+name,'old-'+name,'sha256:'+'1'*64,{},'unless-stopped')

    def container(self,identity,name,image,labels,restart):
        return {'Id':identity,'Name':'/'+name,'Image':image,'Config':{'Labels':labels},'HostConfig':{'RestartPolicy':{'Name':restart,'MaximumRetryCount':0}},'State':{'Running':True,'Health':{'Status':'healthy'}},'Mounts':copy.deepcopy(self.mounts)}

    def inspect(self,identity):
        if identity in ['target',self.image['Id']]:return copy.deepcopy(self.image)
        return copy.deepcopy(self.items[identity])

    def run(self,args,timeout=60):
        self.calls.append(args)
        if args[:1]==['compose']:
            if 'config' in args:return json.dumps(self.current)
            if 'ps' in args:return 'old-'+args[-1]
            if 'up' in args:
                service=args[-1]
                if service==self.fail_start:raise RuntimeError('injected candidate start failure')
                config=json.loads(Path(args[2]).read_text(encoding='utf-8'));value=config['services'][service]
                identity='new-'+service
                self.items[identity]=self.container(identity,value['container_name'],value['image'],value['labels'],'no')
                if service=='web':
                    with sqlite3.connect(self.data/'jindu.sqlite') as db:
                        db.execute('PRAGMA user_version=1')
                        if self.mutate_business:db.execute("UPDATE records SET data='new-write-kept'")
                return identity
        if args[:2]==['ps','-q']:return '\n'.join(k for k,v in self.items.items() if v['State']['Running'])
        if args[:2]==['ps','-a']:
            name=args[3].removeprefix('name=^/').removesuffix('$')
            return '\n'.join(k for k,v in self.items.items() if v['Name'].lstrip('/')==name)
        if args[0]=='update':
            self.items[args[-1]]['HostConfig']['RestartPolicy']['Name']=args[1].split('=',1)[1];return ''
        if args[0]=='kill':
            if not self.ignore_term:self.items[args[-1]]['State']['Running']=False
            return ''
        if args[0]=='start':self.items[args[-1]]['State']['Running']=True;return ''
        raise AssertionError('Unexpected command: '+repr(args))


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        location=ROOT/'.check/architecture-v15/upgrade-tests';location.mkdir(parents=True,exist_ok=True)
        self.root=Path(tempfile.mkdtemp(prefix='case-',dir=location)).resolve()
        self.docker=FakeDocker(self.root)
        self.plan=manage.prepare(self.docker,self.root/'compose.yaml','target',self.root/'updates')

    def receipt(self):
        return json.loads((self.root/'updates'/self.plan['operation']/'receipt.json').read_text(encoding='utf-8'))

    def test_success_preserves_data_and_configuration_and_verifies_full_backup(self):
        original=(self.docker.private/'config.json').read_bytes();before=manage.business_digest(self.docker.data)
        result=manage.apply(self.docker,self.plan)
        self.assertEqual(result['status'],'complete');self.assertEqual(manage.business_digest(self.docker.data),before)
        self.assertEqual((self.docker.private/'config.json').read_bytes(),original)
        self.assertFalse((self.docker.data/'.update-maintenance').exists())
        self.assertTrue(self.receipt()['backup']['databaseChecks'])
        for name in ['web','worker']:
            self.assertFalse(self.docker.items['old-'+name]['State']['Running'])
            self.assertEqual(self.docker.items['old-'+name]['HostConfig']['RestartPolicy']['Name'],'no')
            self.assertEqual(self.docker.items['new-'+name]['HostConfig']['RestartPolicy']['Name'],'unless-stopped')
        self.assertNotIn('init',[arg for command in self.docker.calls for arg in command])

    def test_failure_restores_software_without_overwriting_new_records(self):
        self.docker.mutate_business=True
        with self.assertRaisesRegex(ValueError,'Business records changed'):manage.apply(self.docker,self.plan)
        self.assertEqual(self.receipt()['status'],'rolled-back');self.assertFalse(self.receipt()['databaseRestored'])
        with sqlite3.connect(self.docker.data/'jindu.sqlite') as db:self.assertEqual(db.execute('SELECT data FROM records').fetchone()[0],'new-write-kept')
        self.assertTrue(self.docker.items['old-worker']['State']['Running'])

    def test_worker_start_failure_restores_previous_services(self):
        self.docker.fail_start='worker'
        with self.assertRaises(RuntimeError):manage.apply(self.docker,self.plan)
        self.assertEqual(self.receipt()['status'],'rolled-back')
        self.assertFalse(self.docker.items['new-web']['State']['Running'])
        self.assertTrue(self.docker.items['old-web']['State']['Running'])

    def test_incompatible_rollback_keeps_backup_and_services_stopped(self):
        self.docker.image['Config']['Labels']['org.jindu.rollback-to-schemas']='1'
        self.plan=manage.prepare(self.docker,self.root/'compose.yaml','target',self.root/'updates')
        self.docker.fail_start='worker'
        with self.assertRaises(RuntimeError):manage.apply(self.docker,self.plan)
        self.assertEqual(self.receipt()['status'],'needs-attention')
        self.assertFalse(self.docker.items['old-web']['State']['Running'])
        self.assertTrue((self.docker.data/'.update-maintenance').exists())
        self.assertTrue(Path(self.receipt()['backup']['directory']).is_dir())

    def test_external_writer_stops_before_any_service_mutation(self):
        self.docker.items['other']=self.docker.container('other','other','another-image',{},'no')
        with self.assertRaisesRegex(ValueError,'unplanned running'):manage.apply(self.docker,self.plan)
        self.assertFalse(any(c[0] in ['kill','update'] for c in self.docker.calls))

    def test_identity_drift_stops_before_mutation(self):
        self.docker.items['old-web']['Image']='changed'
        with self.assertRaisesRegex(ValueError,'identity'):manage.apply(self.docker,self.plan)
        self.assertFalse(any(c[0] in ['kill','update'] for c in self.docker.calls))

    def test_docker_mount_order_can_change_without_rejecting_the_same_identity(self):
        for name in ['old-web','old-worker']:self.docker.items[name]['Mounts'].reverse()
        self.assertEqual(manage.apply(self.docker,self.plan)['status'],'complete')

    def test_mount_attributes_are_still_verified_after_order_normalization(self):
        for attribute,value in [('RW',False),('Propagation','shared'),('Mode','changed')]:
            with self.subTest(attribute=attribute):
                item=copy.deepcopy(self.docker.items['old-web'])
                item['Mounts'].reverse();item['Mounts'][1][attribute]=value
                with patch.object(self.docker,'inspect',return_value=item):
                    with self.assertRaisesRegex(ValueError,'identity'):
                        manage.assert_identity(self.docker,self.plan['old']['web'])

    def test_compose_mount_drift_is_rejected_before_planning(self):
        self.docker.current['services']['web']['volumes'][0]['source']=str(self.root/'wrong-data')
        with self.assertRaisesRegex(ValueError,'Compose mounts differ'):
            manage.prepare(self.docker,self.root/'compose.yaml','target',self.root/'updates')
        self.assertFalse(any(c[0] in ['kill','update'] for c in self.docker.calls))

    def test_unplanned_dependency_is_rejected_before_planning(self):
        self.docker.current['services']['worker']['depends_on']={'unrelated':{'condition':'service_started'}}
        with self.assertRaisesRegex(ValueError,'unplanned container'):
            manage.prepare(self.docker,self.root/'compose.yaml','target',self.root/'updates')

    def test_future_schema_is_rejected_in_plan(self):
        with sqlite3.connect(self.docker.data/'jindu.sqlite') as db:db.execute('PRAGMA user_version=99')
        with self.assertRaisesRegex(ValueError,'does not support'):manage.prepare(self.docker,self.root/'compose.yaml','target',self.root/'updates')

    def test_missing_contract_does_not_guess_compatibility(self):
        self.docker.image['Config']['Labels']={}
        with self.assertRaisesRegex(ValueError,'version label'):manage.prepare(self.docker,self.root/'compose.yaml','target',self.root/'updates')

    def test_graceful_timeout_never_forces_termination(self):
        self.docker.ignore_term=True
        with patch.object(manage.time,'monotonic',side_effect=[0,0,2]),patch.object(manage.time,'sleep'):
            with self.assertRaises(TimeoutError):manage.graceful_stop(self.docker,'old-worker',1)
        signals=[c for c in self.docker.calls if c[0]=='kill']
        self.assertEqual(signals,[['kill','--signal=TERM','old-worker']])
        self.assertTrue(self.docker.items['old-worker']['State']['Running'])

    def test_backup_corruption_is_detected_before_restore(self):
        destination=self.root/'complete-backup';manage.backup_sources([self.docker.data,self.docker.private],destination)
        with (destination/'snapshot.tar').open('ab') as stream:stream.write(b'corrupt')
        with self.assertRaisesRegex(ValueError,'checksum mismatch'):manage.verify_backup(destination,self.root/'restore-corrupt')
        self.assertFalse((self.root/'restore-corrupt').exists())

    def test_backup_membership_and_path_traversal_are_rejected(self):
        destination=self.root/'complete-backup';manage.backup_sources([self.docker.data],destination)
        manifest=json.loads((destination/'manifest.json').read_text(encoding='utf-8'))
        manifest['entries'][0]['name']='mount-0/../../escape'
        manage.write_json(destination/'manifest.json',manifest)
        with self.assertRaisesRegex(ValueError,'Unsafe'):manage.verify_backup(destination,self.root/'restore-path')

    def test_backup_cannot_recursively_include_itself(self):
        with self.assertRaisesRegex(ValueError,'overlaps'):manage.backup_sources([self.docker.data],self.docker.data/'updates/backup')

    def test_existing_backup_and_restore_directory_are_preserved(self):
        destination=self.root/'complete-backup';manage.backup_sources([self.docker.data],destination)
        original=manage.digest(destination/'snapshot.tar')
        with self.assertRaises(ValueError):manage.backup_sources([self.docker.data],destination)
        with self.assertRaises(ValueError):manage.verify_backup(destination,destination/'restore-check')
        self.assertEqual(manage.digest(destination/'snapshot.tar'),original)

    def test_no_space_restores_old_services_and_keeps_data(self):
        with patch.object(manage.shutil,'disk_usage',return_value=type('Usage',(),{'free':0})()):
            with self.assertRaisesRegex(ValueError,'Insufficient'):manage.apply(self.docker,self.plan)
        self.assertEqual(self.receipt()['status'],'rolled-back')
        self.assertTrue(self.docker.items['old-worker']['State']['Running'])

    def test_completed_operation_cannot_be_reapplied(self):
        manage.apply(self.docker,self.plan)
        with self.assertRaisesRegex(ValueError,'already exists'):manage.apply(self.docker,self.plan)


if __name__=='__main__':unittest.main(verbosity=2)
