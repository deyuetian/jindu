import type {DatabaseSync} from 'node:sqlite';

export const schemaVersion = 1;
export type Migration = {version:number; name:string; apply:(db:DatabaseSync)=>void};

export function readSchemaVersion(db:DatabaseSync):number {
  return Number((db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version);
}

/** Forward migrations are atomic. Never open a newer database as an older app. */
export function migrateSchema(db:DatabaseSync, migrations:readonly Migration[], supported:number):void {
  const current=readSchemaVersion(db);
  if(current>supported)throw new Error(`Database schema ${current} requires a newer application (supported: ${supported}).`);
  if(db.isTransaction)throw new Error('Schema migration requires its own transaction.');
  for(let version=current+1;version<=supported;version++){
    if(migrations.filter(m=>m.version===version).length!==1)throw new Error(`Missing or ambiguous migration ${version}.`);
  }
  if(current===supported)return;
  db.exec('BEGIN IMMEDIATE');
  try {
    // Another process may have completed the migration while this one waited.
    const locked=readSchemaVersion(db);
    if(locked>supported)throw new Error('Database changed to an unsupported version.');
    for(const migration of migrations.filter(m=>m.version>locked&&m.version<=supported).sort((a,b)=>a.version-b.version)){
      migration.apply(db);
      db.exec(`PRAGMA user_version=${migration.version}`);
    }
    db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
}

const baseline:Migration={version:1,name:'Register the existing schema and add attachment lookup index',apply(db){
  db.exec(`
    CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY,kind TEXT NOT NULL,data TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS rate_limits(bucket TEXT PRIMARY KEY,hits INTEGER NOT NULL,expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,type TEXT NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,available_at INTEGER NOT NULL DEFAULT 0,error TEXT NOT NULL DEFAULT '',updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS files(id TEXT PRIMARY KEY,announcement_id TEXT NOT NULL,name TEXT NOT NULL,url TEXT NOT NULL,mime TEXT NOT NULL,size INTEGER NOT NULL,sha256 TEXT NOT NULL,text TEXT NOT NULL DEFAULT '',error TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS history(id INTEGER PRIMARY KEY,record_id TEXT NOT NULL,content_hash TEXT NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS usage(day TEXT PRIMARY KEY,calls INTEGER NOT NULL DEFAULT 0,input_tokens INTEGER NOT NULL DEFAULT 0,output_tokens INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS ai_requests(id TEXT PRIMARY KEY,day TEXT NOT NULL,model TEXT NOT NULL,purpose TEXT NOT NULL,started_at TEXT NOT NULL,finished_at TEXT,outcome TEXT NOT NULL DEFAULT 'running',input_tokens INTEGER,output_tokens INTEGER,total_tokens INTEGER,usage_complete INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS repeats(id TEXT PRIMARY KEY,template TEXT NOT NULL,period TEXT NOT NULL,next_date TEXT NOT NULL,until_date TEXT NOT NULL DEFAULT '',active INTEGER NOT NULL DEFAULT 1);
    CREATE INDEX IF NOT EXISTS ai_requests_day ON ai_requests(day);
    CREATE INDEX IF NOT EXISTS ai_requests_time ON ai_requests(started_at DESC);
    CREATE INDEX IF NOT EXISTS jobs_state ON jobs(state,available_at);
    CREATE INDEX IF NOT EXISTS records_kind ON records(kind);
    CREATE INDEX IF NOT EXISTS files_announcement ON files(announcement_id);
  `);
  // INSERT ... VALUES statements rely on this legacy column order. An unknown
  // extra/reordered column must not silently receive another field's value.
  const required:Record<string,string[]>={
    records:['id','kind','data','version','updated_at'],settings:['key','value'],
    sessions:['token_hash','expires_at'],rate_limits:['bucket','hits','expires_at'],
    files:['id','announcement_id','name','url','mime','size','sha256','text','error'],
    jobs:['id','type','payload','state','attempts','available_at','error','updated_at'],
    history:['id','record_id','content_hash','data','created_at'],
    usage:['day','calls','input_tokens','output_tokens'],
    ai_requests:['id','day','model','purpose','started_at','finished_at','outcome','input_tokens','output_tokens','total_tokens','usage_complete'],
    repeats:['id','template','period','next_date','until_date','active'],
  };
  for(const [table,columns] of Object.entries(required)){
    const names=(db.prepare(`PRAGMA table_info(${table})`).all() as {name:string}[]).map(row=>row.name);
    if(JSON.stringify(names)!==JSON.stringify(columns))throw new Error(`Incompatible legacy table: ${table}`);
  }
}};

export function initializeSchema(db:DatabaseSync):void {
  if(readSchemaVersion(db)>schemaVersion)throw new Error('Database was created by a newer version; update the application first.');
  db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
  migrateSchema(db,[baseline],schemaVersion);
}
