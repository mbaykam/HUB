import type {AutomationTrigger} from "./automation-contract.ts";
import type {ResearchSpec} from "./research-contract.ts";

export type GoalTrigger={kind:"manual"}|AutomationTrigger;
export interface GoalInput {
  research?:ResearchSpec;
  title:string;objective:string;criteria:string[];characterId:string;
  approach:"quick"|"balanced"|"thorough"|"custom";instructions:string;helpers:string[];verifierId?:string;fallbacks?:string[];
  resources:{knowledge:boolean;browser:boolean;folders:string[];files:string[];writeFolders:string[];tools:string[];knowledgeOutput:boolean};
  limits:{maxRounds:number;activeMinutes:number;maxSteps:number;maxOutputTokens:number;dailyRounds:number;dailyBudget:number;totalBudget:number;inputPrice:number;outputPrice:number;deadline?:number;workingHours?:{start:number;end:number;timezone:string;days:number[]}};
  schedule:{trigger:GoalTrigger;repeat:"continue"|"fresh";missed:"skip"|"catch-up"};
  recovery:"read-only"|"ask";humanApproval:boolean;notification:"pwa"|"telegram";sourceSessionId?:string;
}
export type GoalStatus="draft"|"scheduled"|"planning"|"working"|"verifying"|"waiting-hours"|"waiting-foreground"|"waiting-credit"|"waiting-budget"|"needs-input"|"needs-approval"|"paused"|"completed"|"stopped"|"archived";
export interface GoalMilestone {id:string;title:string;dependsOn:string[];status:"pending"|"working"|"done";evidence:string[]}
export interface GoalEvidence {id:string;roundId:string;kind:"tool"|"file"|"verification";label:string;detail:string;tool?:string;path?:string;sha256?:string;at:number}
export interface GoalCheckpoint {summary:string;nextAction:string;plan?:GoalMilestone[];criteria?:{index:number;evidence:string[]}[];complete?:boolean;needsInput?:string;result?:string}
export interface GoalApproval {id:string;at:number;description:string;tool:string;arguments:unknown;status:"pending"|"approved"|"denied"|"consumed";revision:number;result?:string}
export interface GoalRound {id:string;cycleId:string;sessionId:string;at:number;finishedAt?:number;route:string;characterId:string;status:"running"|"done"|"failed"|"interrupted";estimatedCost:number;error?:string;summary?:string;nativeGoal?:{id:string;revision:number;phase:string;roundsStarted:number}}
export interface GoalCycle {id:string;sessionId:string;startedAt:number;finishedAt?:number;status:"active"|"completed"|"stopped";result?:string;evidence:string[]}
export interface HubGoal extends GoalInput {
  id:string;revision:number;createdAt:number;updatedAt:number;state:"draft"|"active"|"paused"|"completed"|"stopped"|"archived";status:GoalStatus;reason?:string;
  nextAt?:number;lastCheckAt?:number;lastValue?:string;lastMatch?:boolean;pendingEvent?:string;scheduledWake?:number;blockedProvider?:string;
  plan:GoalMilestone[];planRevision:number;checkpoint?:GoalCheckpoint;criteriaEvidence:{index:number;evidence:string[]}[];
  planHistory?:{at:number;revision:number;plan:GoalMilestone[]}[];
  rounds:GoalRound[];cycles:GoalCycle[];evidence:GoalEvidence[];approvals:GoalApproval[];activeMs:number;consecutiveFailures:number;noProgressRounds:number;
  history:{at:number;kind:string;message:string;revision:number}[];workspace?:string;
}
export interface GoalsSnapshot {revision:number;goals:HubGoal[];hostRunsOnlyWhileOnline:true;maxBackgroundWorkers:1;characters:{id:string;name:string;route:{provider:string;model:string;reasoningEffort?:string}|null}[];tools:string[]}
export const GOAL_READ_TOOLS=["web_search","web_fetch","minke_web_search","camofox_search","camofox_open","camofox_snapshot","camofox_close","hub_knowledge_search","hub_knowledge_read"];
export const defaultGoal:Omit<GoalInput,"title"|"objective"|"criteria"|"characterId">={
  approach:"balanced",instructions:"",helpers:[],fallbacks:[],resources:{knowledge:true,browser:true,folders:[],files:[],writeFolders:[],tools:[],knowledgeOutput:false},
  limits:{maxRounds:40,activeMinutes:60,maxSteps:8,maxOutputTokens:4096,dailyRounds:40,dailyBudget:1,totalBudget:5,inputPrice:.1,outputPrice:.5},
  schedule:{trigger:{kind:"manual"},repeat:"continue",missed:"catch-up"},recovery:"read-only",humanApproval:false,notification:"pwa"
};
