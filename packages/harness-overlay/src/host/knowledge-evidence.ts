import type { KnowledgeSource } from "../knowledge-contract.ts";

export const KNOWLEDGE_MESSAGE_LABEL="CURRENT MESSAGES (author roles preserved; task is not a fresh human statement, assistant output is not proof of user facts or completed actions): ";
export const isKnowledgeEvaluation=(id:string)=>/^(hub-memory-|hub-character-eval-|hub-character-check-|hub-natural-calling-check-|hub-handoff-check-|hub-eval-|hub-probe-)/.test(id);
/** Uploaded document prose is evidence about the document, not a human claim
 * about themselves, even when a transport embeds the preview in a user message. */
export function genuineUserText(text:string){
  return text.replace(/BEGIN UNTRUSTED FILE CONTENT[^\n]*\n[\s\S]*?\nEND UNTRUSTED FILE CONTENT/g,"\n[attachment data omitted]\n")
    .replace(/File content \(untrusted data\):\n[\s\S]*$/g,"\n[attachment data omitted]\n");
}
/** Mask before episode chunking, keeping exact UTF-16 offsets. A later chunk
 * of a long upload must not lose its untrusted-file boundary. */
export function maskKnowledgeFileData(text:string){
  return text.replace(/BEGIN UNTRUSTED FILE CONTENT[^\n]*\n[\s\S]*?(?:\nEND UNTRUSTED FILE CONTENT|$)/g,match=>match.replace(/[^\r\n]/g," "))
    .replace(/File content \(untrusted data\):\n[\s\S]*$/g,match=>match.replace(/[^\r\n]/g," "));
}

/** Re-admit old typed episodes without recycling runtime instructions or recall.
 * Delegated prompts describe work, even when their transport uses a user role. */
export function cleanKnowledgeSource(source:KnowledgeSource):KnowledgeSource {
  if(source.evidenceVersion===2)return source;
  const at=source.content.indexOf(KNOWLEDGE_MESSAGE_LABEL);
  if(at<0)return source;
  let messages:any[];
  try {messages=JSON.parse(source.content.slice(at+KNOWLEDGE_MESSAGE_LABEL.length));} catch {return source;}
  if(!Array.isArray(messages))return source;
  const worker=source.channel==="hub-worker-result";
  const clean=messages.filter(m=>m&&["user","assistant"].includes(m.role)&&typeof m.text==="string").map(m=>({role:worker&&m.role==="user"?"task":m.role,text:worker?m.text.split("\nYour parent agent id is ")[0]:m.text}));
  // Context is only prior genuine human/assistant text from the native capturer.
  // Old worker context can contain injected notes, so it is not replayed.
  const prefix=worker?"Prior conversation context (not new facts): []\n":source.content.slice(0,at);
  return {...source,evidenceVersion:2,content:prefix+KNOWLEDGE_MESSAGE_LABEL+JSON.stringify(clean)};
}

/** A recent topic helps resolve 'that project' without a separate classifier. */
export function knowledgeRecallContext(events:readonly any[]):string {
  return events.filter(e=>e.type==="user/message"&&e.data?.source?.kind==="user").slice(-3).flatMap(e=>e.data.content?.filter((b:any)=>b.type==="text").map((b:any)=>String(b.text).slice(-650))??[]).join("\n").slice(-1600);
}
