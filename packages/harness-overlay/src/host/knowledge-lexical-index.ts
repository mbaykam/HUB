/**
 * Recall-preserving trigram candidate filtering adapted from Graphify 0.9.91:
 * graphify/serve.py, _get_trigram_index / _trigram_candidates, commit
 * 10130e79ed9caf8f60d998073e097531eaa1a395.
 * Copyright 2026 Safi Shamsi and the Graphify contributors. Apache-2.0.
 * See resources/licenses/graphify-NOTICE and graphify-LICENSE.
 *
 * HUB changes: TypeScript; title AND complete body; both EN/TR folds;
 * incremental edit/deletion invalidation; bounded memory with full-scan
 * fallback. Candidates are always re-scored; they are never semantic truth.
 */
import {knowledgeTextForms} from "./knowledge-recall.ts";

interface RecordText {id:string;title:string;body:string}
interface Entry extends RecordText {
  titles?:string[];
  bodies?:string[];
  grams?:Set<string>;
  chars:number;
}
interface IndexLimits {maxChars:number;maxPostings:number;maxRecordChars:number}

function trigrams(text:string){
  const result=new Set<string>();
  for(let i=0;i+2<text.length;i++)result.add(text.slice(i,i+3));
  return result;
}

/** Derived and process-local. No model call, disk write, or canonical identity. */
export class KnowledgeLexicalIndex {
  private readonly entries=new Map<string,Entry>();
  private readonly postings=new Map<string,Set<string>>();
  private readonly fallback=new Set<string>();
  private chars=0;
  private postingCount=0;
  private generation=0;
  private readonly limits:IndexLimits;

  constructor(limits:Partial<IndexLimits>={}){
    this.limits={maxChars:4_000_000,maxPostings:1_000_000,maxRecordChars:128_000,...limits};
  }

  private remove(id:string){
    const entry=this.entries.get(id);
    if(!entry)return;
    for(const gram of entry.grams??[]){
      const bucket=this.postings.get(gram)!;
      if(bucket.delete(id))this.postingCount--;
      if(!bucket.size)this.postings.delete(gram);
    }
    this.chars-=entry.chars;
    this.fallback.delete(id);
    this.entries.delete(id);
  }

  sync(notes:readonly RecordText[]){
    const current=new Map(notes.map(note=>[note.id,note]));
    let changed=false;
    for(const [id,entry] of this.entries){
      const note=current.get(id);
      if(!note||entry.title!==note.title||entry.body!==note.body){this.remove(id);changed=true;}
    }
    for(const note of notes){
      if(this.entries.has(note.id))continue;
      const entry:Entry={id:note.id,title:note.title,body:note.body,chars:0};
      // Huge records remain fully searchable without an unbounded postings set.
      if(note.title.length+note.body.length<=this.limits.maxRecordChars){
        const titles=knowledgeTextForms(note.title),bodies=knowledgeTextForms(note.body);
        const chars=[...titles,...bodies].reduce((sum,text)=>sum+text.length,0);
        if(this.chars+chars<=this.limits.maxChars){
          // Separate fields: a trigram may not straddle a title/body boundary.
          const grams=new Set<string>();
          for(const text of [...titles,...bodies])for(const gram of trigrams(text))grams.add(gram);
          if(this.postingCount+grams.size<=this.limits.maxPostings){
            Object.assign(entry,{titles,bodies,grams,chars});
            this.chars+=chars;
            for(const gram of grams){
              let bucket=this.postings.get(gram);
              if(!bucket)this.postings.set(gram,bucket=new Set());
              bucket.add(note.id);this.postingCount++;
            }
          }
        }
      }
      if(!entry.grams)this.fallback.add(note.id);
      this.entries.set(note.id,entry);changed=true;
    }
    if(changed)this.generation++;
  }

  /** undefined means scan all, NOT no hits. Non-indexed records always survive. */
  candidates(tokens:readonly string[]):Set<string>|undefined{
    const result=new Set(this.fallback);
    for(const token of tokens){
      if(token.length<3)return undefined;
      const buckets=[...trigrams(token)].map(gram=>this.postings.get(gram));
      if(buckets.some(bucket=>!bucket))continue;
      const present=buckets as Set<string>[];
      present.sort((a,b)=>a.size-b.size);
      if(!present.length)continue;
      // A common term makes the index no cheaper than the exact scan.
      if(present[0]!.size>this.entries.size*.10)return undefined;
      for(const id of present[0]!)if(present.every(bucket=>bucket.has(id)))result.add(id);
    }
    return result;
  }

  rank(notes:readonly RecordText[],tokens:readonly string[]){
    this.sync(notes);
    const candidates=this.candidates(tokens);
    return notes.filter(note=>!candidates||candidates.has(note.id)).map(note=>{
      const entry=this.entries.get(note.id)!;
      const titles=entry.titles??knowledgeTextForms(note.title),bodies=entry.bodies??knowledgeTextForms(note.body);
      const count=tokens.reduce((sum,token)=>sum+(titles.some(text=>text.includes(token))?7:0)+(bodies.some(text=>text.includes(token))?1:0),0);
      return {id:note.id,score:count/(1+Math.log1p(note.body.length/2000)*.12)};
    }).filter(note=>note.score>0).sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id));
  }

  get coverage(){return {generation:this.generation,records:this.entries.size,indexed:this.entries.size-this.fallback.size,fallback:this.fallback.size,normalizedChars:this.chars,postings:this.postingCount};}
}
