import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {AutomationsStore,withinActiveHours} from "../packages/harness-overlay/src/host/automations-store.ts";
import {scheduleView,changeSchedule,triggerOf} from "../packages/harness-overlay/src/host/schedule.ts";
import {isQuietResult} from "../packages/harness-overlay/src/host/automations.ts";
import {tidyPrompt,hiddenInChat} from "../packages/harness-overlay/src/characters.ts";

const MAIN="77c0fa08-5000-4002-9595-132ccc612a4a";
async function store(run=async()=>"done"){
  const root=await mkdtemp(join(tmpdir(),"hub-schedule-"));
  let now=Date.parse("2026-11-21T07:00:00Z");
  const runs=[];
  const s=new AutomationsStore(root,{now:()=>now,route:async()=>"openrouter/test",read:async()=>"",run:async(job,r)=>{runs.push(job);return run(job,r);}});
  await s.initialize();
  return {s,root,runs,tick:async at=>{now=at;await s.tick();},set:at=>{now=at;}};
}

test("a reminder and a daily task are saved and listed simply", async()=>{
  const {s,root}=await store();
  try{
    await changeSchedule(s,MAIN,{action:"save",job:{name:"Call mom",kind:"reminder",text:"Call mom about Sunday.",when:{kind:"once",at:"2026-11-21T18:00:00+03:00"}}},{timezone:"Europe/Istanbul",sourceSessionId:"session-x"});
    await changeSchedule(s,MAIN,{action:"save",job:{name:"News",kind:"task",text:"Three tech headlines.",when:{kind:"daily",time:"08:30",days:[1,2,3,4,5]}}},{timezone:"Europe/Istanbul"});
    const view=scheduleView(s.snapshot(),"Europe/Istanbul");
    assert.equal(view.jobs.length,2);
    const reminder=view.jobs.find(j=>j.kind==="reminder");
    assert.equal(reminder.when.kind,"once");
    assert.equal(reminder.when.at,Date.parse("2026-11-21T15:00:00Z"));
    const task=view.jobs.find(j=>j.kind==="task");
    assert.deepEqual(task.when,{kind:"daily",hour:8,minute:30,days:[1,2,3,4,5],timezone:"Europe/Istanbul"});
    assert.equal(view.heartbeat.enabled,false);
    // Editing keeps one job, and delete removes it.
    await changeSchedule(s,MAIN,{action:"save",job:{id:task.id,name:"News",kind:"task",text:"Five headlines.",when:{kind:"every",minutes:120}}},{timezone:"Europe/Istanbul"});
    assert.equal(scheduleView(s.snapshot(),"UTC").jobs.find(j=>j.id===task.id).when.minutes,120);
    await changeSchedule(s,MAIN,{action:"delete",id:task.id},{timezone:"UTC"});
    assert.deepEqual(scheduleView(s.snapshot(),"UTC").jobs.map(j=>j.id),[reminder.id]);
  }finally{await s.dispose();await rm(root,{recursive:true,force:true});}
});

test("the heartbeat needs a checklist, and an empty one turns it off", async()=>{
  const {s,root}=await store();
  try{
    await assert.rejects(changeSchedule(s,MAIN,{action:"heartbeat",heartbeat:{enabled:true,checklist:""}},{timezone:"UTC"}),/at least one thing/);
    await assert.rejects(changeSchedule(s,MAIN,{action:"heartbeat",heartbeat:{enabled:true,everyMinutes:10,checklist:"x"}},{timezone:"UTC"}),/30 to 1440/);
    await changeSchedule(s,MAIN,{action:"heartbeat",heartbeat:{enabled:true,everyMinutes:60,start:"08:00",end:"23:00",checklist:"Planner items due today"}},{timezone:"Europe/Istanbul"});
    let view=scheduleView(s.snapshot(),"UTC");
    assert.equal(view.heartbeat.enabled,true);
    assert.equal(view.heartbeat.everyMinutes,60);
    assert.equal(view.heartbeat.start,"08:00");
    assert.equal(view.jobs.length,0,"the heartbeat is not listed as a job");
    await changeSchedule(s,MAIN,{action:"heartbeat",heartbeat:{enabled:false}},{timezone:"UTC"});
    view=scheduleView(s.snapshot(),"UTC");
    assert.equal(view.heartbeat.enabled,false);
    assert.equal(view.heartbeat.checklist,"Planner items due today");
    await changeSchedule(s,MAIN,{action:"heartbeat",heartbeat:{enabled:true}},{timezone:"UTC"});
    assert.equal(scheduleView(s.snapshot(),"UTC").heartbeat.enabled,true);
    assert.equal(s.snapshot().automations.filter(j=>j.kind==="heartbeat").length,1,"one heartbeat, never two");
  }finally{await s.dispose();await rm(root,{recursive:true,force:true});}
});

