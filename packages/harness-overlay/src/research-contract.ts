export type ResearchDepth="quick"|"standard"|"deep";
export interface ResearchSpec {version:1;requestId:string;requesterId:string;allowedTools:string[];depth:ResearchDepth;sources:"web"|"web+knowledge";freshness:"current"|"year"|"any";asOf:string}
export const RESEARCH_LIMITS={quick:{rounds:3,minutes:5,steps:8,output:2048,reads:8,attempts:24},standard:{rounds:8,minutes:15,steps:10,output:4096,reads:24,attempts:72},deep:{rounds:16,minutes:35,steps:12,output:6144,reads:48,attempts:144}} as const;
export function validateResearch(value:any):ResearchSpec{
  if(!value||value.version!==1||!/^[-a-zA-Z0-9]{12,100}$/.test(value.requestId)||!/^[-a-zA-Z0-9]{1,100}$/.test(value.requesterId)||!['quick','standard','deep'].includes(value.depth)||!['web','web+knowledge'].includes(value.sources)||!['current','year','any'].includes(value.freshness)||typeof value.asOf!=="string"||!Number.isFinite(Date.parse(value.asOf)))throw Error("Invalid research settings.");
  if(!Array.isArray(value.allowedTools)||value.allowedTools.length>20||value.allowedTools.some((n:unknown)=>typeof n!=="string"||n.length>100))throw Error("Invalid research source permissions.");
  return {version:1,requestId:value.requestId,requesterId:value.requesterId,allowedTools:[...new Set(value.allowedTools)] as string[],depth:value.depth,sources:value.sources,freshness:value.freshness,asOf:value.asOf};
}
