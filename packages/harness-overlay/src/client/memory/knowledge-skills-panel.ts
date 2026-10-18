interface Skill {id:string;name:string;title:string;description:string;requiredTools:string[];hash:string;content?:string;path:string}

/** A small workflow library. A saved workflow never changes tool access. */
export function createKnowledgeSkillsPanel(root:Document,onSaved:()=>void=()=>{}){
  const view=root.defaultView!,lifetime=new AbortController();
  const el=<K extends keyof HTMLElementTagNameMap>(tag:K,text?:string)=>{const node=root.createElement(tag);if(text!==undefined)node.textContent=text;return node;};
  const button=(text:string,run:()=>void)=>{const node=el("button",text);node.type="button";node.addEventListener("click",run);return node;};
  const pane=el("section");pane.hidden=true;pane.setAttribute("data-knowledge-skills","");pane.className="knowledge-skills";
  const header=el("header"),status=el("p"),search=el("input"),list=el("div"),form=el("form"),heading=el("h3");
  status.setAttribute("role","status");search.type="search";search.placeholder="Find a skill…";search.setAttribute("aria-label","Find a skill");list.className="knowledge-skill-list";form.hidden=true;
  const field=(text:string,multiline=false)=>{const label=el("label",text),input=multiline?el("textarea"):el("input");label.append(input);form.append(label);return input;};
  form.append(heading);
  const title=field("Name"),description=field("When to use this"),content=field("Workflow instructions",true) as HTMLTextAreaElement;content.rows=10;
  const advanced=el("details"),name=el("input"),tools=el("input"),path=el("code");advanced.append(el("summary","Advanced"));
  for(const [text,input]of [["Stable skill name",name],["Required tools (optional, comma-separated)",tools]] as const){const label=el("label",text);label.append(input);advanced.append(label);}
  advanced.append(path,el("p","The required-tools list describes this workflow. It does not grant access; character permissions still apply."));form.append(advanced);
  const save=el("button","Save skill");save.type="submit";const cancel=button("Cancel",()=>{form.hidden=true;list.hidden=false;search.hidden=false;status.textContent="Changes discarded.";create.hidden=false;intro.hidden=false;});
  const actions=el("div");actions.className="knowledge-skill-actions";actions.append(save,cancel);form.append(actions);
  let selected:Skill|undefined,records:Skill[]=[],baseline="",busy=false,manualName=false,revision=0;
  const values=()=>({name:name.value,title:title.value,description:description.value,content:content.value,requiredTools:tools.value.split(/[\s,]+/).filter(Boolean),expectedHash:selected?.hash??null});
  const dirty=()=>!form.hidden&&JSON.stringify(values())!==baseline;
  function canLeave(){if(busy){status.textContent="Wait for the skill operation to finish.";return false;}if(dirty()){status.textContent="Save this skill or use Discard changes before leaving.";return false;}return true;}
  const create=button("New skill",()=>{if(!canLeave())return;edit();}),intro=el("p","Reusable workflows shared with your characters. Skills are portable Markdown files in your Knowledge vault.");
  header.append(el("h3","Skills"),create);
  pane.append(header,intro,search,status,list,form);
  form.addEventListener("input",()=>{cancel.textContent=dirty()?"Discard changes":"Cancel";});
  async function request(query="",command?:unknown){const response=await view.fetch("/api/hub/skills"+query,{method:command?"POST":"GET",credentials:"same-origin",cache:"no-store",headers:{"x-hub-skills":"1",...(command?{"content-type":"application/json"}:{})},body:command?JSON.stringify(command):undefined,signal:AbortSignal.any([lifetime.signal,AbortSignal.timeout(15000)])});const data=await response.json();if(!response.ok)throw Error(data.detail??"Skills are unavailable. Try again.");return data;}
  function render(){list.replaceChildren();const query=search.value.toLocaleLowerCase();for(const skill of records.filter(s=>(s.title+" "+s.description+" "+s.name).toLocaleLowerCase().includes(query))){const row=button("",()=>void open(skill.name));row.append(el("strong",skill.title),el("small",skill.description));list.append(row);}if(!list.childElementCount)list.append(el("p",records.length?"No matching skills.":"No saved skills yet. Add a workflow here or ask a character to save one."));}
  function edit(skill?:Skill){selected=skill;manualName=false;title.value=skill?.title??"";description.value=skill?.description??"";content.value=skill?.content??"";name.value=skill?.name??"";name.readOnly=!!skill;tools.value=skill?.requiredTools.join(", ")??"";path.textContent=skill?.path??"Saved as Skills/<stable-name>/SKILL.md";heading.textContent=skill?"Edit skill":"New skill";form.hidden=false;list.hidden=true;search.hidden=true;create.hidden=true;intro.hidden=true;cancel.textContent="Cancel";status.textContent="";baseline=JSON.stringify(values());title.focus();}
  async function open(skillName:string){if(!canLeave()||busy)return;busy=true;status.textContent="Loading skill…";const current=++revision;try{const data=await request("?name="+encodeURIComponent(skillName));if(!data.skill)throw Error("This skill is unavailable; refresh the library.");if(current===revision)edit(data.skill);}catch(error){if(!lifetime.signal.aborted)status.textContent=(error as Error).message;}finally{busy=false;}}
  title.addEventListener("input",()=>{if(!selected&&!manualName)name.value=title.value.normalize("NFKD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"").slice(0,80);});name.addEventListener("input",()=>{manualName=true;});
  search.addEventListener("input",render);
  form.addEventListener("submit",event=>{event.preventDefault();if(busy)return;const command=values();busy=true;for(const input of [title,description,content,name,tools,save,cancel])input.disabled=true;status.textContent="Saving skill…";void request("",command).then(data=>{records=data.skills;form.hidden=true;list.hidden=false;search.hidden=false;create.hidden=false;intro.hidden=false;render();status.textContent="Skill saved. Characters can find it in memory.md and load its workflow.";onSaved();}).catch(error=>{if(!lifetime.signal.aborted)status.textContent=(error as Error).message;}).finally(()=>{busy=false;for(const input of [title,description,content,name,tools,save,cancel])input.disabled=false;});});
  return {pane,canLeave,async show(){pane.hidden=false;status.textContent="Loading skills…";try{const data=await request();records=data.skills;render();status.textContent=data.issues?.length?`${data.issues.length} skill file(s) need repair. Their files were left unchanged.`:"";}catch(error){if(!lifetime.signal.aborted)status.textContent=(error as Error).message;}},dispose(){lifetime.abort();pane.remove();}};
}
