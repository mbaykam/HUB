import {basename,extname} from "node:path";
import {createHash} from "node:crypto";
import type {KnowledgeAssets} from "./knowledge-assets.ts";
import type {KnowledgeAsset} from "../knowledge-contract.ts";
export interface ConversationArtifact {id:string;callId:string;turn:number;path:string;name:string;content:string;at:number;seq:number}
/** Only a successful native write is evidence of a created file. Tool-call
 * text, model claims and failed/cancelled writes cannot register an artifact. */
export function conversationArtifacts(events:readonly any[]):ConversationArtifact[]{
  const pending=new Map<string,any>(),files=new Map<string,ConversationArtifact>();
  for(const event of events){
    if(event.type==="tool/call"&&event.data?.name==="write")pending.set(event.data.callId,event);
    if(event.type!=="tool/result")continue;
    for(const result of event.data?.message?.content??[]){
      if(result.type!=="tool-result"||result.isError!==false)continue;const call=pending.get(result.toolCallId);if(!call)continue;
      try{const args=typeof call.data.arguments==="string"?JSON.parse(call.data.arguments):call.data.arguments;
        if(typeof args?.file_path!=="string"||typeof args.content!=="string"||Buffer.byteLength(args.content)>3_000_000)continue;
        const path=args.file_path.replace(/\\+/g,"/");if(!path||/[\u0000-\u001f]/.test(path))continue;
        files.set(path,{id:createHash("sha256").update(path).digest("hex"),callId:call.data.callId,turn:call.data.turn,path,name:basename(path),content:args.content,at:event.time,seq:event.seq});
      }catch{/* malformed native arguments are not an artifact */}
    }
  }return [...files.values()];
}
export async function archiveGeneratedArtifacts(sessionId:string,events:readonly any[],assets:KnowledgeAssets){
  const saved:{artifact:ConversationArtifact;asset:KnowledgeAsset}[]=[];
  for(const artifact of conversationArtifacts(events))saved.push({artifact,asset:{...await assets.save(Buffer.from(artifact.content,"utf8"),artifact.name),createdIn:{sessionId,callId:artifact.callId,path:artifact.path,at:artifact.at}}});
  return saved;
}
const mime:Record<string,string>={".css":"text/css",".js":"text/javascript",".svg":"image/svg+xml",".png":"image/png",".jpg":"image/jpeg",".json":"application/json",".txt":"text/plain",".woff2":"font/woff2"};
export function artifactDocument(artifact:ConversationArtifact,files:ConversationArtifact[]){
  const byPath=new Map(files.map(f=>[new URL(f.path,"file:///").href,f]));
  const inline=(url:string)=>{if(/^(data:|#)/i.test(url))return url;try{const file=byPath.get(new URL(url,new URL(artifact.path,"file:///")).href);return file?`data:${mime[extname(file.path).toLowerCase()]??"text/plain"};base64,${Buffer.from(file.content).toString("base64")}`:url;}catch{return url;}};
  let html=artifact.content.replace(/\b(src|href)\s*=\s*(["'])([^"']+)\2/gi,(_all,key,quote,url)=>`${key}=${quote}${inline(url)}${quote}`);
  // Opaque sandbox: no host cookies, network, forms, popups, navigation or
  // tool bridge. Original files are preserved byte-for-byte in Knowledge.
  const csp="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' data: blob:; style-src 'unsafe-inline' data:; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'";
  const head=`<meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html{max-width:100%;overflow:auto}body{box-sizing:border-box}canvas,img,video{max-width:100%;height:auto}*{touch-action:manipulation}</style>`;
  const keys=`<script>addEventListener('message',e=>{if(e.source!==parent||!['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Enter','r','Escape'].includes(e.data?.hubArtifactKey))return;for(const type of ['keydown','keyup'])document.dispatchEvent(new KeyboardEvent(type,{key:e.data.hubArtifactKey,bubbles:true}));});<\/script>`;
  html=html.replace(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh\b[^>]*>/gi,"");
  // Keep the original doctype first so imported apps use standards mode.
  if(/<head(?:\s[^>]*)?>/i.test(html))return html.replace(/<head(?:\s[^>]*)?>/i,match=>match+head)+keys;
  if(/<html(?:\s[^>]*)?>/i.test(html))return html.replace(/<html(?:\s[^>]*)?>/i,match=>match+"<head>"+head+"</head>")+keys;
  return "<!doctype html><html><head>"+head+"</head><body>"+html+keys+"</body></html>";
}
