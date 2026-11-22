import type {IncomingMessage,ServerResponse} from "node:http";
import {NotesStore} from "./notes-store.ts";

/** The phone's Notes and the assistant's note tools, over one NotesStore. */
export const NOTE_TOOLS=["hub_notes_find","hub_note_read","hub_note_write"] as const;

async function body(req:IncomingMessage,limit:number){
  const chunks:Buffer[]=[];let size=0;
  for await(const chunk of req){size+=chunk.length;if(size>limit)throw Object.assign(Error("This is too large."),{status:413});chunks.push(chunk as Buffer);}
  return Buffer.concat(chunks);
}

export function installNotes(ctx:any,store=new NotesStore()){
  const send=(res:ServerResponse,code:number,value:unknown)=>{res.writeHead(code,{"content-type":"application/json; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff"});res.end(JSON.stringify(value));};
  const allowed=(req:IncomingMessage,res:ServerResponse)=>{
    const reject=ctx.connection.requestRejection(req);
    if(reject||req.headers["sec-fetch-site"]==="cross-site"||req.headers["x-hub-notes"]!=="1"){send(res,reject??403,{error:"unauthorized"});return false;}
    return true;
  };
  const fail=(res:ServerResponse,error:any)=>send(res,error?.status??400,{error:String(error?.message??error).slice(0,300)});
  const off:(()=>void)[]=[];

  off.push(ctx.webServer.register({kind:"exact",path:"/api/hub/notes",async handler(req:IncomingMessage,res:ServerResponse){
    if(!allowed(req,res))return;
    try{
      const url=new URL(req.url??"/","http://hub.invalid");
      if(req.method==="GET"){
        const id=url.searchParams.get("id"),query=url.searchParams.get("q");
        if(id){send(res,200,{note:await store.read(id)});return;}
        if(query!==null){send(res,200,{notes:(await store.search(query.slice(0,200))).map(({body:_body,...n})=>n)});return;}
        if(url.searchParams.get("view")==="deleted"){send(res,200,{notes:await store.deleted()});return;}
        if(url.searchParams.get("history")){send(res,200,{versions:await store.history(url.searchParams.get("history")!)});return;}
        send(res,200,{notes:await store.list(),folders:await store.folders()});return;
      }
      if(req.method!=="POST"){send(res,405,{error:"method-not-allowed"});return;}
      const input=JSON.parse((await body(req,4_000_000)).toString("utf8")||"{}");
      switch(input.action){
        case "save":send(res,200,await store.save({id:input.id,folder:input.folder,body:String(input.body??""),pinned:input.pinned,baseVersion:input.baseVersion}));return;
        case "pin":send(res,200,{note:await store.setPinned(String(input.id),!!input.pinned)});return;
        case "move":send(res,200,{note:await store.move(String(input.id),String(input.folder??""))});return;
        case "delete":await store.remove(String(input.id));send(res,200,{ok:true});return;
        case "restore":send(res,200,{note:await store.restore(String(input.id))});return;
        case "restore-version":send(res,200,await store.restoreVersion(String(input.id),Number(input.at)));return;
        case "folder-create":send(res,200,{folders:await store.createFolder(String(input.name??""))});return;
        case "folder-rename":send(res,200,{folders:await store.renameFolder(String(input.from??""),String(input.to??""))});return;
        case "folder-delete":send(res,200,{folders:await store.deleteFolder(String(input.name??""))});return;
        default:send(res,400,{error:"unknown-action"});
      }
    }catch(error){fail(res,error);}
  }}));
  off.push(ctx.webServer.register({kind:"exact",path:"/api/hub/notes/attachment",async handler(req:IncomingMessage,res:ServerResponse){
    if(!allowed(req,res))return;
    try{
      if(req.method==="GET"){
        const name=new URL(req.url??"/","http://hub.invalid").searchParams.get("name")??"",data=await store.attachment(name);
        const type=name.endsWith(".png")?"image/png":/\.jpe?g$/.test(name)?"image/jpeg":name.endsWith(".pdf")?"application/pdf":name.endsWith(".heic")?"image/heic":"application/octet-stream";
        res.writeHead(200,{"content-type":type,"cache-control":"private, max-age=31536000, immutable","x-content-type-options":"nosniff"});res.end(data);return;
      }
      if(req.method!=="POST"){send(res,405,{error:"method-not-allowed"});return;}
      const name=await store.putAttachment(await body(req,40_000_000),String(req.headers["x-hub-note-ext"]??""));
      send(res,200,{name,path:`attachments/${name}`});
    }catch(error){fail(res,error);}
  }}));

  // The assistant reads notes freely but changes them only when asked.
  const reg=(spec:any)=>{const remove=ctx.tools?.register?.(spec);if(typeof remove==="function")off.push(remove);};
  reg({name:"hub_notes_find",description:"Find the user's own notes (their Notes app in HUB, separate from Knowledge): by words, or the most recent when query is empty. Returns id, title, folder, last change and a short snippet.",
    parameters:{type:"object",properties:{query:{type:"string",maxLength:200},folder:{type:"string",maxLength:80}},additionalProperties:false},
    output:{schema:{type:"string"},render:(_a:any,v:any)=>[{type:"text",text:String(v)}]},
    async execute(args:any){
      const found=args.query?.trim()?await store.search(args.query):await store.list();
      const notes=found.filter((n:any)=>args.folder===undefined||n.folder===args.folder).slice(0,25)
        .map((n:any)=>({id:n.id,title:n.title,folder:n.folder||"Notes",updated:new Date(n.updatedAt).toISOString(),pinned:n.pinned,snippet:n.snippet,...(n.checklist.total?{checklist:`${n.checklist.done}/${n.checklist.total} done`}:{})}));
      return JSON.stringify({notes,folders:await store.folders()});
    }});
  reg({name:"hub_note_read",description:"Read one of the user's notes in full (Markdown: - [ ] is an open to-do, - [x] a done one).",
    parameters:{type:"object",properties:{id:{type:"string",maxLength:64}},required:["id"],additionalProperties:false},
    output:{schema:{type:"string"},render:(_a:any,v:any)=>[{type:"text",text:String(v)}]},
    async execute(args:any){const n=await store.read(String(args.id));return JSON.stringify({id:n.id,title:n.title,folder:n.folder||"Notes",updated:new Date(n.updatedAt).toISOString(),body:n.body});}});
  reg({name:"hub_note_write",description:"Create or change one of the user's notes, ONLY when the user explicitly asks you to (\"add milk to my shopping note\", \"make a note of this\"). Never on your own initiative and never to tidy or reorganize. mode append adds lines at the end; replace writes the whole note (read it first). The previous version is kept and the user can undo it; afterwards tell the user in one line what you changed.",
    parameters:{type:"object",properties:{id:{type:"string",maxLength:64,description:"Note to change; omit to create a new note."},folder:{type:"string",maxLength:80},mode:{type:"string",enum:["append","replace"]},content:{type:"string",maxLength:200000}},required:["content"],additionalProperties:false},
    output:{schema:{type:"string"},render:(_a:any,v:any)=>[{type:"text",text:String(v)}]},
    async execute(args:any){
      const content=String(args.content);
      if(!args.id){const {note}=await store.save({body:content,folder:args.folder??""});return JSON.stringify({created:note.id,title:note.title,folder:note.folder||"Notes"});}
      const current=await store.read(String(args.id));
      const next=args.mode==="replace"?content:current.body.replace(/\s*$/,"")+"\n"+content;
      const {note}=await store.save({id:current.id,body:next,baseVersion:current.version,...(args.folder!==undefined?{folder:args.folder}:{})});
      return JSON.stringify({changed:note.id,title:note.title,undo:"The previous version is kept in the note's history."});
    }});
  return ()=>off.forEach(f=>f());
}
