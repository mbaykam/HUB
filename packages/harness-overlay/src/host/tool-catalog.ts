import type {IncomingMessage,ServerResponse} from "node:http";
import type {HubCharacters} from "../characters.ts";
import {effectiveKnowledgeCharacter} from "./knowledge-identity.ts";

/** Read registered schemas, never execute/probe a tool to display this page. */
export async function toolCatalog(ctx:any,characters:HubCharacters,browserStatus?:()=>Promise<{installed:boolean;ready:boolean;version?:string}>){
  await characters.ready;
  const standing=await ctx.agentPresets.standingKeyFor();
  const host=ctx.tools.schemas(standing) as {name:string;description:string;parameters:unknown}[];
  const catalog=new Map(host.filter(t=>!t.name.startsWith("hub_character_")).map(t=>[t.name,{...t,hostRegistered:true,contexts:0,characterContexts:[] as string[]}]));
  for(const agent of ctx.agents.list()){
    const character=effectiveKnowledgeCharacter(ctx,agent);
    for(const tool of ctx.tools.schemas(agent)){
      if(tool.name.startsWith("hub_character_"))continue;
      const record=catalog.get(tool.name)??{...tool,hostRegistered:false,contexts:0,characterContexts:[]};record.contexts++;
      if(character&&!record.characterContexts.includes(character.id))record.characterContexts.push(character.id);
      catalog.set(tool.name,record);
    }
  }
  const state=characters.store.snapshot();
  for(const character of state.characters)if(character.tools.mode==="allow")for(const name of character.tools.names)if(!catalog.has(name))catalog.set(name,{name,description:"Named in character permissions; no registration is visible in this runtime.",parameters:undefined,hostRegistered:false,contexts:0,characterContexts:[]});
  const browser=browserStatus?await browserStatus().catch(()=>({installed:false,ready:false})):undefined;
  return {revision:state.revision,observedAt:Date.now(),services:browser?{browser}:undefined,tools:[...catalog.values()].sort((a,b)=>a.name.localeCompare(b.name)),characters:state.characters.map(c=>({id:c.id,name:c.name,configured:!!c.route,policy:c.tools})),meaning:"Registration and character policy are shown separately. Browser state, channel, task permissions, approvals and connected services are checked again at execution. Agent-scoped tools appear when that context exists. Camofox controls websites; it does not control Windows applications."};
}

export function installToolCatalog(ctx:any,characters:HubCharacters,browserStatus?:()=>Promise<{installed:boolean;ready:boolean;version?:string}>){
  return ctx.webServer.register({kind:"exact",path:"/api/hub/tools",async handler(req:IncomingMessage,res:ServerResponse){
    const send=(code:number,value:unknown)=>{res.writeHead(code,{"content-type":"application/json; charset=utf-8","cache-control":"no-store"});res.end(JSON.stringify(value));};
    const rejected=ctx.connection.requestRejection(req);
    if(rejected||req.headers["sec-fetch-site"]==="cross-site"||req.headers["x-hub-tools"]!=="1"){send(rejected??403,{error:"unauthorized"});return;}
    if(req.method!=="GET"){send(405,{error:"method-not-allowed"});return;}
    try{send(200,await toolCatalog(ctx,characters,browserStatus));}catch{send(503,{error:"tools-unavailable",detail:"Tool inventory could not load. Your permissions have not changed."});}
  }});
}
