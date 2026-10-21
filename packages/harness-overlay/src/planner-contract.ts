export interface PlannerItem {
  id:string;version:number;kind:"todo"|"event";title:string;details:string;
  horizon:"near"|"later";state:"open"|"done";deleted:boolean;
  date?:string;start?:string;end?:string;timeZone:string;
  createdAt:number;updatedAt:number;sourceSessionId?:string;
}
export interface WorkPlan {
  id:string;version:number;rootSessionId:string;sessionId:string;characterId?:string;
  title:string;steps:{title:string;state:"pending"|"active"|"done"|"blocked"}[];
  state:"active"|"paused"|"completed"|"blocked";updatedAt:number;
}
export interface PlannerSnapshot {revision:number;items:PlannerItem[];plans:WorkPlan[]}
export type PlannerCommand = {action:"save";item:Pick<PlannerItem,"id"|"version"|"kind"|"title"|"details"|"horizon"|"timeZone">&Partial<Pick<PlannerItem,"date"|"start"|"end">>}
  |{action:"complete"|"reopen"|"remove"|"restore";id:string;version:number};

export const plannerDate=(date:unknown):date is string=>typeof date==="string"&&/^\d{4}-\d{2}-\d{2}$/.test(date)&&Number.isFinite(Date.parse(date))&&new Date(date).toISOString().slice(0,10)===date;
/** Calendar date in the user's chosen timezone, independent of host UTC. */
export function plannerDay(date:Date,zone:string){return new Intl.DateTimeFormat("en-CA",{timeZone:zone,year:"numeric",month:"2-digit",day:"2-digit"}).format(date);}
export function plannerItemDay(item:PlannerItem){return item.date??(item.start?plannerDay(new Date(item.start),item.timeZone):undefined);}
export function plannerLocalTime(instant:string,zone:string){
  const parts=Object.fromEntries(new Intl.DateTimeFormat("en-CA",{timeZone:zone,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(new Date(instant)).map(p=>[p.type,p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}
/** Resolve wall-clock input in the displayed zone; reject nonexistent DST
 * times. For repeated hours use the earlier occurrence deterministically. */
export function plannerZonedInstant(local:string,zone:string){
  if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(local)||!plannerDate(local.slice(0,10)))throw Error("Choose a valid local date and time");
  const target=Date.parse(local+":00Z");if(!Number.isFinite(target))throw Error("Choose a valid local time");let guess=target;
  for(let i=0;i<4;i++){const shown=Date.parse(plannerLocalTime(new Date(guess).toISOString(),zone)+":00Z"),delta=target-shown;if(!delta)break;guess+=delta;}
  if(plannerLocalTime(new Date(guess).toISOString(),zone)!==local)throw Error("That local time does not exist because the clocks change. Choose another time.");
  for(const minutes of [120,60,30])if(plannerLocalTime(new Date(guess-minutes*60000).toISOString(),zone)===local)guess-=minutes*60000;
  return new Date(guess).toISOString();
}
