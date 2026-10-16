"""Fresh, synthetic Compose installation on an ephemeral Linux CI runner.

The image must already be built. Never uses the checkout's data/private folders,
publishes a host port, connects to external sites, or prints generated credentials.
Run only on a disposable CI runner: this creates/stops its own Docker containers.
"""
from pathlib import Path
import json
import os
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
PROJECT = 'jindu-ci-install'
NAMES = {service: PROJECT + '-' + service for service in ['init', 'web', 'worker']}


def docker(*args, check=True, timeout=120):
    return subprocess.run(['docker', *args], check=check, capture_output=True,
                          text=True, timeout=timeout)


def main():
    if os.environ.get('CI') != 'true' or os.name != 'posix':
        raise RuntimeError('Run only on an ephemeral Linux CI runner with CI=true')
    image = docker('image', 'inspect', os.environ.get('JINDU_IMAGE', 'jindu:ci'))
    image_info = json.loads(image.stdout)[0]
    identity = image_info['Id']
    labels = image_info['Config']['Labels']
    for name in NAMES.values():
        if docker('container', 'inspect', name, check=False).returncode == 0:
            raise RuntimeError('A validation container already exists; refusing reuse')
    base = Path(tempfile.mkdtemp(prefix='jindu-install-'))
    data, private = base / 'data', base / 'private'
    data.mkdir(); private.mkdir()
    spec = json.loads(docker('compose', '--profile', 'setup', '-f', str(ROOT / 'compose.yaml'),
                             'config', '--format', 'json').stdout)
    spec['name'] = PROJECT
    spec.pop('networks', None)
    for service, entry in spec['services'].items():
        entry.pop('build', None)
        entry.pop('profiles', None)
        entry.pop('ports', None)
        entry.pop('networks', None)
        entry['image'] = identity
        entry['container_name'] = NAMES[service]
        entry['restart'] = 'no'
        entry['network_mode'] = 'none'
        entry['mem_limit'] = '1g'
        entry['cpus'] = 2
        for volume in entry['volumes']:
            if volume['target'] == '/var/lib/jindu':
                volume['source'] = str(data)
            elif volume['target'] == '/run/jindu':
                volume['source'] = str(private)
            else:
                raise RuntimeError('Unexpected mount in public Compose')
    spec['services']['init']['environment']['JINDU_ORIGIN'] = 'http://localhost:8788'
    spec['services']['init']['environment']['JINDU_ADMIN'] = 'ci-fixture'
    config = base / 'compose.json'
    config.write_text(json.dumps(spec), encoding='utf-8')
    compose = ['compose', '-p', PROJECT, '-f', str(config)]
    owned = {}
    try:
        docker(*compose, 'up', '--no-build', '--pull', 'never', '--no-deps',
               '--abort-on-container-exit', '--exit-code-from', 'init', 'init')
        docker(*compose, 'up', '-d', '--no-build', '--pull', 'never', 'web', 'worker')
        for service, name in NAMES.items():
            item = json.loads(docker('inspect', name).stdout)[0]
            assert item['Image'] == identity
            assert item['Config']['Labels']['com.docker.compose.project'] == PROJECT
            assert item['HostConfig']['NetworkMode'] == 'none'
            assert not item['HostConfig']['PortBindings']
            owned[service] = item['Id']
        deadline = time.monotonic() + 90
        while True:
            states = [json.loads(docker('inspect', owned[s]).stdout)[0]['State']
                      for s in ['web', 'worker']]
            if all(s.get('Health', {}).get('Status') == 'healthy' for s in states):
                break
            if time.monotonic() > deadline or any(not s['Running'] for s in states):
                raise RuntimeError('Fresh installation did not become healthy')
            time.sleep(1)
        probe = r'''
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const c=JSON.parse(readFileSync('/run/jindu/config.json','utf8'));
const password=/^Password: (.+)$/m.exec(readFileSync('/run/jindu/login.txt','utf8'))[1];
const headers={'content-type':'application/json',Origin:c.origin};
const login=await fetch(c.origin+'/api/login',{method:'POST',headers,body:JSON.stringify({username:c.adminUsername,password})});
assert.equal(login.status,200);
headers.Cookie=login.headers.get('set-cookie').split(';')[0];
const title='Synthetic Compose installation';
const added=await fetch(c.origin+'/api/records/task',{method:'POST',headers,body:JSON.stringify({data:{title,category:'日常',due:'2030-01-01',time:'',priority:'普通',done:false,notes:'',goalId:'',archived:false}})});
assert.equal(added.status,201);
const state=await fetch(c.origin+'/api/state?compact=1',{headers}).then(r=>r.json());
assert.equal(state.tasks.filter(t=>t.title===title).length,1);
const health=await fetch(c.origin+'/api/health/details',{headers}).then(r=>r.json());
assert.equal(health.version,process.argv[1]);assert.equal(health.schemaVersion,Number(process.argv[2]));assert.equal(health.worker.healthy,true);
console.log(JSON.stringify({login:true,task:true,worker:true,schema:health.schemaVersion,configHash:createHash('sha256').update(readFileSync('/run/jindu/config.json')).digest('hex')}));
'''
        before = json.loads(docker('exec', owned['web'], 'node', '--input-type=module',
                                    '-e', probe, labels['org.opencontainers.image.version'],
                                    labels['org.jindu.schema-version']).stdout)
        # Calling the initializer again must refuse existing data and credentials.
        repeated = docker('exec', owned['web'], 'node',
                          'deploy/portable/initialize.mjs', check=False)
        assert repeated.returncode != 0
        assert 'directories must be empty' in repeated.stderr
        after = docker('exec', owned['web'], 'node', '--input-type=module', '-e',
                       "import{readFileSync}from'node:fs';import{createHash}from'node:crypto';"
                       "console.log(createHash('sha256').update(readFileSync('/run/jindu/config.json')).digest('hex'))")
        assert after.stdout.strip() == before.pop('configHash')
        print(json.dumps({'passed': True, **before, 'reinitializeRefused': True,
                          'network': 'none', 'hostPorts': 0, 'externalAICalls': 0}))
    finally:
        # Remove only this runner's fixed project; never touch images or volumes.
        for name in NAMES.values():
            item = docker('inspect', name, check=False)
            if item.returncode:
                continue
            item = json.loads(item.stdout)[0]
            if (item['Image'] != identity or
                item['Config']['Labels'].get('com.docker.compose.project') != PROJECT):
                raise RuntimeError('Validation container identity changed; cleanup stopped')
        docker(*compose, 'down', '--timeout', '30')


if __name__ == '__main__':
    main()
