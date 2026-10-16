import { useEffect, useRef, useState } from 'react';

export default function AIForm({value,onSave,onTest,onModels}:{value:any;onSave:(v:any)=>Promise<any>;onTest:()=>Promise<any>;onModels:(v:{baseUrl:string;key:string},signal:AbortSignal)=>Promise<{models:{id:string}[]}>}) {
  const [draft,setDraft]=useState({...value,key:''});
  const [operation,setOperation]=useState<'saving'|'testing'|''>('');
  const [result,setResult]=useState(''),[error,setError]=useState('');
  const [models,setModels]=useState<string[]>([]),[modelStatus,setModelStatus]=useState(''),[modelError,setModelError]=useState(''),[manual,setManual]=useState(false),[reload,setReload]=useState(0);
  const modelRequest=useRef(onModels);modelRequest.current=onModels;
  const saved=JSON.stringify(value);
  useEffect(()=>{setDraft({...JSON.parse(saved),key:''});},[saved]);
  useEffect(()=>{
    const controller=new AbortController();let active=true;
    setModels([]);setModelError('');setModelStatus('');
    if(!draft.baseUrl||(!draft.key&&!value.keyConfigured))return;
    try{if(new URL(draft.baseUrl).protocol!=='https:')return;}catch{return;}
    setModelStatus('正在读取可用模型…');
    const timer=setTimeout(()=>{
      modelRequest.current({baseUrl:draft.baseUrl,key:draft.key},controller.signal).then(response=>{
        if(!active)return;
        const ids=response.models.map(m=>m.id);setModels(ids);setModelStatus(`${ids.length} 个可用模型`);
        setDraft((current:any)=>!current.model&&ids.length===1?{...current,model:ids[0]}:current);
      }).catch(e=>{if(active){setModelStatus('');setModelError(e instanceof Error?e.message:'读取模型失败，请重试');}});
    },800);
    return()=>{active=false;clearTimeout(timer);controller.abort();};
  },[draft.baseUrl,draft.key,value.keyConfigured,reload]);
  const busy=!!operation;
  async function save() {
    setOperation('saving');setResult('');setError('');
    try {const stored=await onSave(draft);setDraft({...stored,key:''});setResult('已保存');}
    catch(e){setError(e instanceof Error?e.message:'保存失败，请重试');}
    finally{setOperation('');}
  }
  async function test() {
    setOperation('testing');setResult('');setError('');
    try {await onTest();setResult('连接正常');}
    catch(e){setError(e instanceof Error?e.message:'连接测试失败，请重试');}
    finally{setOperation('');}
  }
  return <form className="ai-settings-form" onSubmit={e=>{e.preventDefault();void save();}}>
    <label>Base URL<input type="url" value={draft.baseUrl||''} disabled={busy} onChange={e=>setDraft({...draft,baseUrl:e.target.value,model:''})} placeholder="https://你的接口地址/v1"/></label>
    <label>API Key<input type="password" value={draft.key} disabled={busy} autoComplete="new-password" onChange={e=>setDraft({...draft,key:e.target.value})} placeholder={value.keyConfigured?'已保存，留空保持原值':'输入接口密钥'}/></label>
    {manual?<label>模型 ID<input value={draft.model||''} disabled={busy} onChange={e=>setDraft({...draft,model:e.target.value})} placeholder="填写服务提供的模型标识"/></label>:<label>模型<select aria-label="模型" value={draft.model||''} disabled={busy} onChange={e=>setDraft({...draft,model:e.target.value})}><option value="">{modelStatus==='正在读取可用模型…'?modelStatus:'请选择模型'}</option>{draft.model&&!models.includes(draft.model)&&<option value={draft.model}>{draft.model}（当前选择，未在列表中）</option>}{models.map(id=><option key={id} value={id}>{id}</option>)}</select></label>}
    <div className="model-tools"><span className="model-status" role="status">{modelStatus}</span><div><button type="button" className="text-btn" disabled={busy||!draft.baseUrl||(!draft.key&&!value.keyConfigured)||modelStatus==='正在读取可用模型…'} onClick={()=>setReload(n=>n+1)}>刷新列表</button><button type="button" className="text-btn" disabled={busy} onClick={()=>setManual(!manual)}>{manual?'从列表选择':'手动填写'}</button></div></div>
    {modelError&&<p className="form-error" role="alert">{modelError}</p>}
    <fieldset className="quota-control"><legend>AI 调用额度</legend><div className="segmented" aria-label="调用额度"><button type="button" aria-pressed={!draft.unlimited} disabled={busy} onClick={()=>setDraft({...draft,unlimited:false})}>每日限额</button><button type="button" aria-pressed={!!draft.unlimited} disabled={busy} onClick={()=>setDraft({...draft,unlimited:true,dailyLimit:Number(draft.dailyLimit)||60})}>无上限</button></div>{draft.unlimited?<p className="quota-description">不限每日次数 · 用量继续统计</p>:<label>每日调用上限<input type="number" min={1} step={1} required disabled={busy} value={draft.dailyLimit??60} onChange={e=>setDraft({...draft,dailyLimit:e.target.value===''?'':Number(e.target.value)})}/></label>}</fieldset>
    <label>附件空间（MB）<input type="number" min={100} max={10000} required disabled={busy} value={draft.attachmentLimitMB??1000} onChange={e=>setDraft({...draft,attachmentLimitMB:e.target.value===''?'':Number(e.target.value)})}/></label>
    <label className="vision-switch"><span>图片分析<small>使用支持图片输入的模型</small></span><input type="checkbox" role="switch" aria-label="图片分析" checked={!!draft.vision} disabled={busy} onChange={e=>setDraft({...draft,vision:e.target.checked})}/></label>
    <div className="ai-form-actions"><button className="btn primary" disabled={busy}>{operation==='saving'?'保存中…':'保存接口'}</button><button className="btn secondary" type="button" disabled={busy||!value.keyConfigured} onClick={()=>void test()}>{operation==='testing'?'测试中…':'测试已保存的接口'}</button></div>
    {result&&<p className="form-hint" role="status">{result}</p>}
    {error&&<p className="form-error" role="alert">{error}</p>}
  </form>;
}
