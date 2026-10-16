import {spawn,type ChildProcessWithoutNullStreams} from "node:child_process";
import {mkdir,writeFile} from "node:fs/promises";
import {join} from "node:path";
import {knowledgeEmbeddingModel,knowledgeEmbeddingScript} from "./knowledge-embedding-runtime.ts";
import type {KnowledgeSemanticHit,KnowledgeSimilarityCoverage} from "../knowledge-contract.ts";
type Note={id:string;hash:string;title:string;body:string};
export class KnowledgeEmbeddings {
  private child?:ChildProcessWithoutNullStreams;private ready?:Promise<void>;private sequence=0;
  private pending=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void}>();
  status="starting";fingerprint="unavailable";
  constructor(readonly python:string,readonly root:string,readonly modelCache=join(root,"models")){}
  start(){if(!this.ready)this.ready=this.launch();return this.ready;}
  private async launch(){
    await mkdir(this.root,{recursive:true});const path=join(this.root,"hub_embeddings.py");await writeFile(path,knowledgeEmbeddingScript);
    this.child=spawn(this.python,["-u",path,this.root,this.modelCache],{windowsHide:true,stdio:["pipe","pipe","pipe"],env:{...process.env,PYTHONIOENCODING:"utf-8"}});const child=this.child;let buffer="";
    return new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(()=>{this.status="unavailable";child.kill();reject(Error("Embedding startup timed out"));},60000);
      child.stdout.on("data",chunk=>{buffer+=chunk.toString();if(buffer.length>4_000_000){child.kill();return;}let end;while((end=buffer.indexOf("\n"))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);try{const response=JSON.parse(line);if(response.ready){clearTimeout(timer);this.status=knowledgeEmbeddingModel;this.fingerprint=response.fingerprint;resolve();}else{const pending=this.pending.get(response.id);this.pending.delete(response.id);if(response.error)pending?.reject(Error("Embedding failed"));else pending?.resolve(response.coverage?{edges:response.scores,coverage:response.coverage}:response.scores);}}catch{}}});child.stderr.resume();
      const fail=()=>{clearTimeout(timer);this.status="unavailable";reject(Error("Embedding runtime unavailable"));for(const pending of this.pending.values())pending.reject(Error("Embedding stopped"));this.pending.clear();};child.on("error",fail);child.on("exit",fail);
    });
  }
  private async request<T>(payload:unknown):Promise<T>{
    await this.start();if(this.pending.size>=2)throw Error("Local semantic indexing is busy; lexical search remains available");const id=++this.sequence;
    return new Promise<T>((resolve,reject)=>{const timer=setTimeout(()=>{reject(Error("Embedding deadline; local indexing may still finish"));},15000);this.pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});this.child!.stdin.write(JSON.stringify({id,...payload as object})+"\n");});
  }
  rank(query:string,notes:Note[],limit:number){return this.request<KnowledgeSemanticHit[]>({query,notes,limit});}
  layout(notes:Note[]){return this.request<{edges:{source:string;target:string;score:number}[];coverage:KnowledgeSimilarityCoverage}>({op:"layout",notes:[...notes].sort((a,b)=>a.id.localeCompare(b.id)).slice(0,1500),total:notes.length});}
  dispose(){this.child?.kill();}
}
