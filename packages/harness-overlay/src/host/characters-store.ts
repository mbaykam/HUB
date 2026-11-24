import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { charactersStateSchema, characterCommandSchema, type HubCharactersState, type HubCharacter } from "../character-contract.ts";

export class CharacterConflict extends Error {}

/** A configured character on an uncensored model (provider or model name says so), not the main one. */
export function defaultUnrestricted(s:HubCharactersState):string|undefined{
  return s.characters.find(c=>c.id!==s.mainId&&c.route&&/uncensored|unlid|abliterated/i.test(c.route.provider+" "+c.route.model))?.id
    ??s.characters.find(c=>c.id!==s.mainId&&c.route&&c.avatar==="devil")?.id;
}
export class CharacterStore {
  #state!:HubCharactersState; #queue=Promise.resolve();
  readonly root:string;
  constructor(root:string){this.root=root;}
  async load(seed:()=>Promise<HubCharactersState>) {
    await mkdir(this.root,{recursive:true});
    try {
      this.#state=charactersStateSchema.parse(JSON.parse(await readFile(join(this.root,"characters.json"),"utf8")));
      // Earlier versions had no unrestricted slot: adopt the uncensored model
      // the user already set up as a character, if there is one.
      if(this.#state.unrestrictedId===undefined){const pick=defaultUnrestricted(this.#state);if(pick){this.#state={...this.#state,unrestrictedId:pick};await this.#write(this.#state);}}
    }
    catch(e){ if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;this.#state=charactersStateSchema.parse(await seed());await this.#write(this.#state); }
  }
  snapshot(){return charactersStateSchema.parse(this.#state);}
  selected(sessionId?:string,s=this.snapshot()){const id=sessionId&&Object.hasOwn(s.bindings,sessionId)?s.bindings[sessionId]:s.mainId;return s.characters.find(c=>c.id===id)!;}
  async #write(s:HubCharactersState){const temp=join(this.root,randomUUID()+".tmp");await writeFile(temp,JSON.stringify(s,null,2)+"\n",{mode:0o600});await rename(temp,join(this.root,"characters.json"));}
  async change(value:unknown,validate:(character:HubCharacter)=>Promise<void>){
    const command=characterCommandSchema.parse(value);
    const update=this.#queue.then(async()=>{
      const s=this.snapshot();if(s.revision!==command.revision)throw new CharacterConflict("Characters changed on another screen. Reload before saving.");
      if(command.action==="name"){
        // The assistant's own name. Another (hidden) character with the same
        // name gives way, since names stay unique.
        const main=s.characters.find(c=>c.id===s.mainId)!,old=main.name,name=command.name;
        const taken=(value:string,except:string)=>s.characters.some(c=>c.id!==except&&c.name.toLowerCase()===value.toLowerCase());
        for(const c of s.characters){
          if(c.id===main.id||c.name.toLowerCase()!==name.toLowerCase())continue;
          const base=`${c.name.slice(0,40)} (${c.id===s.voiceId?"voice":c.id===s.unrestrictedId?"unrestricted":"specialist"})`;let next=base,n=2;
          while(taken(next,c.id)||next.toLowerCase()===name.toLowerCase())next=`${base} ${n++}`;
          c.name=next;
        }
        main.instructions=main.instructions.replace(new RegExp(`^You are ${old.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}\\b`),`You are ${name}`);
        main.name=name;
      }else if(command.action==="save" || command.action==="create"){
        const character=command.action==="create"?{...command.character,id:randomUUID()}:command.character;
        await validate(character);
        if(command.action==="save"){if(!s.characters.some(c=>c.id===character.id))throw new Error("Character no longer exists");s.characters=s.characters.map(c=>c.id===character.id?character:c);}
        else s.characters.push(character);
      }else{
        const c=s.characters.find(c=>c.id===command.id);if(!c)throw new Error("Character no longer exists");
        if(command.action==="delete"){
          if(command.id===s.mainId || command.id===s.voiceId)throw new Error("Choose another main/voice character before deleting this one");
          if(command.id===s.unrestrictedId)s.unrestrictedId=null;
          s.characters=s.characters.filter(c=>c.id!==command.id);
          for(const key of Object.keys(s.bindings))if(s.bindings[key]===command.id)delete s.bindings[key];
          for(const c of s.characters)if(c.delegateTo===command.id)c.delegateTo=null;
        }else{
          await validate(c);if(!c.route)throw new Error("Choose a model for this character first");
          if(command.action==="voice"){if(!c.speech)throw new Error("Configure local speech first");s.voiceId=c.id;}
          else if(command.action==="main")s.mainId=c.id;
          else if(command.action==="unrestricted")s.unrestrictedId=c.id;
          else Object.defineProperty(s.bindings,command.sessionId,{value:c.id,writable:true,enumerable:true,configurable:true});
        }
      }
      s.revision++;const valid=charactersStateSchema.parse(s);await this.#write(valid);this.#state=valid;return this.snapshot();
    });this.#queue=update.then(()=>{},()=>{});return update;
  }
}
