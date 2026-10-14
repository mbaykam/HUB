/** Native end reasons are structured objects. Dispatch is never completion. */
export function operationFailure(reason:any):{kind:string;code:string;message:string;quota:boolean}|undefined {
  const kind=typeof reason==="string"?reason:reason?.kind??"unknown";
  if(kind==="completed")return;
  const code=String(reason?.error?.code??reason?.code??kind).slice(0,80);
  const message=String(reason?.error?.message??reason?.message??kind).slice(0,1000);
  return {kind,code,message,quota:isQuotaFailure({code,message})};
}
export function isQuotaFailure(error:any){
  return /^(QUOTA|INSUFFICIENT_QUOTA|CREDITS_EXHAUSTED)$/i.test(String(error?.code??"")) || /insufficient (?:quota|credits|balance)|out of credits|credit balance.*(?:low|exhaust)|usage limit.*(?:reached|exceeded)|in_flight_budget_exhausted/i.test(String(error?.message??""));
}
