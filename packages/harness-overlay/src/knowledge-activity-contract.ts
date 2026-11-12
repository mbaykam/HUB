import type { KnowledgeJob } from "./knowledge-contract.ts";
export interface KnowledgeActivityChange {kind:"note"|"domain"|"assignment"|"tag"|"link"|"proposal"|"reflection"|"suggestion";action:string;title:string;id?:string;targetId?:string}
export interface KnowledgeAttempt {attempt:number;startedAt?:number;finishedAt?:number;status:KnowledgeJob["status"];reason?:string;error?:KnowledgeJob["error"]}
export interface KnowledgeActivityEntry {
  id:string;status:KnowledgeJob["status"];outcome?:KnowledgeJob["outcome"];queuedAt:number;updatedAt:number;startedAt?:number;finishedAt?:number;retryAt?:number;attempts:number;
  reason?:string;error?:KnowledgeJob["error"];previousAttempts:KnowledgeAttempt[];changes:KnowledgeActivityChange[];warnings:string[];
  source:{id:string;channel:string;recordId?:string;sessionId?:string;assets:{id:string;name:string}[]};
}
export interface KnowledgeActivityPage {version:1;state:string;enabled:boolean;lastStartedAt?:number;lastFinishedAt?:number;entries:KnowledgeActivityEntry[];offset:number;nextOffset?:number;total:number;historyNotice:string}
