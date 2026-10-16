import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {workerHealth} from '../../backend/runtime-health.ts';
let db;
try {
  const config=JSON.parse(readFileSync(process.env.JINDU_CONFIG,'utf8'));
  db=new DatabaseSync(join(config.dataDir,'jindu.sqlite'),{readOnly:true});
  db.exec('PRAGMA busy_timeout=2000');
  const row=db.prepare("SELECT value FROM settings WHERE key='worker-status'").get();
  process.exitCode=workerHealth(row?JSON.parse(row.value):{}).healthy?0:1;
}catch{process.exitCode=1;}finally{db?.close();}
