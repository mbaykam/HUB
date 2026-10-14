export type AutomationTrigger =
 |{kind:"once";at:number}
 |{kind:"interval";seconds:number}
 |{kind:"calendar";hour:number;minute:number;days:number[];timezone:string}
 |{kind:"watch";url:string;seconds:number;rule:"changed"|"contains"|"not-contains"|"above"|"below";value?:string;jsonPath?:string;fireOnFirst?:boolean}
 |{kind:"event";event:string;path?:string;operator?:"equals"|"contains"|"above"|"below";value?:string};
export interface AutomationInput {title:string;prompt:string;characterId:string;trigger:AutomationTrigger;missed:"skip"|"catch-up";tools:string[];allowWrites:boolean;maxOutputTokens:number;maxSteps:number;dailyMaxRuns:number;dailyBudget:number;inputPrice:number;outputPrice:number;notification:"pwa"|"telegram";sourceSessionId?:string}
export type AutomationStatus="scheduled"|"checking"|"running"|"waiting-credit"|"budget-paused"|"delayed"|"failed"|"completed"|"paused"|"cancelled";
export interface AutomationRun {id:string;at:number;dueAt:number;sessionId:string;route?:string;status:"running"|"completed"|"failed"|"waiting-credit"|"interrupted";result?:string;error?:string;code?:string;estimatedCost:number;finishedAt?:number}
export interface HubAutomation extends AutomationInput {id:string;revision:number;state:"active"|"paused"|"cancelled"|"completed";status:AutomationStatus;createdAt:number;updatedAt:number;nextAt?:number;lastCheckAt?:number;lastValue?:string;lastMatch?:boolean;pendingEvent?:string;lastError?:string;runs:AutomationRun[]}
export interface AutomationsSnapshot {revision:number;automations:HubAutomation[];hostRunsOnlyWhileOnline:true;blockedRoutes:{route:string;message:string}[];characters:{id:string;name:string;route:{provider:string;model:string;reasoningEffort?:string}|null}[]}
export const defaultAutomation:Omit<AutomationInput,"characterId"|"title"|"prompt"|"trigger">={missed:"catch-up",tools:["web_search","web_fetch","camofox_search","camofox_open","camofox_snapshot","camofox_close","hub_knowledge_search","hub_knowledge_read"],allowWrites:false,maxOutputTokens:2048,maxSteps:3,dailyMaxRuns:6,dailyBudget:.2,inputPrice:.1,outputPrice:.5,notification:"pwa"};
