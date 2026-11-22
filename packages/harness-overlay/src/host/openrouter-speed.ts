/** OpenRouter sends a model to one of many hosting companies. Its default
 * weighs price first, which put HUB's GLM 5.3 Flash on hosts writing about 22
 * tokens a second with ~2.8 s before the first token, while the fastest hosts
 * of the same model write 120-200 tokens a second and start within a second.
 * HUB asks OpenRouter for the fastest host instead (its "Nitro" order); the
 * model, the answer and the account stay the same, at a slightly higher price
 * per token (about $2-3 a month more at the November 2026 GLM usage).
 *
 * The model client is created per request with the global fetch, so HUB adds
 * the routing preference to its OpenRouter chat requests here, and only when
 * the request does not already carry its own. */
export const OPENROUTER_CHAT_URL="https://openrouter.ai/api/v1/chat/completions";
export const OPENROUTER_SPEED={sort:"throughput"} as const;

export function withOpenRouterSpeed(url:string,init:RequestInit|undefined):RequestInit|undefined{
  if(url!==OPENROUTER_CHAT_URL||String(init?.method??"GET").toUpperCase()!=="POST"||typeof init?.body!=="string")return undefined;
  let body:unknown;try{body=JSON.parse(init.body);}catch{return undefined;}
  if(!body||typeof body!=="object"||Array.isArray(body)||"provider" in body)return undefined;
  return {...init,body:JSON.stringify({...body,provider:OPENROUTER_SPEED})};
}

export function installOpenRouterSpeed(target:{fetch:typeof fetch}=globalThis){
  const original=target.fetch;
  const fast:typeof fetch=function(this:unknown,input:RequestInfo|URL,init?:RequestInit){
    const url=typeof input==="string"?input:input instanceof URL?input.href:(input as Request)?.url;
    let changed:RequestInit|undefined;try{changed=typeof url==="string"?withOpenRouterSpeed(url,init):undefined;}catch{changed=undefined;}
    return original.call(this,input,changed??init);
  } as typeof fetch;
  target.fetch=fast;
  return ()=>{if(target.fetch===fast)target.fetch=original;};
}
