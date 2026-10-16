import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile, rename, lstat, realpath, unlink,open } from "node:fs/promises";
import { resolve, relative, join, basename } from "node:path";
import type { KnowledgeGraph, KnowledgeNode, KnowledgeNote, KnowledgePlan, KnowledgeSource,KnowledgeSemanticHit,KnowledgeSimilarityCoverage } from "../knowledge-contract.ts";
import {KnowledgeAssets} from "./knowledge-assets.ts";
import {boundedKnowledgeRecall} from "./knowledge-recall.ts";
import {fuseKnowledgeRanks,knowledgeExcerptSpans} from "./knowledge-retrieval.ts";
import {KnowledgeLexicalIndex} from "./knowledge-lexical-index.ts";
import {KnowledgeLinkIndex,KnowledgeTopology} from "./knowledge-topology.ts";
import {conversationTextRanges,conversationMarkdown} from "./knowledge-archive.ts";
import type {KnowledgeEvidence} from "../knowledge-relation-contract.ts";
import {KnowledgeArchive} from "./knowledge-archive.ts";
import {KnowledgeOrganization} from "./knowledge-organization.ts";
import {KnowledgeMutationGate} from "./knowledge-mutation-gate.ts";
import {ensureKnowledgeDataset} from "./knowledge-portable.ts";
import {relationRoots,relationScope} from "./knowledge-relations.ts";

