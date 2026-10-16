export interface KnowledgeDomain {id:string;title:string;aliases:string[];parentId?:string;status:"active"|"inactive"|"merged";mergedInto?:string;createdAt:number;updatedAt:number}
export interface DomainEvidence {sourceId:string;quote:string;contentHash?:string;messageId?:string;assetId?:string;locator?:string}
export interface KnowledgeMembership {nodeId:string;domainId:string;evidence:DomainEvidence[];origin:"user"|"curator";revisionId:string}
export type DomainLifecycleOperation=
 | {type:"rename";id:string;title:string;aliases?:string[]}
 | {type:"reparent";id:string;parentId?:string}
 | {type:"status";id:string;status:"active"|"inactive"}
 | {type:"merge";id:string;targetId:string}
 | {type:"split";id:string;groups:{ref:string;title:string;aliases?:string[];nodeIds:string[]}[];deactivateSource?:boolean}
 | {type:"unassign";nodeId:string;domainId:string};
export type DomainOperation=DomainLifecycleOperation
 | {type:"create";ref:string;title:string;aliases?:string[];parentId?:string;evidence?:string}
 | {type:"assign";nodeId?:string;domainId:string;evidence?:string}
 | {type:"propose";operation:DomainLifecycleOperation;evidence:string};
export interface DomainProposal {id:string;sourceId:string;at:number;evidence:string;operation:DomainLifecycleOperation;basedOnRevision:number;status:"pending"|"applied"|"rejected"}
export interface DomainAudit {id:string;at:number;actor:"user"|"curator";sourceId?:string;operations:DomainOperation[];resolvedReferences?:Record<string,string>;beforeDomains:{id:string;value:KnowledgeDomain|null}[];afterDomains?:{id:string;value:KnowledgeDomain|null}[];beforeMemberships:{key:string;value:KnowledgeMembership|null}[];beforeProposals:{id:string;value:DomainProposal|null}[];beforeCap:number;afterRevision:number;undone?:boolean}
export interface KnowledgeDomainState {version:1;revision:number;maxActiveDomains:number;domains:KnowledgeDomain[];memberships:KnowledgeMembership[];proposals:DomainProposal[];history:DomainAudit[]}
export const emptyKnowledgeDomains=():KnowledgeDomainState=>({version:1,revision:0,maxActiveDomains:7,domains:[],memberships:[],proposals:[],history:[]});
