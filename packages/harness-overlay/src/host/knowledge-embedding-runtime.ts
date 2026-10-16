export const knowledgeEmbeddingModel="sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2";
/** Local-only model. Cache identity includes model bytes and text/chunker
 * versions; editable Markdown frontmatter never invalidates original text. */
export const knowledgeEmbeddingScript=String.raw`import os, sys, json, sqlite3, hashlib, re
os.environ['HF_HUB_OFFLINE']='1'
os.environ['HF_HUB_DISABLE_TELEMETRY']='1'
from fastembed import TextEmbedding
import numpy as np
root=sys.argv[1]
model_name='sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2'
cache=sys.argv[2] if len(sys.argv)>2 else os.path.join(root,'models')
signature=hashlib.sha256((model_name+':line-chunks-v5:extractor1').encode())
for directory,dirs,files in os.walk(cache):
 dirs.sort()
 for name in sorted(files):
  if not name.endswith(('.onnx','.json','.txt','.model')):continue
  path=os.path.join(directory,name);signature.update(os.path.relpath(path,cache).replace('\\','/').encode())
  with open(path,'rb') as stream:
   for block in iter(lambda:stream.read(1048576),b''):signature.update(block)
fingerprint=signature.hexdigest()
model=TextEmbedding(model_name=model_name,cache_dir=cache,threads=2,local_files_only=True)
db=sqlite3.connect(os.path.join(root,'embeddings.db'))
db.execute('CREATE TABLE IF NOT EXISTS vectors (id TEXT PRIMARY KEY, hash TEXT, data TEXT)')
print(json.dumps({'ready':True,'fingerprint':fingerprint}),flush=True)
def units(text):return len(text.encode('utf-16-le','surrogatepass'))//2
for line in sys.stdin:
 try:
  r=json.loads(line);notes=r['notes'];total=r.get('total',len(notes));vectors=[];layout=r.get('op')=='layout'
  for n in notes:
   old=db.execute('SELECT hash,data FROM vectors WHERE id=?',(n['id'],)).fetchone()
   version=hashlib.sha256((n['title']+'\0'+n['body']).encode('utf8','surrogatepass')).hexdigest()+':'+fingerprint
   if old and old[0]==version:entry=json.loads(old[1])
   elif layout:continue
   else:
    body=n['body'];chunks=[{'id':'title','start':0,'end':0,'kind':'title','text':n['title']}]
    offset=0;last=0
    for line in re.finditer(r'[^\r\n]+',body):
     offset+=units(body[last:line.start()]);text_line=line.group();position=offset
     for i in range(0,len(text_line),384):
      text=text_line[i:i+480];chunks.append({'id':'body-'+str(position),'start':position,'end':position+units(text),'kind':'body','text':text});position+=units(text_line[i:i+384])
     offset+=units(text_line);last=line.end()
    values=[v.tolist() for v in model.embed([c['text'] or ' ' for c in chunks])]
    entry={'chunks':[{k:v for k,v in c.items() if k!='text'} for c in chunks],'vectors':values}
    db.execute('INSERT OR REPLACE INTO vectors VALUES (?,?,?)',(n['id'],version,json.dumps(entry)));db.commit()
   vectors.append((n['id'],entry))
  if layout:
   centers=[]
   for note_id,entry in vectors:
    vector=np.asarray(entry['vectors']).mean(axis=0);centers.append(vector/(np.linalg.norm(vector)+1e-9))
   matrix=np.asarray(centers);pairs=[];truncated=False
   if len(vectors)>1:
    # Bounded blocks, thresholded candidates; there is no top-three rule.
    for begin in range(0,len(vectors),64):
     block=matrix[begin:begin+64]@matrix.T
     for local,row in enumerate(block):
      i=begin+local
      for j in np.flatnonzero(row>=.56):
       if j<=i:continue
       pairs.append({'source':vectors[i][0],'target':vectors[int(j)][0],'score':round(float(row[j]),4)})
       if len(pairs)>=6000:truncated=True;break
      if truncated:break
     if truncated:break
   coverage={'indexed':len(vectors),'total':total,'threshold':.56,'complete':len(vectors)==total and not truncated,'fingerprint':fingerprint}
   if truncated:coverage['limitedBy']='edge-budget'
   elif len(notes)<total:coverage['limitedBy']='record-budget'
   elif len(vectors)<len(notes):coverage['limitedBy']='indexing'
   print(json.dumps({'id':r['id'],'scores':pairs,'coverage':coverage}),flush=True);continue
  query=r['query'];queries=[v for v in model.embed([query[i:i+900] for i in range(0,min(len(query),8000),700)] or [' '])]
  scores=[]
  for note_id,entry in vectors:
   matrix=np.asarray(entry['vectors']);best=-1.;index=0
   for q in queries:
    values=matrix@q/(np.linalg.norm(matrix,axis=1)*np.linalg.norm(q)+1e-9);candidate=int(np.argmax(values))
    if float(values[candidate])>best:best=float(values[candidate]);index=candidate
   scores.append({'id':note_id,'score':best,'chunk':entry['chunks'][index]})
  scores.sort(key=lambda x:(-x['score'],x['id']));print(json.dumps({'id':r['id'],'scores':scores[:r.get('limit',12)]}),flush=True)
 except Exception:
  print(json.dumps({'id':r.get('id'),'error':'embedding-failed'}),flush=True)
`;
