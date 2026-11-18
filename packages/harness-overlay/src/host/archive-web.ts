import type {IncomingMessage,ServerResponse} from "node:http";

const sessionId=(v:unknown):v is string=>typeof v==="string"&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(v);

/** Brings an archived conversation back into the lists. The workspace registry
 * keeps an archived session's place, so it returns where it was. The registry has
 * no public unarchive yet; this uses its own serialized write path, and the
 * workspace feed publishes the new archive set to every client. */
export async function unarchiveSession(registry:any,id:string){
  if(!sessionId(id))throw Error("Invalid conversation");
  if(typeof registry?.unarchiveSession==="function"){await registry.unarchiveSession(id);return;}
  if(typeof registry?.enqueueOperation!=="function"||typeof registry?.requireState!=="function"||typeof registry?.setState!=="function")throw Error("This HUB cannot unarchive conversations.");
  await registry.enqueueOperation(async()=>{
    const state=registry.requireState();
    if(!state.archivedSessionIds.includes(id))return;
    await registry.setState({...state,archivedSessionIds:state.archivedSessionIds.filter((value:string)=>value!==id)});
  });
}

export function installArchiveWeb(ctx:any){
  return ctx.webServer.register({kind:"exact",path:"/api/hub/archive",async handler(req:IncomingMessage,res:ServerResponse){
    const send=(code:number,data:unknown)=>{res.writeHead(code,{"content-type":"application/json","cache-control":"no-store","x-content-type-options":"nosniff"});res.end(JSON.stringify(data));};
    const rejected=ctx.connection.requestRejection(req);
    if(rejected||req.headers["sec-fetch-site"]==="cross-site"||req.headers["x-hub-archive"]!=="1"){send(rejected??403,{error:"unauthorized"});return;}
    const registry=ctx.get?.("workspaceRegistry")??ctx.workspaceRegistry;
    try{
      if(req.method==="GET"){send(200,{archivedSessionIds:[...(registry?.archivedSessionIds??[])]});return;}
      if(req.method!=="POST"){send(405,{error:"method-not-allowed"});return;}
      if(!String(req.headers["content-type"]??"").startsWith("application/json")){send(415,{error:"json-required"});return;}
      const chunks:Buffer[]=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>2048){send(413,{error:"too-large"});return;}chunks.push(chunk);}
      const input=JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if(input?.action!=="unarchive"||Object.keys(input).sort().join()!=="action,sessionId")throw Error("Invalid command");
      await unarchiveSession(registry,input.sessionId);
      send(200,{archivedSessionIds:[...(registry?.archivedSessionIds??[])]});
    }catch(error){send(409,{error:"archive-operation-failed",detail:String((error as Error).message).slice(0,200)});}
  }});
}
