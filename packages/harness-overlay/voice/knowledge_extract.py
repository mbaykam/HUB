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
            if path.suffix.lower()=='.docx':
                parts.extend(''.join(e.text or '' for e in p.iter() if e.tag.split('}')[-1]=='t') for p in element.iter() if p.tag.split('}')[-1]=='p')
            elif name=='xl/sharedStrings.xml':
                shared=[''.join(e.text or '' for e in item.iter() if e.tag.split('}')[-1]=='t') for item in element if item.tag.split('}')[-1]=='si']
            else:
                parts.append(name)
                for row in (e for e in element.iter() if e.tag.split('}')[-1]=='row'):
                    cells=[]
                    for cell in row:
                        if cell.tag.split('}')[-1]!='c':continue
                        value=next((e.text or '' for e in cell if e.tag.split('}')[-1]=='v'),'')
                        if cell.attrib.get('t')=='s':
                            try:value=shared[int(value)]
                            except (ValueError,IndexError,NameError):value='[unresolved shared string]'
                        elif cell.attrib.get('t')=='inlineStr':value=''.join(e.text or '' for e in cell.iter() if e.tag.split('}')[-1]=='t')
                        # Cached values only. Never execute spreadsheet formulas.
                        cells.append(cell.attrib.get('r','')+': '+value)
                    parts.append(' | '.join(cells))
            if sum(map(len,parts))>=18000:break
sys.stdout.reconfigure(encoding='utf-8');print('\n'.join(parts)[:18000])
