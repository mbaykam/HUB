import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile, rename, lstat, realpath, unlink } from "node:fs/promises";
import { resolve, relative, join, basename } from "node:path";
import type { KnowledgeGraph, KnowledgeNode, KnowledgeNote, KnowledgePlan, KnowledgeSource } from "../knowledge-contract.ts";
import {KnowledgeAssets} from "./knowledge-assets.ts";
import {boundedKnowledgeRecall} from "./knowledge-recall.ts";

export const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export async function atomicJson(path: string, value: unknown) {
  await mkdir(resolve(path, ".."), { recursive: true });
  const temp = path + `.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value), { flag: "wx", mode: 0o600 });
  await rename(temp, path);
}
const wiki = /\[\[([^\]\n]+)\]\]/g;
const safeId = /^[a-zA-Z0-9_-]{3,100}$/;
interface Stored extends KnowledgeNode { raw: string; body: string; front: string; path: string }
interface Journal { id: string; state: "prepared" | "committed" | "undone" | "conflict"; source: KnowledgeSource; changes: { path: string; before: string | null; after: string; id: string;category?:string;beforeCategory?:string }[] }
/** Markdown is canonical. Queue, provenance and undo are operational sidecars,
 * kept outside the vault so Obsidian never displays artificial graph nodes. */
export class KnowledgeStore {
  readonly vault: string; readonly root: string;
  readonly assets:KnowledgeAssets;
  rank?: (query:string,notes:Stored[],limit:number)=>Promise<{id:string;score:number}[]>;
  similarities?:(notes:Stored[])=>Promise<NonNullable<KnowledgeGraph["similarities"]>>;
  private topicCache?:{key:string;value:Promise<NonNullable<KnowledgeGraph["similarities"]>>};
  private tail: Promise<unknown> = Promise.resolve();
  constructor(vault: string, root: string) { this.vault = resolve(vault); this.root = resolve(root);this.assets=new KnowledgeAssets(this.vault,this.root); }
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
  async initialize() {
    await mkdir(this.vault, { recursive: true }); await mkdir(join(this.root, "journal"), { recursive: true });
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
        if (info.size > 512_000) continue;
        const raw = await readFile(full, "utf8");
        const front = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/)?.[0] ?? "";
        const body = raw.slice(front.length);
        const scalar = (key: string) => { const value = front.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1]?.trim(); if (!value) return ""; try { return JSON.parse(value); } catch { return value.replace(/^['"]|['"]$/g, ""); } };
        const id = scalar("hub_id") || scalar("external_uuid") || scalar("uuid") || `legacy-${digest(path).slice(0,32)}`;
        const title = scalar("title") || body.match(/^#\s+(.+)$/m)?.[1] || basename(path, ".md");
        notes.push({ id: String(id), title: String(title), permalink: path.slice(0,-3), hash: digest(raw), modifiedAt: info.mtimeMs, raw, front, body, path });
      }
    };
    await visit("");
    if (new Set(notes.map(n => n.id)).size !== notes.length) throw new Error("Duplicate note identities; review vault before writing");
    return notes;
  }
  resolveLink(target: string, notes: Stored[], from?: Stored): Stored | undefined {
    const value = target.split("|")[0]!.split("#")[0]!.replace(/\.md$/, "").trim();
    if (!value) return;
    const relativePath = from?.permalink.includes("/") ? `${from.permalink.slice(0,from.permalink.lastIndexOf("/"))}/${value}` : value;
    const exact = notes.filter(n => n.permalink === value || n.permalink === relativePath);
    if (exact.length === 1) return exact[0];
    const named = notes.filter(n => n.title === value || basename(n.permalink) === value);
    return named.length === 1 ? named[0] : undefined;
  }
  async graph(): Promise<KnowledgeGraph> {
    const notes = (await this.scan()).filter(n=>n.body.trim()), edges: KnowledgeGraph["edges"] = []; let unresolved = 0;
    for (const note of notes) for (const link of note.body.matchAll(wiki)) {
      const target = this.resolveLink(link[1]!, notes, note);
      if (!target) {if(/\.(png|jpe?g|webp|gif|pdf|docx|xlsx|csv|txt|mp3|wav|mp4)(?:\||$)/i.test(link[1]!))continue;unresolved++; continue; }
      if (target.id !== note.id && !edges.some(e => e.source === note.id && e.target === target.id)) edges.push({ source: note.id, target: target.id, label: "" });
    }
    let similarities:KnowledgeGraph["similarities"];
    if(this.similarities){const key=digest(notes.map(n=>n.id+":"+n.hash).sort().join("\n"));if(this.topicCache?.key!==key)this.topicCache={key,value:this.similarities(notes).catch(()=>[])};similarities=await this.topicCache.value;}
    return { secondBrain: true, nodes: notes.map(({id,title,permalink,hash,modifiedAt}) => ({id,title,permalink,hash,modifiedAt})), edges,...(similarities?{similarities}:{}), page: 1, hasMore: false, partial: false, omittedRelations: unresolved, hiddenNodes: 0 };
  }
  async note(id: string): Promise<KnowledgeNote> {
    const notes = await this.scan(), found = notes.find(n => n.id === id); if (!found) throw new Error("Note missing");
    const graph = await this.graph();
    const sourceMap = await this.metadata();
    return { id, title: found.title, permalink: found.permalink, hash: found.hash, modifiedAt: found.modifiedAt, content: found.body,
      backlinks: graph.nodes.filter(n => graph.edges.some(e => e.source === n.id && e.target === id)),
      links: graph.nodes.filter(n => graph.edges.some(e => e.target === n.id && e.source === id)), sources: sourceMap[id]?.sources ?? [] };
  }
  async search(query: string, limit = 12) {
    const terms = [...new Set(query.toLocaleLowerCase("tr").match(/[\p{L}\p{N}]{2,40}/gu) ?? [])].slice(0,80);
    const notes=(await this.scan()).filter(n=>n.body.trim());let semantic:{id:string;score:number}[]=[];
    if(this.rank)try{semantic=await boundedKnowledgeRecall(this.rank(query,notes,limit),AbortSignal.timeout(850));}catch{/* Lexical search remains available within the conversation deadline. */}
    return notes.map(note => ({ note, score: terms.reduce((s,t) => s + (note.title.toLocaleLowerCase("tr").includes(t) ? 6 : 0) + (note.body.toLocaleLowerCase("tr").includes(t) ? 1 : 0),0) + (semantic.find(s=>s.id===note.id && s.score>=.35)?.score??0)*15 }))
      .filter(n => n.score > 0).sort((a,b) => b.score-a.score).slice(0,limit).map(n => n.note);
  }
  /** Small relevant memory, stable human preferences and one-hop real links. */
  async recall(query:string,topicContext=""){
    const [direct,context,notes,meta]=await Promise.all([this.search(query,4),topicContext.trim()?this.search(topicContext,3):Promise.resolve([]),this.scan(),this.metadata()]);
    const selected:{note:Stored;reason:string}[]=[];
    const add=(note:Stored,reason:string)=>{if(note.body.trim()&&!selected.some(n=>n.note.id===note.id))selected.push({note,reason});};
    for(const n of notes.filter(n=>meta[n.id]?.category==="preferences"&&!meta[n.id]?.deleted).sort((a,b)=>(meta[b.id]?.completedAt??0)-(meta[a.id]?.completedAt??0)).slice(0,2))add(n,"personal-preference");
    for(const n of direct.slice(0,3))add(n,"current-message");
    for(const n of context.slice(0,2))if(selected.length<6)add(n,"conversation-topic");
    let neighbors=0;for(const {note} of [...selected])for(const link of note.body.matchAll(wiki)){
      const related=this.resolveLink(link[1]!,notes,note);if(related&&selected.length<7&&neighbors<2&&!selected.some(n=>n.note.id===related.id)){add(related,"linked-note");neighbors++;}
    }
    return selected.slice(0,7);
  }
  private async metadata(): Promise<Record<string,{ completedAt: number; sources: { id:string; completedAt:number; channel:string }[]; category?:string;deleted?:boolean; title?:string; path?:string; lastHash?:string }>> {
    try { return JSON.parse(await readFile(join(this.root,"notes.json"),"utf8")); } catch (e:any) { if (e.code !== "ENOENT") throw e; return {}; }
  }
  async cutoff() {
    let cutoff=0;const files=await readdir(join(this.vault,"control")).catch((e:any)=>{if(e.code!=="ENOENT")throw e;return [] as string[];});
    for(const name of files)if(/memory[ -]policy\.md$/i.test(name)||name==="Knowledge forget policy.json"){const text=await readFile(join(this.vault,"control",name),"utf8");const value=text.match(/"forgetBefore"\s*:\s*(\d+)/)?.[1];if(!value)throw new Error("Forget policy is invalid");cutoff=Math.max(cutoff,Number(value));}return cutoff;
  }
  exclusive<T>(task: () => Promise<T>): Promise<T> { const next=this.tail.then(task,task); this.tail=next.catch(()=>{}); return next; }
  async noteDates(){return Object.fromEntries(Object.entries(await this.metadata()).map(([id,n])=>[id,n.completedAt]));}
  async refreshInventory(){return this.exclusive(async()=>{
    const notes=await this.scan(),meta=await this.metadata(),present=new Set(notes.map(n=>n.id));let changed=false,deleted=false;
    for(const id of Object.keys(meta))if(!present.has(id)&&!meta[id]?.deleted){meta[id]!.deleted=true;changed=true;deleted=true;}
    if(deleted)await atomicJson(join(this.vault,"control","Knowledge forget policy.json"),{forgetBefore:Date.now()});
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
    for(const c of journal.changes) { const path=await this.file(c.path);const now=await readFile(path,"utf8").catch((e:any)=>{if(e.code!=="ENOENT")throw e;return null;});if(now!==c.before&&now!==c.after)throw new Error("Concurrent note edit during transaction");await mkdir(resolve(path,".."),{recursive:true}); const tmp=path+`.${journal.id}.tmp`;await writeFile(tmp,c.after,{mode:0o600});await rename(tmp,path); }
    const meta=await this.metadata(),source=journal.source;
    for(const c of journal.changes)meta[c.id]={completedAt:Math.max(meta[c.id]?.completedAt??0,source.completedAt),sources:[...(meta[c.id]?.sources??[]).filter(s=>s.id!==source.id),{id:source.id,completedAt:source.completedAt,channel:source.channel}],category:c.category??meta[c.id]?.category,title:basename(c.path,".md"),path:c.path,lastHash:digest(c.after)};
    await atomicJson(join(this.root,"notes.json"),meta);
    journal.state="committed";await atomicJson(join(this.root,"journal",`${journal.id}.json`),journal);
  }
  async edit(id:string,hash:string,content:string) {
    return this.exclusive(async()=>{const n=(await this.scan()).find(n=>n.id===id);if(!n||n.hash!==hash) throw new Error("Note changed; reload before saving");if(typeof content!=="string"||content.length>128_000)throw new Error("Invalid note body");const path=await this.file(n.path),tmp=path+`.${randomUUID()}.tmp`;await writeFile(tmp,n.front+content);await rename(tmp,path);return this.note(id);});
  }
  async undo(id:string) {
    if(!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("Invalid revision");
    return this.exclusive(async()=>{const path=join(this.root,"journal",`${id}.json`),j=JSON.parse(await readFile(path,"utf8")) as Journal;if(j.state!=="committed")throw new Error("Revision cannot be undone");
      for(const c of j.changes) if(await readFile(await this.file(c.path),"utf8")!==c.after)throw new Error("A newer edit must be preserved");
      for(const c of j.changes) {const file=await this.file(c.path);if(c.before===null)await unlink(file);else {const tmp=file+`.${id}.tmp`;await writeFile(tmp,c.before);await rename(tmp,file);}}
      const meta=await this.metadata();for(const c of j.changes){const m=meta[c.id];if(!m)continue;m.sources=m.sources.filter(s=>s.id!==j.source.id);m.completedAt=Math.max(0,...m.sources.map(s=>s.completedAt));m.category=c.beforeCategory;if(c.before===null)m.deleted=true;}await atomicJson(join(this.root,"notes.json"),meta);
      j.state="undone";await atomicJson(path,j);
    });
  }
  async forget(id:string,hash:string,passage:string){
    if(typeof passage!=="string"||!passage.trim())throw new Error("Select a passage to forget");
    return this.exclusive(async()=>{const n=(await this.scan()).find(n=>n.id===id);if(!n||n.hash!==hash)throw new Error("Passage changed; reload before forgetting");
      const span=forgottenPassageSpan(n.body,passage);
      // Retire old evidence before removing a fact, including imported history.
      await atomicJson(join(this.vault,"control","Knowledge forget policy.json"),{forgetBefore:Date.now()});
      const path=await this.file(n.path),tmp=path+`.${randomUUID()}.tmp`;await writeFile(tmp,n.front+n.body.slice(0,span.start)+n.body.slice(span.end));await rename(tmp,path);return this.note(id);
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
