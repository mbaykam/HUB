import {foldSubagentDescriptor} from "@deepseek-ai/dsh-subagent";
import type {HubCharacter} from "../character-contract.ts";
export const knowledgeCharacterMarker="HUB_CHARACTER_AUTHORITY_V1 ";
export function characterAuthorityPersona(character:Pick<HubCharacter,"id"|"tools">){return knowledgeCharacterMarker+JSON.stringify({id:character.id,tools:character.tools})+"\n";}
/** Read host-owned turn state or the model-hidden native descriptor. User
 * messages and the parent's current speaker never establish worker identity. */
export function effectiveKnowledgeCharacter(ctx:any,agent:any):Pick<HubCharacter,"id"|"tools">|undefined{
  const manager=ctx.hubCharacters??ctx.get?.("hubCharacters"),sessionId=agent.session.header.id,active=manager?.effectiveCharacter?.(sessionId);if(active)return active;
  if(agent.session.header.origin==="subagent"){
    try{const descriptor=foldSubagentDescriptor(agent.session.snapshotEvents());if(descriptor?.mode==="continuable"&&descriptor.persona?.startsWith(knowledgeCharacterMarker)){const line=descriptor.persona.slice(knowledgeCharacterMarker.length).split("\n")[0]!,value=JSON.parse(line);if(typeof value.id==="string"&&/^[0-9a-f-]{36}$/i.test(value.id)&&["inherit","allow"].includes(value.tools?.mode)&&(value.tools.mode==="inherit"||Array.isArray(value.tools.names)&&value.tools.names.every((n:unknown)=>typeof n==="string")))return value;}}catch{/* Unknown native descriptor versions fail closed for private reflections. */}
  }
  for(const key of ["hubGoalAuthority","hubAutomationAuthority"]){const authority=agent.ctx.get?.(key);if(authority?.sessionId===sessionId&&authority.character)return authority.character;}
  return undefined;
}
export function assertKnowledgeTool(ctx:any,agent:any,name:string){const character=effectiveKnowledgeCharacter(ctx,agent);if(character?.tools.mode==="allow"&&!character.tools.names.includes(name))throw Error("Knowledge access is disabled for this character");return character;}
