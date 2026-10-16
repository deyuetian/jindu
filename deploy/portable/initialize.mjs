// Fresh installations only. Never rewrites an existing account, key or database.
import {mkdirSync,writeFileSync,existsSync,readdirSync,chownSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
const privateDir='/run/jindu',dataDir='/var/lib/jindu',origin=new URL(process.env.JINDU_ORIGIN||'http://localhost:8788');
const local=['localhost','127.0.0.1','[::1]'].includes(origin.hostname);
if(origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash||!(origin.protocol==='https:'||local&&origin.protocol==='http:'))throw new Error('Use an HTTPS public origin, or HTTP on localhost only.');
const adminUsername=process.env.JINDU_ADMIN||'admin';if(!/^[A-Za-z0-9_.-]{1,80}$/.test(adminUsername))throw new Error('Invalid account name.');
for(const dir of [privateDir,dataDir]){mkdirSync(dir,{recursive:true});if(readdirSync(dir).length)throw new Error('Initialization refused: data/private directories must be empty. For migration, preserve the existing configuration and master key.');}
const password=randomBytes(24).toString('base64url'),salt=randomBytes(16).toString('hex');
const digest=createHash('sha256').update('jindu-login-v1\0'+salt+'\0'+password).digest('hex');
const config={origin:origin.origin,host:'0.0.0.0',port:8788,dataDir,distDir:'/app/dist',python:'/opt/python/bin/python',adminUsername,passwordHash:`random-v1$192$${salt}$${digest}`,masterKey:randomBytes(32).toString('hex')};
const files=[join(privateDir,'config.json'),join(privateDir,'login.txt')];
writeFileSync(files[0],JSON.stringify(config,null,2)+'\n',{mode:0o600,flag:'wx'});
writeFileSync(files[1],`Website: ${config.origin}\nAccount: ${adminUsername}\nPassword: ${password}\n`,{mode:0o600,flag:'wx'});
for(const dir of [privateDir,dataDir]){chmodSync(dir,0o700);chownSync(dir,1000,1000);}
for(const file of files)chownSync(file,1000,1000);
console.log('Initialized. Read private/login.txt locally and keep it private. Credentials were not printed.');
