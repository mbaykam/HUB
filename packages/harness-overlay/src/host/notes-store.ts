import {mkdir,readdir,readFile,writeFile,rename,rm,stat} from "node:fs/promises";
import {createHash,randomUUID} from "node:crypto";
import {join,resolve,relative,sep} from "node:path";
import {homedir} from "node:os";

/** The user's own notes (Apple Notes in HUB): plain Markdown files the user
 * owns, apart from Knowledge, which is HUB's memory. One file per note,
 * folders are directories, deleted notes wait in Recently Deleted for 30
 * days, and every change keeps the previous version. */
export interface NoteSummary {id:string;folder:string;title:string;snippet:string;pinned:boolean;createdAt:number;updatedAt:number;version:string;checklist:{done:number;total:number};attachments:number}
export interface Note extends NoteSummary {body:string}
export interface SaveResult {note:Note;conflict?:Note}

export const NOTES_TRASH=".trash",NOTES_HISTORY=".history",NOTES_ATTACHMENTS="attachments";
const ID=/^[a-z0-9][a-z0-9-]{7,63}$/,ATTACHMENT=/^[a-f0-9]{64}\.(png|jpe?g|heic|gif|webp|pdf|m4a|mp3|wav|drawing)$/;
const FOLDER=/^[^\\/:*?"<>|.\u0000-\u001f][^\\/:*?"<>|\u0000-\u001f]{0,79}$/;
const DAY=86_400_000,KEEP_VERSIONS=50,MAX_BODY=2_000_000;

export const defaultNotesRoot=()=>process.env.HUB_NOTES_DIR??join(homedir(),"Documents","HUB Notes");
const digest=(text:string|Buffer)=>createHash("sha256").update(text).digest("hex");