export const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export async function atomicJson(path: string, value: unknown) {
  await mkdir(resolve(path, ".."), { recursive: true });
  const temp = path + `.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value), { flag: "wx", mode: 0o600 });
  await rename(temp, path);
}
const wiki = /\[\[([^\]\n]+)\]\]/g;
const safeId = /^[a-zA-Z0-9_-]{3,100}$/;
/** Bounded context does not truncate the stored original. Include late matching
 * passages in long chats rather than repeatedly recalling only the greeting. */
export function memoryExcerpt(body:string,query:string,max=6000,chunk?:KnowledgeSemanticHit["chunk"]){
  if(body.length<=max)return body;
  if(chunk)return knowledgeExcerptSpans(body,query,max,chunk).map(s=>s.text).join("\n");
  const terms=[...new Set(query.toLowerCase().match(/[\p{L}\p{N}]{3,40}/gu)??[])],lower=body.toLowerCase();
  const positions=terms.map(t=>lower.lastIndexOf(t)).filter(n=>n>=0).sort((a,b)=>b-a);
  const starts=[0,...positions.map(p=>Math.max(0,p-800))].filter((p,i,a)=>!a.slice(0,i).some(n=>Math.abs(n-p)<1500)).slice(0,4).sort((a,b)=>a-b),size=Math.floor((max-120)/starts.length);
  return starts.map(p=>body.slice(p,p+size)).join("\n\n[... original conversation continues ...]\n\n");
}
interface Stored extends KnowledgeNode { raw: string; body: string; front: string; path: string;retrieval?:{kind:"lexical"|"semantic"|"domain-navigation";score:number;chunk?:KnowledgeSemanticHit["chunk"]} }
type SemanticLayout={edges:NonNullable<KnowledgeGraph["similarities"]>;coverage:KnowledgeSimilarityCoverage};
interface RetiredEvidence {id:string;recordId:string;at:number;sourceHash:string;quoteHash:string}
interface Journal { id: string; state: "prepared" | "committed" | "undone" | "conflict";forget?:RetiredEvidence; source: KnowledgeSource; changes: { path: string; before: string | null; after: string; id: string;category?:string;beforeCategory?:string }[] }
/** Markdown is canonical. Queue, provenance and undo are operational sidecars,
 * kept outside the vault so Obsidian never displays artificial graph nodes. */
export class KnowledgeStore {
  readonly vault: string; readonly root: string;
  readonly assets:KnowledgeAssets;
  readonly archive:KnowledgeArchive;
  readonly organization:KnowledgeOrganization;
  readonly mutations=new KnowledgeMutationGate();
  rank?: (query:string,notes:Stored[],limit:number)=>Promise<KnowledgeSemanticHit[]>;
  similarities?:(notes:Stored[])=>Promise<NonNullable<KnowledgeGraph["similarities"]>|SemanticLayout>;
  private topicCache?:{key:string;at:number;retryable:boolean;value:Promise<SemanticLayout>};
  private readonly lexicalIndex=new KnowledgeLexicalIndex();
  private tail: Promise<unknown> = Promise.resolve();
  constructor(vault: string, root: string) { this.vault = resolve(vault); this.root = resolve(root);this.assets=new KnowledgeAssets(this.vault,this.root,this.mutations);this.archive=new KnowledgeArchive(this.vault,this.root,this.mutations);this.organization=new KnowledgeOrganization(this); }
  private async file(path: string) {
    if (!path || /[\u0000-\u001f:*?"<>|\\]/.test(path) || !path.endsWith(".md") || path.split("/").some(p => !p || p === "." || p === ".." || p.startsWith("."))) throw new Error("Invalid note path");
    const result = resolve(this.vault, path);
    if (relative(this.vault, result).startsWith("..")) throw new Error("Path outside vault");
    let parent = this.vault;
    for (const part of path.split("/").slice(0, -1)) {
      parent = join(parent, part);
      try { if ((await lstat(parent)).isSymbolicLink()) throw new Error("Linked vault directory"); }
      catch (error: any) { if (error.code !== "ENOENT") throw error; }
    }
    try { if ((await lstat(result)).isSymbolicLink()) throw new Error("Linked note"); } catch (error: any) { if (error.code !== "ENOENT") throw error; }
    return result;
  }
  initialize(){return this.mutations.run(()=>this.initializeStore());}
  private async initializeStore() {
    await mkdir(this.vault, { recursive: true }); await mkdir(join(this.root, "journal"), { recursive: true });
    await ensureKnowledgeDataset(this);
    if (await realpath(this.vault) !== this.vault && process.platform !== "win32") throw new Error("Vault must be a real directory");
    // Recover only an interrupted transaction whose files still equal our
    // before/after snapshots. A human edit always stops recovery.
    for (const file of await readdir(join(this.root, "journal"))) {
      if (!file.endsWith(".json")) continue;
      const journal = JSON.parse(await readFile(join(this.root, "journal", file), "utf8")) as Journal;
      if (journal.state !== "prepared") continue;
      await this.finish(journal);
    }
    // Give legacy readable notes stable identities before an Obsidian rename.
    // Back up exact originals privately; do not add technical prose or links.
    for(const n of await this.scan())if(!/^(hub_id|external_uuid|uuid):/m.test(n.front)){
      await atomicJson(join(this.root,"migration",`${digest(n.path)}.json`),{path:n.path,before:n.raw});
      const raw=n.front?n.front.replace(/^---\r?\n/,`---\nhub_id: ${JSON.stringify(n.id)}\n`):`---\nhub_id: ${JSON.stringify(n.id)}\n---\n`+n.body;
      const path=await this.file(n.path);if(await readFile(path,"utf8")!==n.raw)throw new Error("Legacy note changed during migration");const tmp=path+`.${randomUUID()}.tmp`;await writeFile(tmp,raw);await rename(tmp,path);
    }
    await this.refreshInventory();
    await this.organization.repairPending();
  }
  async scan(): Promise<Stored[]> {
    const notes: Stored[] = [];
    const visit = async (dir: string) => {
      for (const entry of await readdir(join(this.vault, dir), { withFileTypes: true })) {
        if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
        const path = dir ? `${dir}/${entry.name}` : entry.name;
        if (entry.isDirectory()) { if (!/^(sessions|sources|control|Attachments)$/i.test(entry.name)) await visit(path); continue; }
        if (!entry.isFile() || !/\.md$/i.test(entry.name)) continue;
        const full = await this.file(path), info = await lstat(full);
        if(info.size>80_000_000)continue;
        if(info.size>512_000){const handle=await open(full,"r");try{const head=Buffer.alloc(5000),{bytesRead}=await handle.read(head,0,head.length,0);if(!/^hub_kind:\s*conversation\s*$/m.test(head.subarray(0,bytesRead).toString("utf8")))continue;}finally{await handle.close();}}
        const raw = await readFile(full, "utf8");
        const front = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/)?.[0] ?? "";
        const body = raw.slice(front.length);
        const scalar = (key: string) => { const value = front.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1]?.trim(); if (!value) return ""; try { return JSON.parse(value); } catch { return value.replace(/^['"]|['"]$/g, ""); } };
        const id = scalar("hub_id") || scalar("external_uuid") || scalar("uuid") || `legacy-${digest(path).slice(0,32)}`;
        const title = scalar("title") || body.match(/^#\s+(.+)$/m)?.[1] || basename(path, ".md");
        const kind=scalar("hub_kind")==="conversation"?"conversation":"note";
        notes.push({ id: String(id), title: String(title), permalink: path.slice(0,-3), hash: digest(raw), modifiedAt: kind==="conversation"?Number(scalar("source_updated_at"))||info.mtimeMs:info.mtimeMs,kind,protected:kind==="conversation", raw, front, body, path });
      }
    };
    await visit("");
    if (new Set(notes.map(n => n.id)).size !== notes.length) throw new Error("Duplicate note identities; review vault before writing");
    return notes;
  }
  resolveLink(target: string, notes: Stored[], from?: Stored): Stored | undefined {
    return new KnowledgeLinkIndex(notes).resolve(target,from);
  }
  async graph(): Promise<KnowledgeGraph> {
    const notes = (await this.scan()).filter(n=>n.body.trim()), edges: KnowledgeGraph["edges"] = [],documentRelations:NonNullable<KnowledgeGraph["relationships"]>=[],present=new Set(notes.map(n=>n.id)),links=new KnowledgeLinkIndex(notes),edgeKeys=new Set<string>(); let unresolved = 0;
    const addEdge=(edge:KnowledgeGraph["edges"][number])=>{const key=edge.source+"\0"+edge.target;if(edgeKeys.has(key))return false;edgeKeys.add(key);edges.push(edge);return true;};
    for (const note of notes) for (const link of note.body.matchAll(wiki)) {
      const target = links.resolve(link[1]!,note);
      if (!target) {if(/\.(png|jpe?g|webp|gif|pdf|docx|xlsx|csv|txt|mp3|wav|mp4)(?:\||$)/i.test(link[1]!))continue;unresolved++; continue; }
      if (target.id !== note.id && addEdge({ source: note.id, target: target.id, label: "" })) {documentRelations.push({id:"wiki-"+digest(note.id+"\0"+target.id).slice(0,32),sourceId:note.id,targetId:target.id,predicate:"references",direction:"directed",origin:"document",interpretation:false,evidence:[{sourceId:note.id,contentHash:digest(note.body),quote:link[0],start:link.index!,end:link.index!+link[0].length}],createdAt:note.modifiedAt,updatedAt:note.modifiedAt,status:"active",scope:"unclassified"});}
    }
    for(const relation of await this.organization.relations())if(present.has(relation.source)&&present.has(relation.target))addEdge(relation);
    let similarities:KnowledgeGraph["similarities"],similarityCoverage:KnowledgeSimilarityCoverage|undefined;
    if(this.similarities){
      const key=digest(notes.map(n=>n.id+":"+digest(n.title+"\0"+n.body)).sort().join("\n")),pending=()=>({edges:[],coverage:{indexed:0,total:notes.length,threshold:.56,complete:false,limitedBy:"indexing" as const,fingerprint:"pending"}});
      if(this.topicCache?.key!==key||this.topicCache.retryable&&Date.now()-this.topicCache.at>30000){const cache={key,at:Date.now(),retryable:false,value:Promise.resolve(pending()) as Promise<SemanticLayout>};cache.value=this.similarities(notes).then(value=>{const result=Array.isArray(value)?{edges:value,coverage:{...pending().coverage,limitedBy:"unavailable" as const,fingerprint:"legacy-callback"}}:value;cache.retryable=["indexing","unavailable"].includes(result.coverage.limitedBy??"");return result;}).catch(()=>{cache.retryable=true;return {...pending(),coverage:{...pending().coverage,limitedBy:"unavailable" as const}};});this.topicCache=cache;}
      const layout=await boundedKnowledgeRecall(this.topicCache.value,AbortSignal.timeout(250)).catch(pending);similarities=layout.edges;similarityCoverage={...layout.coverage,crossDomainThreshold:.72};
    }
    const registry=await this.organization.domains(),roots=relationRoots(registry),relationships=[...documentRelations,...await this.organization.canonicalRelations()].filter(r=>present.has(r.sourceId)&&present.has(r.targetId)).map(r=>({...r,scope:relationScope(r.sourceId,r.targetId,roots)}));
    if(similarities)similarities=similarities.filter(e=>relationScope(e.source,e.target,roots)!=="long"||e.score>=.72);
    return { secondBrain: true, nodes: notes.map(({id,title,permalink,hash,modifiedAt,kind,protected:readonly}) => ({id,title,permalink,hash,modifiedAt,kind,protected:readonly})), edges,relationships,...(similarities?{similarities,similarityCoverage}:{}),domains:registry.domains,memberships:registry.memberships.filter(m=>present.has(m.nodeId)).map(({nodeId,domainId})=>({nodeId,domainId})),registryRevision:registry.revision,maxActiveDomains:registry.maxActiveDomains,page: 1, hasMore: false, partial: false, omittedRelations: unresolved, hiddenNodes: 0 };
  }
  async neighbors(id:string,cursor="",limit=30){if(!Number.isInteger(limit)||limit<1||limit>100)throw Error("Choose a neighborhood page size between 1 and 100");const graph=await this.graph(),topology=new KnowledgeTopology(graph);if(!topology.nodes.has(id))throw Error("Knowledge record missing");const all=topology.neighbors(id),offset=cursor?all.findIndex(r=>r.id===cursor)+1:0;if(cursor&&offset===0)throw Error("Neighborhood changed; refresh before continuing");const page=all.slice(offset,offset+limit);return {recordId:id,total:all.length,items:page.map(r=>({...r,node:topology.nodes.get(r.sourceId===id?r.targetId:r.sourceId)!})),nextCursor:offset+page.length<all.length?page.at(-1)!.id:null};}
  async connectionPath(sourceId:string,targetId:string){return new KnowledgeTopology(await this.graph()).path(sourceId,targetId);}
  async inspectEvidence(relationId:string,index:number){
    const graph=await this.graph(),relation=graph.relationships?.find(r=>r.id===relationId);if(!relation||!Number.isInteger(index)||index<0||!relation.evidence[index])throw Error("This relationship or its evidence was retired or changed; refresh");const citation=relation.evidence[index]!,note=(await this.scan()).find(n=>n.id===citation.sourceId);let text:string|undefined,version:"current"|"archived"|"captured-episode"|"quoted-only"="quoted-only";
    if(citation.messageId&&note?.kind==="conversation"){
      const original=await this.archive.read(note.id),match=original.messages.find(m=>m.id===citation.messageId&&digest(m.text)===citation.contentHash);if(match){text=match.text;version="current";}
      else{const directory=join(this.root,"archive-history",note.id),files=await readdir(directory).catch((e:any)=>{if(e.code!=="ENOENT")throw e;return [] as string[];});for(const file of files.filter(f=>/^[0-9a-f]{64}\.json$/.test(f)).slice(0,500)){const prior=JSON.parse(await readFile(join(directory,file),"utf8")),old=prior.messages?.find((m:any)=>m.id===citation.messageId&&digest(m.text)===citation.contentHash);if(old){text=old.text;version="archived";break;}}}
    }else if(note&&digest(note.body)===citation.contentHash){text=note.body;version="current";}
    if(!text&&citation.locator?.startsWith("episode:")){const source=(await this.organization.state()).revisions.find(r=>r.source.id===citation.locator!.slice(8))?.source;if(source&&digest(source.content)===citation.contentHash){text=source.content;version="captured-episode";}}
    const start=text?Math.max(0,(citation.start??Math.max(0,text.indexOf(citation.quote)))-250):0,end=text?Math.min(text.length,(citation.end??start+citation.quote.length)+250):0;
    return {citation,sourceTitle:note?.title??"Original source",version,...(text?{excerpt:{text:text.slice(start,end),start,end,totalChars:text.length}}:{})};
  }
  async note(id: string): Promise<KnowledgeNote> {
    const notes = await this.scan(), found = notes.find(n => n.id === id); if (!found) throw new Error("Note missing");
    const graph = await this.graph();
    const sourceMap = await this.metadata();
    const incoming=new Set<string>(),outgoing=new Set<string>();for(const edge of graph.edges){if(edge.target===id)incoming.add(edge.source);if(edge.source===id)outgoing.add(edge.target);}
    return { id, title: found.title, permalink: found.permalink, hash: found.hash, modifiedAt: found.modifiedAt,kind:found.kind,protected:found.protected, content: found.body,
      backlinks: graph.nodes.filter(n => incoming.has(n.id)),
      links: graph.nodes.filter(n => outgoing.has(n.id)), sources: sourceMap[id]?.sources ?? [] };
  }
  async search(query: string, limit = 12) {
    const notes=(await this.scan()).filter(n=>n.body.trim()),registry=await this.organization.domains();let semantic:KnowledgeSemanticHit[]=[];
    if(this.rank)try{semantic=await boundedKnowledgeRecall(this.rank(query,notes,Math.max(24,limit)),AbortSignal.timeout(850));}catch{/* Lexical fallback is bounded independently of a late local index. */}
    return fuseKnowledgeRanks(notes,query,registry,semantic,limit,this.lexicalIndex);
  }
  async citations(note:Stored,query:string,budget=1200,exact?:{start:number;end:number;text:string}[]):Promise<KnowledgeEvidence[]>{
    const spans=exact??knowledgeExcerptSpans(note.body,query,budget,note.retrieval?.chunk);
    if(note.kind==="conversation"){
      const original=await this.archive.read(note.id),projection=conversationMarkdown(original),body=projection.slice(projection.indexOf("\n---\n")+5);
      if(body===note.body){const result:KnowledgeEvidence[]=[];for(const range of conversationTextRanges(original))for(const span of spans){const start=Math.max(range.start,span.start),end=Math.min(range.end,span.end);if(start<end){const at=start-range.start,quote=range.message.text.slice(at,at+end-start);result.push({sourceId:note.id,contentHash:digest(range.message.text),messageId:range.message.id,start:at,end:at+quote.length,quote,role:range.message.role==="status"?"task":range.message.role,occurredAt:range.message.at});}}return result;}
    }
    return spans.map(span=>({sourceId:note.id,contentHash:digest(note.body),quote:span.text,start:span.start,end:span.end,occurredAt:Math.floor(note.modifiedAt),...(note.kind==="conversation"?{locator:"external-markdown:"+note.permalink}:{})}));
  }
  /** Small relevant memory, stable human preferences and one-hop real links. */
  async recall(query:string,topicContext=""){
    const [direct,context,notes,meta]=await Promise.all([this.search(query,4),topicContext.trim()?this.search(topicContext,3):Promise.resolve([]),this.scan(),this.metadata()]);
    const selected:{note:Stored;reason:string}[]=[];
    const add=(note:Stored,reason:string)=>{if(note.body.trim()&&!selected.some(n=>n.note.id===note.id))selected.push({note,reason});};
    for(const n of notes.filter(n=>meta[n.id]?.category==="preferences"&&!meta[n.id]?.deleted).sort((a,b)=>(meta[b.id]?.completedAt??0)-(meta[a.id]?.completedAt??0)).slice(0,2))add(n,"personal-preference");
    for(const n of direct.slice(0,3))add(n,"current-message");
    for(const n of context.slice(0,2))if(selected.length<6)add(n,"conversation-topic");
    const linkIndex=new KnowledgeLinkIndex(notes),byId=new Map(notes.map(n=>[n.id,n]));
    let neighbors=0;for(const {note} of [...selected])for(const link of note.body.matchAll(wiki)){
      const related=linkIndex.resolve(link[1]!,note);if(related&&selected.length<7&&neighbors<2&&!selected.some(n=>n.note.id===related.id)){add(related,"linked-note");neighbors++;}
    }
    const adjacency=new Map<string,Set<string>>();for(const edge of await this.organization.relations())for(const [from,to]of [[edge.source,edge.target],[edge.target,edge.source]]){if(!adjacency.has(from!))adjacency.set(from!,new Set());adjacency.get(from!)!.add(to!);}for(const {note} of [...selected])for(const id of adjacency.get(note.id)??[]){const related=byId.get(id);if(related&&selected.length<7&&neighbors<2&&!selected.some(n=>n.note.id===related.id)){add(related,"linked-note");neighbors++;}}
    return Promise.all(selected.slice(0,7).map(async s=>({...s,reason:s.note.retrieval?.kind==="domain-navigation"?"domain-navigation":s.reason,citations:await this.citations(s.note,query+" "+topicContext),note:{...s.note,body:memoryExcerpt(s.note.body,query+" "+topicContext,1200,s.note.retrieval?.chunk)}})));
  }
  private async metadata(): Promise<Record<string,{ completedAt: number; sources: { id:string; completedAt:number; channel:string }[]; category?:string;deleted?:boolean; title?:string; path?:string; lastHash?:string }>> {
    try { return JSON.parse(await readFile(join(this.root,"notes.json"),"utf8")); } catch (e:any) { if (e.code !== "ENOENT") throw e; return {}; }
  }
  async cutoff() {
    let cutoff=0;const files=await readdir(join(this.vault,"control")).catch((e:any)=>{if(e.code!=="ENOENT")throw e;return [] as string[];});
    for(const name of files)if(/memory[ -]policy\.md$/i.test(name)||name==="Knowledge forget policy.json"){const text=await readFile(join(this.vault,"control",name),"utf8");const value=text.match(/"forgetBefore"\s*:\s*(\d+)/)?.[1];if(!value)throw new Error("Forget policy is invalid");cutoff=Math.max(cutoff,Number(value));}return cutoff;
  }
  private async forgetPolicy():Promise<{forgetBefore:number;retired?:RetiredEvidence[]}>{try{const value=JSON.parse(await readFile(join(this.vault,"control","Knowledge forget policy.json"),"utf8"));if(!Number.isSafeInteger(value.forgetBefore)||value.forgetBefore<0||value.retired!==undefined&&(!Array.isArray(value.retired)||!value.retired.every((r:any)=>typeof r.id==="string"&&typeof r.recordId==="string"&&Number.isSafeInteger(r.at)&&/^[0-9a-f]{64}$/.test(r.sourceHash)&&/^[0-9a-f]{64}$/.test(r.quoteHash))))throw Error("Invalid retired-evidence policy");return value;}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;return {forgetBefore:0};}}
  async retiredEvidence(){return (await this.forgetPolicy()).retired??[];}
  private async saveForgetPolicy(at:number,retired?:RetiredEvidence){const current=await this.forgetPolicy();current.forgetBefore=Math.max(current.forgetBefore,at);if(retired&&!current.retired?.some(r=>r.id===retired.id))current.retired=[...(current.retired??[]),retired];await atomicJson(join(this.vault,"control","Knowledge forget policy.json"),current);}
  exclusive<T>(task: () => Promise<T>): Promise<T> { return this.mutations.run(()=>{const next=this.tail.then(task,task); this.tail=next.catch(()=>{}); return next;}); }
  async noteDates(){return Object.fromEntries(Object.entries(await this.metadata()).map(([id,n])=>[id,n.completedAt]));}
  async refreshInventory(){return this.exclusive(async()=>{
    const notes=await this.scan(),meta=await this.metadata(),present=new Set(notes.map(n=>n.id));let changed=false,deleted=false;
    for(const id of Object.keys(meta))if(!present.has(id)&&!meta[id]?.deleted){meta[id]!.deleted=true;changed=true;deleted=true;}
    if(deleted)await this.saveForgetPolicy(Date.now());
    for(const n of notes){const prior=meta[n.id];if(!prior){meta[n.id]={completedAt:Math.round(n.modifiedAt),sources:[],title:n.title,path:n.path,lastHash:n.hash};changed=true;}
      else if(!prior.lastHash || prior.lastHash!==n.hash){prior.completedAt=Math.max(prior.completedAt,Math.round(n.modifiedAt));prior.lastHash=n.hash;prior.title=n.title;prior.path=n.path;changed=true;}}
    if(changed)await atomicJson(join(this.root,"notes.json"),meta);
  });}
  async apply(plan: KnowledgePlan, source: KnowledgeSource): Promise<string | null> {
    return this.exclusive(async () => {
      validatePlan(plan);
      if (plan.decision !== "update-knowledge") return null;
      if (source.completedAt <= await this.cutoff()) throw new Error("Historical source precedes forget policy");
      for(const file of await readdir(join(this.root,"journal"))){if(!file.endsWith(".json"))continue;const j=JSON.parse(await readFile(join(this.root,"journal",file),"utf8")) as Journal;if(j.source.id===source.id && (j.state==="committed" || j.state==="undone"))return j.state==="committed"?j.id:null;}
      const notes=await this.scan(), meta=await this.metadata();
      const reserved=plan.changes.map(change => {
        const existing=notes.find(n=>n.id===change.id);
        if(existing?.protected)throw new Error("Original conversations are read-only; create an explicitly requested note instead");
        if (meta[change.id]?.deleted) throw new Error("Deleted note cannot be resurrected");
        if (existing && meta[change.id]?.completedAt > source.completedAt) {
          const current=existing.body.trim(),proposed=change.body.trim(),date=new Date(source.completedAt).toISOString().slice(0,10);
          if(!proposed.startsWith(current) || !proposed.slice(current.length).includes(date))throw new Error("Historical evidence may only append dated history, preserving the current note verbatim");
        }
        if (existing && existing.hash !== change.expectedHash || !existing && change.expectedHash !== null) throw new Error("Note changed; reread before retry");
        const filename=change.title.normalize("NFC").replace(/[\u0000-\u001f<>:"/\\|?*#\[\]^]/g," ").trim().replace(/[. ]+$/g,"");
        if (!filename || /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(filename)) throw new Error("Invalid note title");
        const path=existing?.path ?? `Notes/${filename}.md`;
        if (notes.some(n=>n.path.toLowerCase()===path.toLowerCase() && n.id!==change.id)) throw new Error("Existing title: reuse its identity");
        return {change,existing,path,permalink:path.slice(0,-3)};
      });
      if(new Set(reserved.map(n=>n.path.toLowerCase())).size!==reserved.length) throw new Error("Duplicate paths in plan");
      const journal: Journal={id:randomUUID(),state:"prepared",source,changes:[]};
      for(const {change,existing,path} of reserved) {
        let body=change.body.trim();
        for(const item of change.media??[]){
          if(!source.assets?.some(a=>a.id===item.id))throw Error("Attachment must belong to this source");
          const asset=await this.assets.get(item.id);await this.assets.path(asset.path);
          const marker=KnowledgeAssets.markdown(asset,path,item.caption||asset.name);if(!body.includes(marker))body+="\n\n"+marker;
        }
        // Existing links may be retained, but model cannot invent its own wiki
        // syntax. New links are wrapped around useful prose by the host below.
        const prior=new Set(existing ? [...existing.body.matchAll(wiki)].map(m=>m[0]) : []);
        for(const match of body.matchAll(wiki)) if(!prior.has(match[0])) throw new Error("Use validated inline link hints, not model-written wikilinks");
        for(const hint of change.links) {
          if(hint.targetId===change.id) throw new Error("Self link");
          const target=reserved.find(n=>n.change.id===hint.targetId) ?? notes.find(n=>n.id===hint.targetId);
          if(!target || meta[hint.targetId]?.deleted) throw new Error("Link target must be a real, nonempty note");
          if(!("change" in target?target.change.body:target.body).trim())throw new Error("Do not link to a blank placeholder note");
          if(!hint.phrase.trim() || /[\[\]|\r\n]/.test(hint.phrase)) throw new Error("Invalid readable link phrase");
          // Refuse links inside headings, code, or another link. A relation
          // absent from real prose is intentionally left unlinked.
          const lines=body.split("\n"); let wrapped=false, code=false;
          for(let i=0;i<lines.length;i++) {
            const line=lines[i]!; if(/^\s*```/.test(line)) {code=!code;continue;}
            if(code || /^\s*#/.test(line)) continue;
            const ranges=[...line.matchAll(/\[\[[^\]]+\]\]|`[^`]*`/g)].map(m=>[m.index!,m.index!+m[0].length]);
            let position=line.indexOf(hint.phrase);while(position>=0&&ranges.some(([a,b])=>position<b!&&position+hint.phrase.length>a!))position=line.indexOf(hint.phrase,position+hint.phrase.length);if(position<0)continue;
            if(!/[\p{L}\p{N}]/u.test(line.slice(0,position)+line.slice(position+hint.phrase.length)))continue;
            lines[i]=line.slice(0,position)+`[[${target.permalink}|${hint.phrase}]]`+line.slice(position+hint.phrase.length);wrapped=true;break;
          }
          if(!wrapped) throw new Error("Link phrase must already occur naturally in the note body");
          body=lines.join("\n");
        }
        if(/^\s*(?:#{1,6}\s*|[-*]\s*)?(?:part_of|related notes|connections|bağlantılar|ilgili notlar)\s*(?:[:\[]|$)/im.test(body) || /<!--|\[\[\s*(?:\||\]\])/i.test(body)) throw new Error("Artificial link or metadata clutter");
        const front=existing?.front || `---\nhub_id: ${JSON.stringify(change.id)}\ntitle: ${JSON.stringify(change.title)}\ntype: hub_knowledge\n---\n`;
        journal.changes.push({id:change.id,path,before:existing?.raw??null,after:front+body+"\n",category:change.category,beforeCategory:meta[change.id]?.category});
      }
      // Preserve all preexisting human frontmatter and exact before snapshots.
      await atomicJson(join(this.root,"journal",`${journal.id}.json`),journal);
      await this.finish(journal);
      return journal.id;
    });
  }
  private async finish(journal: Journal) {
    // Preflight every file before the first write. Restart recovery recognizes
    // already applied files, never overwrites an unrelated human edit.
    for(const c of journal.changes) { const path=await this.file(c.path); const now=await readFile(path,"utf8").catch((e:any)=>{if(e.code!=="ENOENT") throw e;return null;}); if(now!==c.before && now!==c.after) {journal.state="conflict";await atomicJson(join(this.root,"journal",`${journal.id}.json`),journal);throw new Error("Concurrent note edit; transaction needs review");} }
    if(journal.forget)await this.saveForgetPolicy(journal.forget.at,journal.forget);
    for(const c of journal.changes) { const path=await this.file(c.path);const now=await readFile(path,"utf8").catch((e:any)=>{if(e.code!=="ENOENT")throw e;return null;});if(now!==c.before&&now!==c.after)throw new Error("Concurrent note edit during transaction");await mkdir(resolve(path,".."),{recursive:true}); const tmp=path+`.${journal.id}.tmp`;await writeFile(tmp,c.after,{mode:0o600});await rename(tmp,path); }
    const meta=await this.metadata(),source=journal.source;
    for(const c of journal.changes)meta[c.id]={completedAt:Math.max(meta[c.id]?.completedAt??0,source.completedAt),sources:[...(meta[c.id]?.sources??[]).filter(s=>s.id!==source.id),{id:source.id,completedAt:source.completedAt,channel:source.channel}],category:c.category??meta[c.id]?.category,title:basename(c.path,".md"),path:c.path,lastHash:digest(c.after)};
    await atomicJson(join(this.root,"notes.json"),meta);
    journal.state="committed";await atomicJson(join(this.root,"journal",`${journal.id}.json`),journal);
  }
  async edit(id:string,hash:string,content:string) {
    return this.exclusive(async()=>{const n=(await this.scan()).find(n=>n.id===id);if(!n||n.hash!==hash) throw new Error("Note changed; reload before saving");if(n.protected)throw Error("Original conversations are read-only");if(typeof content!=="string"||content.length>128_000)throw new Error("Invalid note body");const path=await this.file(n.path),tmp=path+`.${randomUUID()}.tmp`;await writeFile(tmp,n.front+content);await rename(tmp,path);return this.note(id);});
  }
  async undo(id:string) {
    if(!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("Invalid revision");
    return this.exclusive(async()=>{const path=join(this.root,"journal",`${id}.json`),j=JSON.parse(await readFile(path,"utf8")) as Journal;if(j.state!=="committed")throw new Error("Revision cannot be undone");if(j.forget)throw Error("Retired evidence is not revived by old revisions; use an explicit new correction");
      for(const c of j.changes) if(await readFile(await this.file(c.path),"utf8")!==c.after)throw new Error("A newer edit must be preserved");
      for(const c of j.changes) {const file=await this.file(c.path);if(c.before===null)await unlink(file);else {const tmp=file+`.${id}.tmp`;await writeFile(tmp,c.before);await rename(tmp,file);}}
      const meta=await this.metadata();for(const c of j.changes){const m=meta[c.id];if(!m)continue;m.sources=m.sources.filter(s=>s.id!==j.source.id);m.completedAt=Math.max(0,...m.sources.map(s=>s.completedAt));m.category=c.beforeCategory;if(c.before===null)m.deleted=true;}await atomicJson(join(this.root,"notes.json"),meta);
      j.state="undone";await atomicJson(path,j);
    });
  }
  async forget(id:string,hash:string,passage:string){
    if(typeof passage!=="string"||!passage.trim())throw new Error("Select a passage to forget");
    return this.exclusive(async()=>{const n=(await this.scan()).find(n=>n.id===id);if(!n||n.hash!==hash)throw new Error("Passage changed; reload before forgetting");if(n.protected)throw Error("Original conversations are read-only");
      const span=forgottenPassageSpan(n.body,passage);
      if((await this.organization.state()).suggestions.some(s=>s.conversationId===id&&s.status==="applied"))throw Error("Undo the reviewed profile change before retiring its source evidence");
      // Durable intent precedes policy/body changes. Startup replays an exact
      // before/after receipt and never overwrites an independent human edit.
      const revision=randomUUID(),at=Date.now(),journal:Journal={id:revision,state:"prepared",source:{id:"forget-"+revision,channel:"pwa",completedAt:at,content:"Explicit user request to retire selected evidence."},forget:{id:revision,recordId:id,at,sourceHash:digest(n.body),quoteHash:digest(passage)},changes:[{id,path:n.path,before:n.raw,after:n.front+n.body.slice(0,span.start)+n.body.slice(span.end)}]};await atomicJson(join(this.root,"journal",revision+".json"),journal);await this.finish(journal);return this.note(id);
    });
  }
}
/** Map the reader's selected wiki aliases back to complete Markdown ranges,
 * so forgetting a linked fact never leaves an empty [[target|]] wrapper. */
export function forgottenPassageSpan(body:string,passage:string){
  let rendered="",position=0;const map:{start:number;end:number}[]=[];
  const plain=(end:number)=>{for(;position<end;position++){rendered+=body[position];map.push({start:position,end:position+1});}};
  for(const m of body.matchAll(wiki)){plain(m.index!);const parts=m[1]!.split("|"),caption=parts[1]||parts[0]!;rendered+=caption;for(let i=0;i<caption.length;i++)map.push({start:m.index!,end:m.index!+m[0].length});position=m.index!+m[0].length;}plain(body.length);
  const start=rendered.indexOf(passage);if(start<0||rendered.indexOf(passage,start+passage.length)>=0)throw new Error("Select one exact, unique passage");
  return {start:map[start]!.start,end:map[start+passage.length-1]!.end};
}
export function validatePlan(value: unknown): asserts value is KnowledgePlan {
  const p=value as KnowledgePlan;
  if(!p || !["skip","archive-only","update-knowledge"].includes(p.decision) || typeof p.reason!=="string" || p.reason.length>600 || !Array.isArray(p.changes) || p.changes.length>8 || (p.decision!=="update-knowledge" && p.changes.length))throw new Error("Invalid knowledge plan");
  const ids=new Set<string>();
  for(const c of p.changes) {
    if(!c || typeof c.id!=="string" || !safeId.test(c.id) || ids.has(c.id) || typeof c.title!=="string" || c.title.trim().length<2 || c.title.length>120 || typeof c.body!=="string" || c.body.trim().length<12 || c.body.length>16000 || (c.expectedHash!==null && !/^[0-9a-f]{64}$/.test(c.expectedHash)) || !Array.isArray(c.links) || c.links.length>12) throw new Error("Invalid note change");
    ids.add(c.id);
    for(const l of c.links)if(!l||typeof l.targetId!=="string"||!safeId.test(l.targetId)||typeof l.phrase!=="string"||l.phrase.length>200)throw new Error("Invalid inline relation");
    if(c.media!==undefined&&(!Array.isArray(c.media)||c.media.length>10||c.media.some(m=>!m||typeof m.id!=="string"||!/^[a-f0-9]{64}$/.test(m.id)||typeof m.caption!=="string"||m.caption.length>200)))throw Error("Invalid note media");
  }
  if(p.decision==="update-knowledge" && !p.changes.length)throw new Error("An update must contain useful notes");
}