test("outside active hours a heartbeat is skipped without running", async()=>{
  const {s,root,runs,tick,set}=await store();
  try{
    set(Date.parse("2026-11-21T22:30:00Z"));// 01:30 in Istanbul
    await changeSchedule(s,MAIN,{action:"heartbeat",heartbeat:{enabled:true,everyMinutes:30,start:"08:00",end:"23:00",checklist:"Mail"}},{timezone:"Europe/Istanbul"});
    await tick(Date.parse("2026-11-21T23:00:10Z"));
    assert.equal(runs.length,0);
    const beat=s.snapshot().automations.find(j=>j.kind==="heartbeat");
    assert.ok(withinActiveHours(beat.activeHours,beat.nextAt),"the next check is inside the active hours");
    await tick(beat.nextAt+1000);
    assert.equal(runs.length,1);
  }finally{await s.dispose();await rm(root,{recursive:true,force:true});}
});

test("active hours work across midnight", ()=>{
  const night={start:22*60,end:7*60,timezone:"UTC"};
  assert.equal(withinActiveHours(night,Date.parse("2026-11-21T23:00:00Z")),true);
  assert.equal(withinActiveHours(night,Date.parse("2026-11-21T06:59:00Z")),true);
  assert.equal(withinActiveHours(night,Date.parse("2026-11-21T12:00:00Z")),false);
});

test("times are parsed the way a chat writes them", ()=>{
  assert.deepEqual(triggerOf({kind:"every",minutes:90},"UTC"),{kind:"interval",seconds:5400});
  assert.throws(()=>triggerOf({kind:"every",minutes:2},"UTC"),/5 minutes/);
  assert.throws(()=>triggerOf({kind:"once",at:"tomorrow"},"UTC"),/ISO/);
  assert.deepEqual(triggerOf({kind:"daily",time:"7:05"},"Europe/Istanbul"),{kind:"calendar",hour:7,minute:5,days:[0,1,2,3,4,5,6],timezone:"Europe/Istanbul"});
});

test("a check with nothing to report stays silent", ()=>{
  assert.equal(isQuietResult("NO_REPLY"),true);
  assert.equal(isQuietResult(" HEARTBEAT_OK. "),true);
  assert.equal(isQuietResult("Checked the planner. NO_REPLY"),true);
  assert.equal(isQuietResult("Your exam form is due today at 17:00."),false);
  assert.equal(isQuietResult("NO_REPLY "+"x".repeat(400)),false);
});

test("chat prompts lose contradictions and tools the chat does not have", ()=>{
  const hidden=new Set(["web_search","minke_web_search","browser_open","create_goal","subagent","hub_character_abc123","workflow"]);
  const text=["You are an AI agent powered by DeepSeek Harness.",
    "The DeepSeek Harness implementation checkout is at C:\\HUB\\host\\. The checkout location and current working directory are separate values.",
    "You are interacting with the user through the DeepSeek Harness Web GUI at http://127.0.0.1:5000. When the user refers to \"this app\" they mean this GUI.",
    "You are a coding agent powered by the opus model. Your working directory is C:\\Users\\Mete\\.dsh.",
    "Agent Browser capabilities are staged. Use browser_open for a new page.",
    "Use the native web_search and web_fetch tools first.",
    "Use the web_search tool to discover current information.",
    "Use the web_fetch tool to retrieve the content of a URL.",
    "Use subagent in the background by default.",
    "Use hub_character_abc123 in the background by default.",
    "Use goal tools for one long-running completion objective.",
    "Use the workflow tool ONLY when the user explicitly asks."].join("\n\n");
  const out=tidyPrompt(text,hidden);
  assert.doesNotMatch(out,/AI agent powered|coding agent|this GUI|browser_open|subagent|hub_character_abc123|goal tools|workflow tool|Use the web_search tool/);
  assert.match(out,/HUB iPhone app/);
  assert.match(out,/Working directory: C:\\Users\\Mete\\\.dsh\./);
  assert.match(out,/HUB's own source code is at C:\\HUB\\host\\/);
  assert.match(out,/search with hub_web_search/);
  assert.match(out,/Use the web_fetch tool/);
  for(const name of ["ask_user_question","hub_switch_character","web_search","browser_click","mcp__windows__Shell","hub_character_77c0fa08500040029595132ccc612a4a","hub_automation_manage"])assert.equal(hiddenInChat(name),true,name);
  for(const name of ["hub_delegate","camofox_search","web_fetch","hub_schedule","hub_planner","pwsh","hub_request_share"])assert.equal(hiddenInChat(name),false,name);
});