/** The first line that says something, without Markdown marks. */
export function noteTitle(body:string){
  for(const raw of body.split(/\r?\n/)){
    const line=raw.replace(/^\s*(#{1,6}\s+|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+|>\s*)/,"").replace(/!\[[^\]]*\]\([^)]*\)/g,"").replace(/[*_`~]/g,"").trim();
    if(line)return line.slice(0,120);
  }
  return "New Note";
}
function snippet(body:string){
  const lines=body.split(/\r?\n/).map(l=>l.replace(/^\s*(#{1,6}\s+|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+|>\s*|\|)/,"").replace(/!\[[^\]]*\]\([^)]*\)/g,"").replace(/[*_`~|]/g," ").trim()).filter(Boolean);
  return lines.slice(1).join(" ").replace(/\s+/g," ").slice(0,160);
}
function checklist(body:string){const items=[...body.matchAll(/^\s*[-*+]\s+\[([ xX])\]/gm)];return {done:items.filter(m=>m[1]!==" ").length,total:items.length};}

function serialize(meta:{id:string;created:number;updated:number;pinned:boolean},body:string){
  return `---\nhub_note: ${meta.id}\ncreated: ${new Date(meta.created).toISOString()}\nupdated: ${new Date(meta.updated).toISOString()}\npinned: ${meta.pinned}\n---\n${body}`;
}
function parse(raw:string){
  const front=raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);const head=front?.[1]??"";
  const value=(key:string)=>head.match(new RegExp(`^${key}:\\s*(.+)$`,"m"))?.[1]?.trim();
  const time=(key:string)=>{const v=Date.parse(value(key)??"");return Number.isFinite(v)?v:undefined;};
  return {id:value("hub_note"),created:time("created"),updated:time("updated"),pinned:value("pinned")==="true",body:front?raw.slice(front[0].length):raw};
}

export class NotesStore {
  private queue:Promise<unknown>=Promise.resolve();
  constructor(readonly root=defaultNotesRoot()){this.root=resolve(root);}
  private exclusive<T>(work:()=>Promise<T>):Promise<T>{const next=this.queue.then(work,work);this.queue=next.catch(()=>{});return next;}
  private async write(path:string,data:string|Buffer){await mkdir(join(path,".."),{recursive:true});const tmp=`${path}.${randomUUID()}.tmp`;await writeFile(tmp,data);await rename(tmp,path);}
  private folderPath(folder:string){if(folder&&!FOLDER.test(folder))throw Error("Choose a folder name without slashes or special characters.");return folder?join(this.root,folder):this.root;}

  /** Every note file in the main folder and one level of folders, by id. */
  private async files(){
    const found=new Map<string,{path:string;folder:string}>();
    await mkdir(this.root,{recursive:true});
    const visit=async(dir:string,folder:string)=>{
      for(const entry of await readdir(dir,{withFileTypes:true}).catch(()=>[])){
        if(entry.isFile()&&/\.md$/i.test(entry.name)){const id=entry.name.slice(0,-3);if(ID.test(id)&&!found.has(id))found.set(id,{path:join(dir,entry.name),folder});}
        else if(entry.isDirectory()&&!folder&&!entry.name.startsWith(".")&&entry.name!==NOTES_ATTACHMENTS)await visit(join(dir,entry.name),entry.name);
      }
    };
    await visit(this.root,"");return found;
  }
  private async load(id:string,path:string,folder:string):Promise<Note>{
    const raw=await readFile(path,"utf8"),info=await stat(path),meta=parse(raw);
    return {id,folder,title:noteTitle(meta.body),snippet:snippet(meta.body),pinned:meta.pinned,createdAt:meta.created??info.birthtimeMs,updatedAt:meta.updated??info.mtimeMs,
      version:digest(raw).slice(0,16),checklist:checklist(meta.body),attachments:(meta.body.match(/!\[[^\]]*\]\(attachments\//g)??[]).length,body:meta.body};
  }
  async folders(){
    await mkdir(this.root,{recursive:true});
    return (await readdir(this.root,{withFileTypes:true})).filter(e=>e.isDirectory()&&!e.name.startsWith(".")&&e.name!==NOTES_ATTACHMENTS).map(e=>e.name).sort((a,b)=>a.localeCompare(b,"tr"));
  }
  async list():Promise<NoteSummary[]>{
    const notes:NoteSummary[]=[];
    for(const [id,{path,folder}] of await this.files()){try{const {body:_body,...summary}=await this.load(id,path,folder);notes.push(summary);}catch{}}
    return notes.sort((a,b)=>Number(b.pinned)-Number(a.pinned)||b.updatedAt-a.updatedAt);
  }
  async read(id:string){if(!ID.test(id))throw Error("Unknown note.");const file=(await this.files()).get(id);if(!file)throw Error("This note no longer exists.");return this.load(id,file.path,file.folder);}

  /** Saves a note. When the phone edited an older version than the one here,
   * nothing is overwritten: its text is kept as a second note next to it. */
  save(input:{id?:string;folder?:string;body:string;pinned?:boolean;baseVersion?:string}):Promise<SaveResult>{
    return this.exclusive(async()=>{
      if(typeof input.body!=="string"||input.body.length>MAX_BODY)throw Error("This note is too long to save.");
      const files=await this.files(),now=Date.now();
      const id=input.id&&ID.test(input.id)?input.id:randomUUID();const existing=files.get(id);
      if(existing){
        const current=await this.load(id,existing.path,existing.folder);
        if(input.baseVersion&&input.baseVersion!==current.version&&current.body!==input.body){
          const copyId=randomUUID(),folder=existing.folder;
          await this.write(join(this.folderPath(folder),copyId+".md"),serialize({id:copyId,created:now,updated:now,pinned:false},input.body));
          return {note:current,conflict:await this.read(copyId)};
        }
        const folder=input.folder??existing.folder,target=join(this.folderPath(folder),id+".md");
        if(current.body!==input.body)await this.keepVersion(id,await readFile(existing.path,"utf8"),current.updatedAt);
        await this.write(target,serialize({id,created:current.createdAt,updated:current.body===input.body?current.updatedAt:now,pinned:input.pinned??current.pinned},input.body));
        if(target!==existing.path)await rm(existing.path,{force:true});
        return {note:await this.read(id)};
      }
      const folder=input.folder??"";
      await this.write(join(this.folderPath(folder),id+".md"),serialize({id,created:now,updated:now,pinned:!!input.pinned},input.body));
      return {note:await this.read(id)};
    });
  }
  private async keepVersion(id:string,raw:string,at:number){
    const dir=join(this.root,NOTES_HISTORY,id);await this.write(join(dir,`${Math.floor(at)}.md`),raw);
    const versions=(await readdir(dir)).filter(f=>/^\d+\.md$/.test(f)).sort();
    for(const old of versions.slice(0,Math.max(0,versions.length-KEEP_VERSIONS)))await rm(join(dir,old),{force:true});
  }
  async history(id:string){
    if(!ID.test(id))throw Error("Unknown note.");const dir=join(this.root,NOTES_HISTORY,id);
    const versions=(await readdir(dir).catch(()=>[] as string[])).filter(f=>/^\d+\.md$/.test(f)).sort().reverse();
    return Promise.all(versions.map(async f=>{const body=parse(await readFile(join(dir,f),"utf8")).body;return {at:Number(f.slice(0,-3)),title:noteTitle(body),snippet:snippet(body),body};}));
  }
  /** Puts an earlier version back; the current text becomes a version itself. */
  async restoreVersion(id:string,at:number){
    const version=(await this.history(id)).find(v=>v.at===at);if(!version)throw Error("That version is no longer kept.");
    const current=await this.read(id);return this.save({id,body:version.body,baseVersion:current.version});
  }
  setPinned(id:string,pinned:boolean){return this.exclusive(async()=>{const note=await this.read(id);const file=(await this.files()).get(id)!;
    await this.write(file.path,serialize({id,created:note.createdAt,updated:note.updatedAt,pinned},note.body));return this.read(id);});}
  move(id:string,folder:string){return this.exclusive(async()=>{await this.read(id);const file=(await this.files()).get(id)!;const target=join(this.folderPath(folder),id+".md");
    if(target!==file.path){await this.write(target,await readFile(file.path,"utf8"));await rm(file.path,{force:true});}return this.read(id);});}
  /** Moves a note to Recently Deleted. */
  remove(id:string){return this.exclusive(async()=>{const file=(await this.files()).get(id);if(!file)return;
    const raw=await readFile(file.path,"utf8");await this.write(join(this.root,NOTES_TRASH,id+".md"),raw.replace(/^---\r?\n/,`---\ndeleted_from: ${file.folder}\ndeleted_at: ${new Date().toISOString()}\n`));await rm(file.path,{force:true});});}
  async deleted(){
    const dir=join(this.root,NOTES_TRASH),out:(NoteSummary&{deletedAt:number})[]=[];
    for(const name of await readdir(dir).catch(()=>[] as string[])){const id=name.slice(0,-3);if(!name.endsWith(".md")||!ID.test(id))continue;
      try{const path=join(dir,name),raw=await readFile(path,"utf8"),deletedAt=Date.parse(raw.match(/^deleted_at:\s*(.+)$/m)?.[1]??"")||(await stat(path)).mtimeMs;
        if(Date.now()-deletedAt>30*DAY){await rm(path,{force:true});continue;}
        const {body:_body,...summary}=await this.load(id,path,"");out.push({...summary,deletedAt});}catch{}}
    return out.sort((a,b)=>b.deletedAt-a.deletedAt);
  }
  restore(id:string){return this.exclusive(async()=>{if(!ID.test(id))throw Error("Unknown note.");const path=join(this.root,NOTES_TRASH,id+".md");
    const raw=await readFile(path,"utf8").catch(()=>{throw Error("This note is no longer in Recently Deleted.");});const from=raw.match(/^deleted_from:\s*(.*)$/m)?.[1]?.trim()??"";
    const folder=from&&FOLDER.test(from)?from:"";await this.write(join(this.folderPath(folder),id+".md"),raw.replace(/^deleted_from:.*\r?\n/m,"").replace(/^deleted_at:.*\r?\n/m,""));await rm(path,{force:true});return this.read(id);});}
  createFolder(name:string){return this.exclusive(async()=>{const folder=name.trim();if(!folder)throw Error("Name the folder.");await mkdir(this.folderPath(folder),{recursive:true});return this.folders();});}
  renameFolder(from:string,to:string){return this.exclusive(async()=>{const target=to.trim();if(!target||!from)throw Error("Name the folder.");
    if((await this.folders()).includes(target))throw Error("A folder with that name exists.");await rename(this.folderPath(from),this.folderPath(target));return this.folders();});}
  /** Removes a folder; its notes go back to the main Notes list. */
  deleteFolder(name:string){return this.exclusive(async()=>{const dir=this.folderPath(name);if(!name)return this.folders();
    for(const entry of await readdir(dir).catch(()=>[] as string[]))if(entry.endsWith(".md"))await rename(join(dir,entry),join(this.root,entry));
    await rm(dir,{recursive:true,force:true});return this.folders();});}

  /** Finds notes by words in the title or text; title matches first. */
  async search(query:string,limit=30){
    const words=query.toLocaleLowerCase("tr").split(/\s+/).filter(Boolean);if(!words.length)return [];
    const hits:{note:Note;score:number}[]=[];
    for(const [id,{path,folder}] of await this.files()){try{const note=await this.load(id,path,folder),title=note.title.toLocaleLowerCase("tr"),text=note.body.toLocaleLowerCase("tr");
      if(!words.every(w=>text.includes(w)||title.includes(w)||folder.toLocaleLowerCase("tr").includes(w)))continue;
      hits.push({note,score:words.filter(w=>title.includes(w)).length*10+words.reduce((s,w)=>s+Math.min(5,text.split(w).length-1),0)});}catch{}}
    return hits.sort((a,b)=>b.score-a.score||b.note.updatedAt-a.note.updatedAt).slice(0,limit).map(h=>h.note);
  }

  /** Notes that share words with a message, for automatic recall: words of
   * four letters or more, title matches count triple, at least two hits. */
  async related(text:string,limit=2){
    const words=[...new Set(text.toLocaleLowerCase("tr").match(/[\p{L}\p{N}]{4,}/gu)??[])].slice(0,40);if(!words.length)return [];
    const hits:{note:Note;score:number}[]=[];
    for(const [id,{path,folder}] of await this.files()){try{const note=await this.load(id,path,folder),title=note.title.toLocaleLowerCase("tr"),body=note.body.toLocaleLowerCase("tr");
      const score=words.reduce((s,w)=>s+(title.includes(w)?3:body.includes(w)?1:0),0);if(score>=2)hits.push({note,score});}catch{}}
    return hits.sort((a,b)=>b.score-a.score||b.note.updatedAt-a.note.updatedAt).slice(0,limit).map(h=>h.note);
  }

  async putAttachment(data:Buffer,extension:string){
    const ext=extension.toLowerCase().replace(/^\./,"");if(!/^(png|jpe?g|heic|gif|webp|pdf|m4a|mp3|wav|drawing)$/.test(ext))throw Error("This kind of file cannot be attached to a note.");
    if(!data.length||data.length>40_000_000)throw Error("Attachments can be up to 40 MB.");
    const name=`${digest(data)}.${ext}`,path=join(this.root,NOTES_ATTACHMENTS,name);
    if(!(await stat(path).catch(()=>undefined)))await this.write(path,data);return name;
  }
  async attachment(name:string){if(!ATTACHMENT.test(name))throw Error("Unknown attachment.");const path=join(this.root,NOTES_ATTACHMENTS,name);
    if(relative(join(this.root,NOTES_ATTACHMENTS),path).includes(sep))throw Error("Unknown attachment.");return readFile(path);}
}
