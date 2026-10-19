/** Extractive topic titles: no extra model call, language translation or
 * changes to transcript bodies. Human title edits always take precedence. */
export function voiceTopicTitle(events:readonly any[]){
  const topics:{seq:number;text:string}[]=[];
  for(const event of events){
    if(event.type!=="user/message"||event.data?.source?.kind!=="user")continue;
    const text=(event.data.content??[]).filter((b:any)=>b.type==="text").map((b:any)=>b.text).join(" ").replace(/\s+/g," ").trim();
    if(!text||/^(?:hello|hi|hey|merhaba|selam|thank you|thanks|teşekkürler|can you hear me|beni duyuyor musun|save (?:this|the) conversation|bu konuşmayı kaydet)[.!?\s]*$/iu.test(text))continue;
    if(!topics.some(t=>t.text.toLocaleLowerCase()===text.toLocaleLowerCase()))topics.push({seq:event.seq,text});
    if(topics.length===2)break;
  }
  if(!topics.length)return;
  const topic=topics.map(t=>t.text.replace(/[.!?]+$/u,"")).join(" · ");
  let title="",bytes=0;for(const character of topic){const size=Buffer.byteLength(character,"utf8");if(bytes+size>76)break;title+=character;bytes+=size;}
  return {title:title.trim(),messageSeqs:topics.slice(0,2).map(t=>t.seq),source:{kind:"fallback" as const}};
}
export function installVoiceTitles(ctx:any,history:{view(id:string,origin?:string):{kind:string}}){
  return ctx.on("session/event",(session:any,event:any)=>{
    if(!["user/message","turn/end","session/title"].includes(event.type)||history.view(session.header.id,session.header.origin).kind!=="voice"||typeof session.append!=="function")return;
    const events=session.snapshotEvents(),current=events.findLast((e:any)=>e.type==="session/title");
    if(current?.data?.source?.kind==="user")return;
    const next=voiceTopicTitle(events);if(next&&next.title!==current?.data?.title)session.append("session/title",next);
  },{global:true});
}
