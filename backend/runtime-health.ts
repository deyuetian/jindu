import type {Store} from './db.ts';
import {readSchemaVersion} from './schema.ts';
import {applicationVersion} from './version.ts';
import {existsSync} from 'node:fs';
import {join} from 'node:path';

export function updateMaintenance(dataDir:string):boolean {
  return existsSync(join(dataDir,'.update-maintenance'));
}

type WorkerStatus={lastHeartbeat?:string;running?:boolean;lastErrorAt?:string};
export function startWorkerHeartbeat(store:Store,intervalMs=15000) {
  const beat=()=>store.setSetting('worker-status',{...store.getSetting<WorkerStatus>('worker-status',{}),lastHeartbeat:new Date().toISOString(),running:true});
  beat();
  const timer=setInterval(()=>{try{beat();}catch{/* A stale heartbeat is reported by health checks. */}},intervalMs);
  timer.unref();
  return ()=>{clearInterval(timer);store.setSetting('worker-status',{...store.getSetting<WorkerStatus>('worker-status',{}),lastHeartbeat:new Date().toISOString(),running:false});};
}
export function workerHealth(status:WorkerStatus,instant=Date.now()) {
  const timestamp=Date.parse(status.lastHeartbeat||'');
  const age=Number.isFinite(timestamp)?instant-timestamp:Infinity;
  const healthy=status.running===true&&age>=-5000&&age<=90000;
  return {healthy,state:healthy?'running':status.running===false?'stopped':Number.isFinite(timestamp)?'stale':'unknown',heartbeatAgeSeconds:Number.isFinite(age)?Math.max(0,Math.round(age/1000)):null};
}

export function runtimeHealth(store:Store,instant=Date.now()) {
  const worker=workerHealth(store.getSetting<WorkerStatus>('worker-status',{}),instant);
  const backup=store.getSetting<{lastSuccess?:string;error?:string}>('backup-status',{});
  const backupAge=instant-Date.parse(backup.lastSuccess||'');
  const backupState=backup.error?'failed':!Number.isFinite(backupAge)?'missing':backupAge>36*3600000?'overdue':'current';
  const running=store.prepare("SELECT updated_at FROM jobs WHERE state='running'").all() as {updated_at:string}[];
  const longRunning=running.filter(row=>instant-Date.parse(row.updated_at)>15*60000).length;
  const failed=(store.prepare("SELECT COUNT(*) n FROM jobs WHERE state='error'").get() as {n:number}).n;
  const waiting=(store.prepare("SELECT COUNT(*) n FROM jobs WHERE state IN ('pending','retry') AND available_at<=?").get(instant) as {n:number}).n;
  return {version:applicationVersion,schemaVersion:readSchemaVersion(store.db),worker,backup:{state:backupState,lastSuccess:backup.lastSuccess||''},queue:{failed,waiting,longRunning},maintenance:updateMaintenance(store.dir)||store.getSetting('maintenance',false)};
}
