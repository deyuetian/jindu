import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {mkdirSync,mkdtempSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {Store} from '../backend/db.ts';
import type {Config} from '../backend/config.ts';
import {runWorkerTick} from '../backend/worker.ts';
import {makeBackup} from '../backend/backup.ts';
import {followExam} from '../backend/agent.ts';
import {todayCN} from '../shared/model.ts';
import {formatDateTime} from '../shared/datetime.ts';
import {usageSummary} from '../backend/usage.ts';

vi.mock('../backend/backup.ts',async original=>({...await original<typeof import('../backend/backup.ts')>(),makeBackup:vi.fn(async()=>({name:'synthetic-backup.zip'}))}));
vi.mock('../backend/agent.ts',async original=>({...await original<typeof import('../backend/agent.ts')>(),followExam:vi.fn(async()=>{})}));

let store:Store,config:Config;
beforeEach(()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-09-26T15:59:59Z'));
  mkdirSync('.check/tests',{recursive:true});
  const dataDir=mkdtempSync(resolve('.check/tests/memory-'));
  store=new Store(dataDir);
  config={dataDir,origin:'http://127.0.0.1:8788',host:'127.0.0.1',port:8788,adminUsername:'fixture',passwordHash:'unused',masterKey:randomBytes(32).toString('hex'),python:'unused',distDir:resolve('dist')};
  store.setSetting('sources',{autoEnabled:false,sites:[]});
  for(const key of ['last-auto-follow','last-auto-backup'])store.setSetting(key,todayCN());
  vi.mocked(makeBackup).mockClear();vi.mocked(followExam).mockClear();
});
afterEach(()=>{store.db.close();vi.restoreAllMocks();vi.useRealTimers();});

describe('bounded timezone formatting allocations',()=>{
  it('formats changing dates across Beijing midnight, leap day and year boundaries without new ICU objects',()=>{
    const constructor=vi.spyOn(Intl,'DateTimeFormat');
    const cases=[['2026-12-31T15:59:59Z','2026-12-31','2026-12-31 23:59:59'],['2026-12-31T16:00:00Z','2027-01-01','2027-01-01 00:00:00'],['2028-02-28T16:00:00Z','2028-02-29','2028-02-29 00:00:00']];
    for(let i=0;i<100;i++)for(const [input,day,time] of cases){expect(todayCN(new Date(input))).toBe(day);expect(formatDateTime(input)).toBe(time);}
    expect(formatDateTime()).toBe('尚无记录');expect(formatDateTime('invalid')).toBe('时间待核对');
    expect(constructor).not.toHaveBeenCalled();
  });
  it('keeps the real idle worker polling without constructing formatters or adding tasks',async()=>{
    const constructor=vi.spyOn(Intl,'DateTimeFormat');
    const prepares=vi.spyOn(store.db,'prepare');
    for(let i=0;i<200;i++)await runWorkerTick(store,config);
    expect(constructor).not.toHaveBeenCalled();
    expect(prepares.mock.calls.length).toBeLessThan(32);
    expect(store.db.prepare('SELECT COUNT(*) n FROM jobs').get()).toMatchObject({n:0});
    expect(store.getSetting<{running:boolean}>('worker-status',{running:false}).running).toBe(true);
  });
  it('rebinds cached statements and observes committed changes on another connection',()=>{
    const other=new Store(config.dataDir);
    try{
      store.setSetting('binding-a',{value:1});store.setSetting('binding-b',{value:2});
      expect(store.getSetting('binding-a',null)).toEqual({value:1});expect(store.getSetting('binding-b',null)).toEqual({value:2});
      other.setSetting('binding-a',{value:3});expect(store.getSetting('binding-a',null)).toEqual({value:3});
      // More than the fixed cache capacity must remain correct after eviction.
      for(let i=0;i<40;i++)expect(store.prepare(`SELECT ${i} n`).get()).toMatchObject({n:i});
      store.setSetting('binding-b',{value:4});expect(store.getSetting('binding-b',null)).toEqual({value:4});
    }finally{other.db.close();}
  });
  it('still performs one daily backup at Beijing midnight and one follow round from 09:00',async()=>{
    store.put('tracked-exam','exam',{title:'fixture',tracking:{enabled:true}});
    await runWorkerTick(store,config);expect(makeBackup).not.toHaveBeenCalled();
    vi.setSystemTime(new Date('2026-09-26T16:00:00Z'));
    await runWorkerTick(store,config);await runWorkerTick(store,config);
    expect(makeBackup).toHaveBeenCalledTimes(1);expect(followExam).not.toHaveBeenCalled();
    vi.setSystemTime(new Date('2026-09-27T00:59:59Z'));await runWorkerTick(store,config);expect(followExam).not.toHaveBeenCalled();
    vi.setSystemTime(new Date('2026-09-27T01:00:00Z'));await runWorkerTick(store,config);await runWorkerTick(store,config);
    expect(followExam).toHaveBeenCalledTimes(1);expect(store.getSetting('last-auto-follow','')).toBe('2026-09-27');
  });
  it('reuses date formatting for repeated usage views while retaining the correct seven-day window',()=>{
    vi.setSystemTime(new Date('2026-12-31T16:00:00Z'));
    const constructor=vi.spyOn(Intl,'DateTimeFormat');
    for(let i=0;i<50;i++)expect(usageSummary(store).days.map(d=>d.day)).toEqual(['2027-01-01','2026-12-31','2026-12-30','2026-12-29','2026-12-28','2026-12-27','2026-12-26']);
    expect(constructor).not.toHaveBeenCalled();
  });
});
