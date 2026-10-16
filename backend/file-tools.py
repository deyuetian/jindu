"""Bounded file parsing and portable backups. Never executes document content."""
import sys, json, zipfile, pathlib, hashlib, shutil, os, tempfile, time, signal, struct, zlib
from legacy_doc import DocReadError
from html.parser import HTMLParser

MAX_TEXT = 1500000

class HTMLText(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts, self.links, self.skip, self.anchor = [], [], 0, None
    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag in ('script', 'style', 'noscript'): self.skip += 1
        if tag in ('p','div','br','tr','li','h1','h2','h3'): self.parts.append('\n')
        if tag in ('td','th'): self.parts.append(' | ')
        if tag == 'a' and a.get('href'):
            self.anchor = {'url':a['href'], 'label':''}; self.links.append(self.anchor)
        if tag == 'img' and a.get('src'): self.links.append({'url':a['src'], 'label':a.get('alt','图片附件'), 'image':True})
    def handle_endtag(self, tag):
        if tag in ('script','style','noscript'): self.skip = max(0,self.skip-1)
        if tag == 'a': self.anchor = None
    def handle_data(self, data):
        if not self.skip:
            self.parts.append(data)
            if self.anchor is not None: self.anchor['label'] += data

def member_name(info, legacy_encoding=None):
    if info.flag_bits & 0x800:return info.filename
    try:raw=info.filename.encode('cp437')
    except UnicodeEncodeError:return info.filename
    # Honour the standard Unicode path field only when it describes these exact bytes.
    extra=info.extra;offset=0
    while offset+4<=len(extra):
        tag,size=struct.unpack_from('<HH',extra,offset);offset+=4
        field=extra[offset:offset+size];offset+=size
        if tag==0x7075 and len(field)>=5 and field[0]==1 and int.from_bytes(field[1:5],'little')==zlib.crc32(raw):
            try:return field[5:].decode('utf-8')
            except UnicodeDecodeError:pass
    try:utf8=raw.decode('utf-8')
    except UnicodeDecodeError:utf8=None
    if utf8 and (not legacy_encoding or any('\u3400'<=c<='\u9fff' for c in utf8)):return utf8
    try:
        decoded=raw.decode('gb18030')
        if any('\u3400'<=c<='\u9fff' for c in decoded) and decoded.encode('gb18030')==raw:return decoded
    except UnicodeError:pass
    return utf8 or info.filename

def archive_name_encoding(members):
    # Some GBK names also happen to be valid UTF-8. Use unambiguous sibling names as evidence.
    for info in members:
        if info.flag_bits & 0x800:continue
        try:raw=info.filename.encode('cp437')
        except UnicodeError:continue
        try:raw.decode('utf-8');continue
        except UnicodeDecodeError:pass
        try:
            decoded=raw.decode('gb18030')
            if any('\u3400'<=c<='\u9fff' for c in decoded):return 'gb18030'
        except UnicodeError:pass
    return None

def parse(path, name, deadline=None):
    if deadline is None:deadline=time.monotonic()+50
    if time.monotonic()>=deadline:raise DocReadError('附件读取超时，原件保留，未读取部分待核对')
    p = pathlib.Path(path); ext = pathlib.Path(name).suffix.lower()
    result = {'text':'', 'links':[], 'error':''}
    if ext in ('.xlsx','.xlsm','.docx'):
        with zipfile.ZipFile(p) as z:
            if len(z.infolist())>20000 or sum(i.file_size for i in z.infolist())>150000000: raise ValueError('Expanded document exceeds parsing limit')
    if ext in ('.html','.htm','.txt',''):
        raw = p.read_bytes()
        try: text = raw.decode('utf-8')
        except UnicodeDecodeError: text = raw.decode('gb18030',errors='replace')
        parser = HTMLText(); parser.feed(text)
        result.update(text=''.join(parser.parts), links=parser.links[:300])
    elif ext == '.pdf':
        from pypdf import PdfReader
        doc = PdfReader(str(p))
        if len(doc.pages)>150: result['error']='PDF 超过 150 页，已保留原件，请核对未读取部分'
        pages=[page.extract_text() or '' for page in doc.pages[:150]]
        result['text']='\n\n'.join(f'[第 {i+1} 页]\n'+(text or '[本页未提取到文字，可能为扫描页]') for i,text in enumerate(pages))
        if any(not text.strip() for text in pages): result['error']='含无法提取文字的扫描页，请查看原件；未将扫描页当作已分析'
    elif ext in ('.xlsx','.xlsm','.xls'):
        from job_workbooks import read_workbook
        return read_workbook(p,ext,name)
    elif ext in ('.doc','.docx'):
        from legacy_doc import legacy_doc_text,read_docx
        result['text']=legacy_doc_text(p,timeout=min(40,max(1,deadline-time.monotonic()-3))) if ext=='.doc' else read_docx(p)
        if not result['text'].strip():result['error']='文档未读取到文字，需核对原件'
    elif ext == '.zip':
        texts=[];tables=[];errors=[];extra=[];documents=[];ignored=[]
        with zipfile.ZipFile(p) as archive:
            members=[i for i in archive.infolist() if not i.is_dir()]
            if len(members)>100 or sum(i.file_size for i in members)>100000000:raise ValueError('Archive expansion limit')
            name_encoding=archive_name_encoding(members)
            with tempfile.TemporaryDirectory(prefix='jindu-attachments-') as tmp:
                for index,info in enumerate(members):
                    filename=member_name(info,name_encoding)
                    if pathlib.PurePosixPath(filename).name.startswith('~$'):
                        ignored.append(filename);continue
                    suffix=pathlib.PurePosixPath(filename).suffix.lower()
                    if suffix not in ('.xlsx','.xls','.xlsm','.pdf','.doc','.docx','.txt'):
                        errors.append(filename+'：此压缩附件格式未读取');continue
                    # No member path is used as a filesystem path.
                    target=pathlib.Path(tmp)/str(index);target.write_bytes(archive.read(info))
                    try:child=parse(target,filename,deadline)
                    except Exception:
                        errors.append(filename+'：压缩包内附件无法解析');continue
                    for table in child.get('tables',[]):
                        old_sheet=table['sheet'];table['sheet']=filename+' / '+old_sheet
                        for row in table['rows']:row['text']=row['text'].replace('['+old_sheet+' 第 ','['+table['sheet']+' 第 ',1)
                        tables.append(table)
                    # Use the same annotated row text in both source evidence and table records.
                    child_text=child['text']
                    for table in child.get('tables',[]):child_text=child_text.replace('['+table['sheet'].split(' / ')[-1]+' 第 ','['+table['sheet']+' 第 ')
                    texts.append('[压缩附件 '+filename+']\n'+child_text)
                    if not child.get('tables'):
                        extra.append('[压缩附件 '+filename+']\n'+child_text)
                        documents.append({'name':filename,'text':child_text,'error':child.get('error','')})
                    if child.get('error'):errors.append(filename+'：'+child['error'])
        result.update(text='\n\n'.join(texts),extraText='\n\n'.join(extra),tables=tables,documents=documents,ignored=ignored,error='；'.join(errors),complete=not errors,parserVersion=3)
        if len(json.dumps(result,ensure_ascii=False))>4800000:result.update(tables=[],documents=[],extraText='',text=result['text'][:MAX_TEXT],complete=False,error='压缩附件超过读取上限，筛选未完成')
    elif ext in ('.png','.jpg','.jpeg','.webp','.gif'): pass
    else: result['error']='此文件格式暂不能自动读取，原件已保存，请手动核对'
    if len(result['text'])>MAX_TEXT:
        result['text']=result['text'][:MAX_TEXT];result['error']='文字超过读取上限，保留原件并标记未读部分'
    return result

def backup(data_dir, manifest_path, output):
    root=pathlib.Path(data_dir); meta=json.loads(pathlib.Path(manifest_path).read_text(encoding='utf-8'))
    tmp=pathlib.Path(output+'.partial')
    with zipfile.ZipFile(tmp,'w',zipfile.ZIP_DEFLATED,compresslevel=3) as z:
        z.writestr('manifest.json',json.dumps(meta,ensure_ascii=False))
        for f in meta['files']:
            if not f['id'].isalnum(): raise ValueError('Invalid file identifier')
            path=root/'files'/f['id']
            if hashlib.sha256(path.read_bytes()).hexdigest()!=f['sha256']:raise ValueError('File checksum mismatch')
            z.write(path,'files/'+f['id'])
    with zipfile.ZipFile(tmp) as z:
        if z.testzip():raise ValueError('Backup verification failed')
    os.replace(tmp,output)
    return {'ok':True,'size':pathlib.Path(output).stat().st_size}

def restore_extract(archive, target, limit):
    root=pathlib.Path(target);root.mkdir(parents=True,exist_ok=True)
    with zipfile.ZipFile(archive) as z:
        infos=z.infolist()
        if len(infos)>30000 or sum(i.file_size for i in infos)>limit:raise ValueError('Backup too large')
        if len({i.filename for i in infos})!=len(infos):raise ValueError('Duplicate archive entries')
        if z.getinfo('manifest.json').file_size>100000000:raise ValueError('Manifest too large')
        meta=json.loads(z.read('manifest.json'))
        if meta.get('format')!='jindu-server-backup' or meta.get('version')!=1:raise ValueError('Unrecognized backup')
        expected={'manifest.json'}
        for f in meta['files']:
            if not f['id'].isalnum():raise ValueError('Invalid file identifier')
            member='files/'+f['id'];expected.add(member)
            raw=z.read(member)
            if len(raw)!=f['size'] or hashlib.sha256(raw).hexdigest()!=f['sha256']:raise ValueError('File checksum mismatch')
            (root/'files').mkdir(exist_ok=True)
            (root/member).write_bytes(raw)
        if set(z.namelist())!=expected:raise ValueError('Unexpected archive members')
        (root/'manifest.json').write_text(json.dumps(meta,ensure_ascii=False),encoding='utf-8')
    return {'ok':True}

if __name__=='__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    if os.name!='nt':
        def interrupted(signum,frame):raise SystemExit(143)
        signal.signal(signal.SIGTERM,interrupted)
    try:
        mode=sys.argv[1]
        if mode=='parse':result=parse(sys.argv[2],sys.argv[3])
        elif mode=='export-jobs':
            from job_workbooks import export_jobs
            result=export_jobs(json.loads(sys.stdin.read(5000000)))
        elif mode=='backup':result=backup(*sys.argv[2:5])
        elif mode=='restore':result=restore_extract(sys.argv[2],sys.argv[3],int(sys.argv[4]))
        else:raise ValueError('Unknown operation')
        print(json.dumps(result,ensure_ascii=False))
    except DocReadError as e:
        print(json.dumps({'error':str(e)},ensure_ascii=False));sys.exit(1)
    except Exception as e:
        print(json.dumps({'error':'文件处理失败：'+type(e).__name__},ensure_ascii=False));sys.exit(1)
