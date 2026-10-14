import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
const model="sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2";
const script=String.raw`import os, sys, json, sqlite3
os.environ['HF_HUB_OFFLINE']='1'
os.environ['HF_HUB_DISABLE_TELEMETRY']='1'
from fastembed import TextEmbedding
import numpy as np
root=sys.argv[1]
model=TextEmbedding(model_name='sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2',cache_dir=os.path.join(root,'models'),threads=2,local_files_only=True)
db=sqlite3.connect(os.path.join(root,'embeddings.db'))
db.execute('CREATE TABLE IF NOT EXISTS vectors (id TEXT PRIMARY KEY, hash TEXT, data TEXT)')
print(json.dumps({'ready':True}),flush=True)
for line in sys.stdin:
 try:
  r=json.loads(line); notes=r['notes']; valid={n['id'] for n in notes}; vectors=[]
  for n in notes:
   old=db.execute('SELECT hash,data FROM vectors WHERE id=?',(n['id'],)).fetchone()
   version=n['hash']+':full-chunks-v2'
   if old and old[0]==version: vs=json.loads(old[1])
   else:
    text=n['title']+'\n'+n['body']; chunks=[text[i:i+900] for i in range(0,len(text),700)]
    vs=[v.tolist() for v in model.embed(chunks)]
    db.execute('INSERT OR REPLACE INTO vectors VALUES (?,?,?)',(n['id'],version,json.dumps(vs)))
   vectors.append((n['id'],vs))
  db.commit()
  if r.get('op')=='layout':
   centers=[]
   for note_id,vs in vectors:
    vector=np.asarray(vs).mean(axis=0);centers.append(vector/(np.linalg.norm(vector)+1e-9))
   matrix=np.asarray(centers);pairs=[];seen=set()
   if len(vectors)>1:
    similarity=matrix@matrix.T
    for i,(note_id,_) in enumerate(vectors):
     for j in np.argsort(-similarity[i])[:4]:
      if i==j or float(similarity[i,j])<.56:continue
      key=tuple(sorted((i,int(j))))
      if key in seen:continue
      seen.add(key);pairs.append({'source':note_id,'target':vectors[j][0],'score':round(float(similarity[i,j]),4)})
   print(json.dumps({'id':r['id'],'scores':pairs}),flush=True);continue
  queries=[v for v in model.embed([r['query'][i:i+900] for i in range(0,min(len(r['query']),8000),700)] or [''])]
  scores=[]
  for id,vs in vectors:
   matrix=np.asarray(vs); score=max(float(np.max(matrix @ q/(np.linalg.norm(matrix,axis=1)*np.linalg.norm(q)+1e-9))) for q in queries)
   scores.append({'id':id,'score':score})
  scores.sort(key=lambda x:-x['score']);print(json.dumps({'id':r['id'],'scores':scores[:r.get('limit',12)]}),flush=True)
 except Exception:
  print(json.dumps({'id':r.get('id'),'error':'embedding-failed'}),flush=True)
`;
export class KnowledgeEmbeddings {
  private child?:ChildProcessWithoutNullStreams;private ready?:Promise<void>;private sequence=0;private pending=new Map<number,{resolve:(value:any[])=>void;reject:(error:Error)=>void}>();
  status="starting";
  readonly python:string; readonly root:string;
  constructor(python:string,root:string){this.python=python;this.root=root;}
  start(){if(this.ready)return this.ready;this.ready=this.launch();return this.ready;}
  private async launch(){
    await mkdir(this.root,{recursive:true});const path=join(this.root,"hub_embeddings.py");await writeFile(path,script);
    this.child=spawn(this.python,["-u",path,this.root],{windowsHide:true,stdio:["pipe","pipe","pipe"],env:{...process.env,PYTHONIOENCODING:"utf-8"}});
    const child=this.child;let buffer="";
    return new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(()=>{this.status="unavailable";child.kill();reject(new Error("Embedding startup timed out"));},60000);
      child.stdout.on("data",chunk=>{buffer+=chunk.toString();if(buffer.length>4_000_000){child.kill();return;}let end;while((end=buffer.indexOf("\n"))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);try{const response=JSON.parse(line);if(response.ready){clearTimeout(timer);this.status=model;resolve();}else{const p=this.pending.get(response.id);this.pending.delete(response.id);if(response.error)p?.reject(new Error("Embedding failed"));else p?.resolve(response.scores);}}catch{}}});
      child.stderr.resume();
      const fail=()=>{clearTimeout(timer);this.status="unavailable";reject(new Error("Embedding runtime unavailable"));for(const p of this.pending.values())p.reject(new Error("Embedding stopped"));this.pending.clear();};child.on("error",fail);child.on("exit",fail);
    });
  }
  async rank(query:string,notes:{id:string;hash:string;title:string;body:string}[],limit:number){
    await this.start();const id=++this.sequence;
    return new Promise<{id:string;score:number}[]>((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error("Embedding deadline"));},15000);this.pending.set(id,{resolve:v=>{clearTimeout(timer);resolve(v);},reject:e=>{clearTimeout(timer);reject(e);}});this.child!.stdin.write(JSON.stringify({id,query,notes,limit})+"\n");});
  }
  async layout(notes:{id:string;hash:string;title:string;body:string}[]){
    await this.start();const id=++this.sequence;
    return new Promise<{source:string;target:string;score:number}[]>((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error("Topic layout deadline"));},15000);this.pending.set(id,{resolve:v=>{clearTimeout(timer);resolve(v);},reject:e=>{clearTimeout(timer);reject(e);}});this.child!.stdin.write(JSON.stringify({id,op:"layout",notes:notes.slice(0,300)})+"\n");});
  }
  dispose(){this.child?.kill();}
}
