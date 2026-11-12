import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createServer } from "node:http";

// Isolated visual fixture: actual sidebar component and stylesheet, synthetic API data only.
const root=resolve(import.meta.dirname,"../.."),output=join(root,"mobile/build/knowledge-activity-preview");
const source=`
import {installMobileMemoryGraph} from './packages/harness-overlay/src/client/host/mobile-memory-graph.ts';
const now=Date.parse('2026-11-12T10:00:00Z');
const base={queuedAt:now-600000,updatedAt:now,attempts:1,startedAt:now-10000,finishedAt:now-1000,previousAttempts:[],warnings:[],source:{id:'synthetic-source',channel:'pwa',recordId:'fixture-note',assets:[]}};
const entries=[{...base,id:'fixture-success',status:'done',outcome:'organized',reason:'Synthetic example: saved a source-backed note and organized its domain.',changes:[{kind:'note',action:'created',title:'Conversation preference',id:'fixture-note'},{kind:'domain',action:'created',title:'Projects'},{kind:'tag',action:'saved',title:'communication'},{kind:'link',action:'saved evidence',title:'HUB → Projects · develops',targetId:'fixture-project'}]},
{...base,id:'fixture-no-change',status:'done',outcome:'skipped',reason:'Synthetic example: the information was already present; no duplicate note was created.',changes:[]},
{...base,id:'fixture-failed',status:'failed',reason:'Synthetic provider timeout. Original records are unchanged.',error:{phase:'model response',code:'FIXTURE_TIMEOUT',message:'Synthetic provider timeout; review the existing Knowledge settings before retrying.'},retryAt:now-15000,previousAttempts:[{attempt:1,status:'failed',startedAt:now-30000,finishedAt:now-20000,reason:'Earlier synthetic timeout'}],changes:[]}];
window.fetch=async input=>{const url=String(input);if(url.includes('view=activity'))return {ok:true,json:async()=>({version:1,state:'needs-attention',enabled:true,lastStartedAt:now-10000,lastFinishedAt:now-1000,entries,total:3,offset:0,historyNotice:'Synthetic visual fixture only. Production history comes from durable receipts; missing older history is not reconstructed.'})};if(url.includes('view=graph'))return{ok:true,json:async()=>({secondBrain:true,nodes:[{id:'fixture-note',title:'Fixture note',kind:'note'},{id:'fixture-project',title:'Fixture project',kind:'note'}],edges:[{source:'fixture-note',target:'fixture-project'}],domains:[]})};throw Error('This isolated fixture has no real host or provider access');};
installMobileMemoryGraph(document.querySelector('main'),document);
`;
const bundle=await build({stdin:{contents:source,resolveDir:root,loader:"ts"},bundle:true,write:false,format:"iife",platform:"browser",target:"safari17",loader:{".css":"text"},logLevel:"silent"});
const html=`<!doctype html><html lang="tr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic Knowledge activity fixture</title><body data-ds-dark-theme style="margin:0;background:#111725;color:#edf0fa;font:14px system-ui"><p style="padding:12px">Synthetic fixture · actual sidebar tile and activity dialog · no model calls</p><main style="padding:12px;max-width:390px;box-sizing:border-box"></main><script>${bundle.outputFiles[0].text.replace(/<\/script/gi,"<\\/script")}</script></body></html>`;
await mkdir(output,{recursive:true});await writeFile(join(output,"index.html"),html);console.log(join(output,"index.html"));
if(process.argv.includes("--serve")){
 const server=createServer((request,response)=>{if(request.url!=="/"){response.writeHead(404,{"content-type":"text/plain"});response.end("Synthetic fixture: no real records or files");return;}response.writeHead(200,{"content-type":"text/html; charset=utf-8","cache-control":"no-store"});response.end(html);});
 server.listen(0,"127.0.0.1",()=>console.log(`http://127.0.0.1:${server.address().port}/`));
}
