import {join} from "node:path";
import {createPrivateKey} from "node:crypto";
import {NativePushStore,createApplePushSender,createNativePushHandler,type ApplePushConfig,type NativePushEvent} from "./native-push.ts";
import {isKnowledgeEvaluation} from "./knowledge-evidence.ts";
import {operationFailure} from "./operation-failure.ts";

/** Opt-in native device delivery is independent from Telegram destinations and
 * never changes a character's tools, prompts, model or external-message policy. */
export function installNativePush(ctx:any,characters:any){
  // Apple delivery is optional. Missing credentials must never prevent ordinary
  // characters, Goals or Automations from mounting.
  let credentials:any;
  const credentialScope=ctx.inject(["credentials"],(child:any)=>{
    const binding=child.credentials;credentials=binding;
    child.effect(()=>()=>{if(credentials===binding)credentials=undefined;},"native push optional credentials");
  });
  const readConfig=async():Promise<ApplePushConfig|undefined>=>{
    const refs=["APNS_TEAM_ID","APNS_KEY_ID","APNS_TOPIC","APNS_PRIVATE_KEY_P8"];
    const values=await Promise.all(refs.map(async ref=>(await credentials?.resolve(ref))?.value));
    if(values.some(v=>typeof v!=="string"||!v))return;
    const [teamId,keyId,topic,privateKey]=values as string[];
    if(!/^[A-Z0-9]{10}$/.test(teamId!)||!/^[A-Z0-9]{10}$/.test(keyId!)||!/^[-A-Za-z0-9]+(?:\.[-A-Za-z0-9]+){2,}$/.test(topic!))return;
    try{const key=createPrivateKey(privateKey!);if(key.asymmetricKeyType!=="ec"||key.asymmetricKeyDetails?.namedCurve!=="prime256v1")return;}catch{return;}
    return {teamId:teamId!,keyId:keyId!,topic:topic!,privateKey:privateKey!};
  };
  const store=new NativePushStore(join(characters.store.root,"..","hub-native-push"),createApplePushSender(readConfig));
  const ready=store.initialize();void ready.catch(()=>{});
  const publisher={publish(event:NativePushEvent){void ready.then(()=>store.publish(event)).catch(()=>{});}};
  characters.nativePush=publisher;
  const handler=createNativePushHandler({store,ready,configured:async()=>!!await readConfig(),reject:req=>ctx.connection.requestRejection(req)});
  const offRoute=ctx.webServer.register({kind:"exact",path:"/api/hub/notifications",handler});
  const offEvents=ctx.on("session/event",(record:any,event:any)=>{
    const header=record.header;
    if(event.type!=="turn/end"||header.origin!=="subagent"||!header.parentSession||/^hub-(goal|memory|automation)-/.test(header.id)||/^hub-(goal|memory|automation)-/.test(header.parentSession)||isKnowledgeEvaluation(header.id)||isKnowledgeEvaluation(header.parentSession))return;
    if(ctx.agents.get(header.parentSession)?.session?.header?.origin==="subagent")return;
    const failure=operationFailure(event.data?.reason);if(failure&&["user","cancelled","canceled"].includes(failure.kind))return;
    const sequence=String(event.id??event.index??record.snapshotEvents().length);
    publisher.publish({id:`task:${header.id}:${sequence}`,sessionId:header.parentSession,kind:"task",status:failure?"failed":"completed"});
  },{global:true});
  const timer=setInterval(()=>{void ready.then(()=>store.tick()).catch(()=>{});},30000);timer.unref();
  return ()=>{void credentialScope.dispose();clearInterval(timer);offRoute();offEvents();if(characters.nativePush===publisher)characters.nativePush=undefined;};
}
