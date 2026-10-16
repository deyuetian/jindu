"""Convert legacy DOC in a private, short-lived, non-interactive office profile."""
import os,pathlib,shutil,signal,subprocess,tempfile,zipfile

class DocReadError(ValueError):
    """A bounded, user-facing error without internal paths or document content."""

def read_docx(path):
    from docx import Document
    from docx.table import Table
    from docx.text.paragraph import Paragraph
    with zipfile.ZipFile(path) as archive:
        if len(archive.infolist())>20000 or sum(v.file_size for v in archive.infolist())>150000000:
            raise DocReadError('文档解压后超过读取上限，原件保留')
    doc=Document(path);parts=[];paragraph=0;table=0
    for element in doc.element.body:
        tag=element.tag.rsplit('}',1)[-1]
        if tag=='p':
            paragraph+=1;text=Paragraph(element,doc).text
            if text.strip():parts.append(f'[段落 {paragraph}] '+text)
        elif tag=='tbl':
            table+=1
            for row_number,row in enumerate(Table(element,doc).rows,1):
                cells=[c.text for c in row.cells]
                if any(c.strip() for c in cells):parts.append(f'[表 {table} 第 {row_number} 行] '+' | '.join(cells))
    return '\n'.join(parts)

def legacy_doc_text(path,timeout=40):
    source=pathlib.Path(path)
    # Legacy OLE files can contain an embedded ZIP theme; that does not make the file DOCX.
    with source.open('rb') as handle:signature=handle.read(4)
    if signature==b'PK\x03\x04' and zipfile.is_zipfile(source):return read_docx(source)
    executable=os.environ.get('JINDU_SOFFICE') or shutil.which('libreoffice') or shutil.which('soffice')
    if not executable:raise DocReadError('服务器尚未配置 DOC 转换组件，原件保留')
    if source.stat().st_size>30000000:raise DocReadError('DOC 超过 30MB 读取上限，原件保留')
    with tempfile.TemporaryDirectory(prefix='jindu-doc-') as temporary:
        root=pathlib.Path(temporary);profile=root/'profile';(profile/'user').mkdir(parents=True)
        # Disable macros and external link updates; each conversion uses its own profile.
        (profile/'user/registrymodifications.xcu').write_text('''<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry">
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop><prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop><prop oor:name="DisableActiveContent" oor:op="fuse"><value>true</value></prop></item>
<item oor:path="/org.openoffice.Office.Writer/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>2</value></prop><prop oor:name="Field" oor:op="fuse"><value>false</value></prop><prop oor:name="Chart" oor:op="fuse"><value>false</value></prop></item>
</oor:items>''',encoding='utf-8')
        local=root/'input.doc';shutil.copyfile(source,local)
        command=[str(executable),'-env:UserInstallation='+profile.as_uri(),'--headless','--nologo','--nodefault','--norestore','--convert-to','docx','--outdir',str(root),str(local)]
        process=subprocess.Popen(command,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=os.name!='nt',creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0) if os.name=='nt' else 0)
        try:
            process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            raise DocReadError('DOC 转换超时，原件保留')
        finally:
            if process.poll() is None:
                if os.name!='nt':os.killpg(process.pid,signal.SIGKILL)
                else:process.kill()
                process.wait()
        converted=root/'input.docx'
        if process.returncode!=0 or not converted.is_file():raise DocReadError('DOC 无法转换，可能损坏或受密码保护；原件保留')
        return read_docx(converted)
