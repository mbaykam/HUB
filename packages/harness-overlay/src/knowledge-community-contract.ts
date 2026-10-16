export interface KnowledgeCommunity {
  id:string;label:string;memberIds:string[];signature:string;cohesion:number;domainIds:string[];
}
export interface KnowledgeCommunitySnapshot {
  version:1;algorithm:"weighted-label-propagation-v1";authoritative:false;inputHash:string;at:number;
  groups:KnowledgeCommunity[];
  coverage:{totalRecords:number;consideredRecords:number;totalEdges:number;consideredEdges:number;omittedSources:number;complete:boolean;limitedBy:("records"|"edges"|"source-coverage"|"similarity-coverage")[]};
}
