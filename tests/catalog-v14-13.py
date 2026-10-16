"""Synthetic archive/catalogue fixtures; no AI or network, no installed software changes."""
import importlib.util,io,json,struct,sys,tempfile,zipfile,zlib
from pathlib import Path
from unittest.mock import patch
from openpyxl import Workbook

root=Path(__file__).resolve().parents[1];sys.path.insert(0,str(root/'backend'))
import job_workbooks,legacy_doc
spec=importlib.util.spec_from_file_location('file_tools',root/'backend/file-tools.py');files=importlib.util.module_from_spec(spec);spec.loader.exec_module(files)
checks=[]
def check(name,condition):
    assert condition,name
    checks.append(name)
def book_bytes(rows):
    book=Workbook();s=book.active
    for row in rows:s.append(row)
    target=io.BytesIO();book.save(target);return target.getvalue()
class ChineseZipInfo(zipfile.ZipInfo):
    def _encodeFilenameFlags(self):return self.filename.encode('gb18030'),self.flag_bits&~0x800
out=root/'.check/catalog-v14-13/python';out.mkdir(parents=True,exist_ok=True)
with tempfile.TemporaryDirectory(dir=out) as tmp:
    p=Path(tmp)
    reference=book_bytes([['学位授予单位自主设置二级学科名单'],['单位名称','一级学科名称','二级学科名称'],['某大学','农业资源与环境','土壤学']])
    positions=book_bytes([['招聘单位','招聘岗位名称','专业要求'],['农业所','科研','土壤学']])
    archive=p/'input.zip'
    with zipfile.ZipFile(archive,'w') as z:
        z.writestr(ChineseZipInfo('专业目录/二级学科名单.xlsx'),reference)
        z.writestr(ChineseZipInfo('专业目录/真实岗位.xlsx'),positions)
        z.writestr(ChineseZipInfo('专业目录/研究生目录.txt'),'09 农学\n0903 农业资源与环境\n090301 土壤学'.encode('utf-8'))
        z.writestr(ChineseZipInfo('报名须知.txt'),'须提交报名表'.encode('utf-8'))
        z.writestr(ChineseZipInfo('../越界.txt'),'不能写入上级目录'.encode('utf-8'))
        z.writestr(ChineseZipInfo('~$专业目录.docx'),b'office lock')
    r=files.parse(archive,'专业目录及招聘材料.zip')
    check('gb18030 names decoded',r['tables'][0]['sheet'].startswith('专业目录/二级学科名单.xlsx'))
    check('university discipline rows are references',r['tables'][0]['kind']=='reference' and not r['tables'][0]['rows'])
    check('real positions in mixed archive retained',len(r['tables'][1]['rows'])==1 and r['tables'][1]['rows'][0]['fields'][1]['value']=='科研')
    check('member document boundaries retained',len(r['documents'])==3 and r['documents'][1]['name']=='报名须知.txt')
    check('office lock does not become parse failure',r['ignored']==['~$专业目录.docx'] and not r['error'])
    check('untrusted archive paths never extracted',not (p.parent/'越界.txt').exists() and not (p/'越界.txt').exists())
    i=zipfile.ZipInfo('utf8目录.txt');i.flag_bits|=0x800
    check('utf8 names unchanged',files.member_name(i)==i.filename)
    i=zipfile.ZipInfo('old.txt');raw=i.filename.encode('cp437');name='目录.txt'
    data=b'\x01'+struct.pack('<I',zlib.crc32(raw))+name.encode('utf-8');i.extra=struct.pack('<HH',0x7075,len(data))+data
    check('valid Unicode path field respected',files.member_name(i)==name)
    i.extra=struct.pack('<HH',0x7075,len(data))+b'\x01\x00\x00\x00\x00'+name.encode('utf-8')
    check('bad Unicode field CRC ignored',files.member_name(i)=='old.txt')
    i=zipfile.ZipInfo('ordinary-é.txt');check('western file name retained',files.member_name(i)==i.filename)
    # A real failure must still be visible; ignoring an Office lock cannot suppress other errors.
    with zipfile.ZipFile(p/'bad.zip','w') as z:z.writestr('专业目录.docx',b'corrupt document')
    check('corrupt original remains an error','专业目录.docx' in files.parse(p/'bad.zip','bad.zip')['error'])
    # Embedded ZIP themes are legal in OLE .doc; they are not a DOCX container.
    target=p/'embedded.doc';target.write_bytes(b'\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1'+bytes(512))
    with zipfile.ZipFile(target,'a') as z:z.writestr('[Content_Types].xml','theme');z.writestr('theme/theme1.xml','theme')
    check('OLE fixture also detected by generic ZIP probe',zipfile.is_zipfile(target))
    with patch.object(legacy_doc.shutil,'which',return_value=None),patch.dict(legacy_doc.os.environ,{},clear=True),patch.object(legacy_doc,'read_docx',side_effect=AssertionError('OLE must be converted')):
        try:legacy_doc.legacy_doc_text(target)
        except legacy_doc.DocReadError:pass
        else:raise AssertionError('expected missing converter')
    checks.append('OLE with embedded ZIP goes to DOC converter')
    docx=p/'renamed.doc'
    with zipfile.ZipFile(docx,'w') as z:z.writestr('word/document.xml','synthetic')
    with patch.object(legacy_doc,'read_docx',return_value='docx text'):
        check('genuine DOCX renamed DOC still supported',legacy_doc.legacy_doc_text(docx)=='docx text')
print(json.dumps({'passed':True,'checks':checks,'externalAICalls':0},ensure_ascii=False))
