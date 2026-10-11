"""Bounded local extraction. Files are data; macros/HTML/embedded scripts never run."""
import sys,zipfile
from pathlib import Path
from defusedxml import ElementTree
path=Path(sys.argv[1]);parts=[]
if path.stat().st_size>25000000:raise ValueError('File exceeds limit')
if path.suffix.lower()=='.pdf':
    from pypdf import PdfReader
    reader=PdfReader(path,strict=False)
    for page in list(reader.pages)[:30]:
        parts.append((page.extract_text() or '')[:12000])
        if sum(map(len,parts))>=18000:break
elif path.suffix.lower() in ('.docx','.xlsx'):
    with zipfile.ZipFile(path) as archive:
        names=['word/document.xml'] if path.suffix.lower()=='.docx' else [n for n in archive.namelist() if n=='xl/sharedStrings.xml' or n.startswith('xl/worksheets/sheet') and n.endswith('.xml')][:10]
        for name in names:
            if archive.getinfo(name).file_size>2000000:continue
            element=ElementTree.fromstring(archive.read(name))
            parts.append(' '.join(e.text for e in element.iter() if e.text and e.tag.split('}')[-1] in ('t','v'))[:12000])
            if sum(map(len,parts))>=18000:break
sys.stdout.reconfigure(encoding='utf-8');print('\n'.join(parts)[:18000])
