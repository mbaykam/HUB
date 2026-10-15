import type {GoalsSnapshot} from "../../goal-contract.ts";

export interface MobileSessionIdentity { name:string; model:string; title:string }

/** Read display identity without changing a session's model or character. */
export async function readMobileSessionIdentity(view:Pick<Window,"fetch">,sessionId:string,signal:AbortSignal):Promise<MobileSessionIdentity|undefined>{
  const goal=sessionId.startsWith("hub-goal-");
  const response=await view.fetch(goal?"/api/hub/goals":"/api/hub/characters?sessionId="+encodeURIComponent(sessionId),{credentials:"same-origin",cache:"no-store",headers:goal?{"x-hub-goals":"1"}:{"x-hub-characters":"1"},signal});
  if(!response.ok)throw Error("Session identity unavailable");
  const value=await response.json();
  if(goal){
    // Goal sessions deliberately bypass normal character bindings. The profile
    // may since have changed, so display only the matching session's receipts.
    const snapshot=value as GoalsSnapshot;
    const work=snapshot.goals.find(item=>item.cycles.some(cycle=>cycle.sessionId===sessionId));
    const round=work?[...work.rounds].reverse().find(item=>item.sessionId===sessionId):undefined;
    if(!round)return;
    const name=snapshot.characters.find(character=>character.id===round.characterId)?.name??"Goal agent";
    return {name:`${name} · ${round.status==="running"?"Working":"Last run"}`,model:round.route.slice(round.route.indexOf("/")+1),title:`Goal work log · ${name} · ${round.route}`};
  }
  const {character}=value;
  if(typeof character?.name!=="string")return;
  return {name:character.name,model:character.route?.model??"Model not configured",title:character.route?`${character.name} · ${character.route.provider}/${character.route.model}`:character.name};
}
