// The runtime image must execute this check with no network, production data or credentials.
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {Store} from '../../backend/db.ts';
import {analysisContext} from '../../backend/ai.ts';
import {httpFailure} from '../../backend/ai-failure.ts';
import {fileTool} from '../../backend/files.ts';
import {tableSegments} from '../../backend/job-tables.ts';
const dir=mkdtempSync(join(tmpdir(),'jindu-catalog-')),python=process.env.JINDU_PYTHON||'python3';
const source=`import io,json,sys,zipfile,importlib.util
from pathlib import Path
from openpyxl import Workbook
sys.path.insert(0,str(Path('backend').resolve()))
spec=importlib.util.spec_from_file_location('files',Path('backend/file-tools.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
root=Path(sys.argv[1]);(root/'files').mkdir()
def workbook(rows):
 b=Workbook()
 for row in rows:b.active.append(row)
 s=io.BytesIO();b.save(s);return s.getvalue()
class LegacyName(zipfile.ZipInfo):
 def _encodeFilenameFlags(self):return self.filename.encode('gb18030'),self.flag_bits&~0x800
with zipfile.ZipFile(root/'files'/'file','w') as z:
 z.writestr(LegacyName('目录/二级学科名单.xlsx'),workbook([['学位授予单位自主设置二级学科名单'],['单位名称','一级学科','二级学科'],['某大学','农业资源与环境','土壤学']]))
 z.writestr(LegacyName('目录/岗位.xlsx'),workbook([['岗位名称','专业要求'],['科研','土壤学']]))
 z.writestr(LegacyName('~$专业目录.docx'),b'lock')
r=m.parse(root/'files'/'file','专业目录及岗位.zip')
assert not r['error'] and len(r['tables'][0]['rows'])==0 and len(r['tables'][1]['rows'])==1
assert r['ignored']==['~$专业目录.docx']
print(json.dumps(r,ensure_ascii=False))`;
const parsed=spawnSync(python,['-c',source,dir],{encoding:'utf8',windowsHide:true,timeout:60000,env:{...process.env,PYTHONIOENCODING:'utf-8'}});
assert.equal(parsed.status,0,parsed.stderr);const value=JSON.parse(parsed.stdout),store=new Store(dir);
try{
 store.put('p','profile',{education:[{level:'硕士',major:'土壤学'}]});
 store.put('a','announcement',{title:'招聘',body:'招聘公告',url:'https://example.invalid',contentHash:'fixture',fileIds:['file']});
 store.prepare('INSERT INTO files VALUES(?,?,?,?,?,?,?,?,?)').run('file','a','专业目录及岗位.zip','https://example.invalid/files','application/zip',1,'fixture',value.text,value.error);
 store.setSetting('workbook-v2:file',value);
 const c=await analysisContext(store,{dataDir:dir,python},'a');
 assert.equal(c.tables.stats.rows,1);assert.equal(c.initial.filter(s=>s.table).length,1);assert.ok(c.tables.referenceText.includes('土壤学'));
 assert.equal(c.issues.length,0);assert.equal(httpFailure(500,null).code,'unavailable');
 assert.equal(store.prepare('SELECT COUNT(*) n FROM ai_requests').get().n,0);
 console.log(JSON.stringify({passed:true,archiveNames:true,catalogueExcluded:true,positionsRetained:true,http500IsNotQuota:true,externalAICalls:0}));
}finally{store.db.close();}

if(process.argv.includes('--documents')){
 const real=new Store(mkdtempSync(join(tmpdir(),'jindu-catalog-docs-'))),config={dataDir:real.dir,python};
 try{
  const catalogue=await fileTool(config,['parse','/inputs/catalog.zip','教育部学科专业目录汇总.zip']);
  const positions=await fileTool(config,['parse','/inputs/positions.xlsx','公开招聘岗位及要求.xlsx']);
  assert.equal(catalogue.error,'');assert.equal(catalogue.tables.length,3);assert.equal(catalogue.documents.length,13);assert.equal(catalogue.ignored.length,2);
  assert.ok(catalogue.tables.every(t=>t.kind==='reference'&&t.rows.length===0));
  assert.equal(positions.error,'');assert.equal(positions.tables.flatMap(t=>t.rows).length,26);
  const files=[{id:'catalog',name:'教育部学科专业目录汇总.zip',text:catalogue.text,error:''},{id:'positions',name:'公开招聘岗位及要求.xlsx',text:positions.text,error:''}];
  real.setSetting('workbook-v2:catalog',catalogue);real.setSetting('workbook-v2:positions',positions);
  for(const f of files)real.prepare('INSERT INTO files VALUES(?,?,?,?,?,?,?,?,?)').run(f.id,'a',f.name,'https://example.invalid/file','application/octet-stream',1,'fixture',f.text,'');
  const result=await tableSegments(real,config,files,[{education:[{level:'硕士',major:'土壤学'},{level:'本科',major:'土地资源管理'}]}]);
  assert.equal(result.stats.rows,26);assert.equal(result.segments.filter(s=>s.table).length,7);assert.deepEqual(result.issues,[]);
  assert.ok(result.referenceText.includes('090301')&&result.referenceText.includes('土壤学')&&result.referenceText.includes('土地资源管理'));
  console.log(JSON.stringify({passed:true,publicOriginals:2,catalogueDocuments:16,positions:26,tableBatches:7,referenceChars:result.referenceText.length,parseErrors:0,externalAICalls:0}));
 }finally{real.db.close();}
}
