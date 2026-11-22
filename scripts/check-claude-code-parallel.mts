// Manual check against the real Claude Code CLI (uses the PC's Claude subscription, a few hundred tokens):
// do several tool calls from one answer reach HUB as one batch, and does each step report its own usage?
import {ClaudeCodeAdapter,findClaude} from "../packages/harness-overlay/src/host/claude-code-provider.ts";
const command=findClaude();if(!command)throw new Error("claude CLI not found");
const adapter=new ClaudeCodeAdapter(command);
const tools=[{name:"lookup",description:"Looks up one city's weather.",parameters:{type:"object",properties:{city:{type:"string"}},required:["city"]}}];
const user={role:"user",source:{kind:"user"},content:[{type:"text",text:"Look up the weather for Istanbul, Ankara and Izmir. Call lookup for all three at once in one response, then answer in one line."}]};
const collect=async(it:AsyncIterable<any>)=>{const out:any[]=[];for await(const c of it)out.push(c);return out;};
const t0=Date.now();
const first=await collect(adapter.stream({model:process.argv[2]??"haiku",reasoningEffort:"low",sessionId:"parallel-check",messages:[user],system:"You are a test assistant.",tools}));
const calls=first.filter(c=>c.type==="block-end"&&c.block.type==="tool-call").map(c=>c.block);
console.log("step 1:",((Date.now()-t0)/1000).toFixed(1)+"s",calls.length,"tool calls in one batch:",calls.map(c=>c.arguments).join(" "),"| usage",JSON.stringify(first.find(c=>c.type==="usage")?.usage));
const history:any[]=[user,{role:"assistant",source:{kind:"model"},content:calls.map(c=>({type:"tool-call",...c}))},
  ...calls.map(c=>({role:"user",source:{kind:"tool",callId:c.id},content:[{type:"tool-result",toolCallId:c.id,content:[{type:"text",text:"sunny, 20C"}]}]}))];
let step=2,chunks=await collect(adapter.stream({model:process.argv[2]??"haiku",reasoningEffort:"low",sessionId:"parallel-check",messages:history,tools}));
while(chunks.at(-1)?.reason?.kind==="tool-calls"&&step<6){const more=chunks.filter(c=>c.type==="block-end"&&c.block.type==="tool-call").map(c=>c.block);console.log("step",step,"another",more.length,"call(s)");
  history.push({role:"assistant",source:{kind:"model"},content:more.map(c=>({type:"tool-call",...c}))},...more.map(c=>({role:"user",source:{kind:"tool",callId:c.id},content:[{type:"tool-result",toolCallId:c.id,content:[{type:"text",text:"sunny, 20C"}]}]})));
  step++;chunks=await collect(adapter.stream({model:process.argv[2]??"haiku",reasoningEffort:"low",sessionId:"parallel-check",messages:history,tools}));}
console.log("final step",step,((Date.now()-t0)/1000).toFixed(1)+"s",chunks.at(-1)?.reason?.kind,"|",chunks.filter(c=>c.type==="text-delta").map(c=>c.text).join("").slice(0,120),"| usage",JSON.stringify(chunks.find(c=>c.type==="usage")?.usage));
adapter.dispose();
