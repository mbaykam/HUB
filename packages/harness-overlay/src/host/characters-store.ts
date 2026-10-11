import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { charactersStateSchema, characterCommandSchema, type HubCharactersState, type HubCharacter } from "../character-contract.ts";

export class CharacterConflict extends Error {}
export class CharacterStore {
  #state!:HubCharactersState; #queue=Promise.resolve();
  readonly root:string;
  constructor(root:string){this.root=root;}
  async load(seed:()=>Promise<HubCharactersState>) {
    await mkdir(this.root,{recursive:true});
    try { this.#state=charactersStateSchema.parse(JSON.parse(await readFile(join(this.root,"characters.json"),"utf8"))); }
    catch(e){ if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;this.#state=charactersStateSchema.parse(await seed());await this.#write(this.#state); }
  }
  snapshot(){return charactersStateSchema.parse(this.#state);}
  selected(sessionId?:string,s=this.snapshot()){const im=sessionId?.startsWith("minke-im-");const id=sessionId&&!im&&Object.hasOwn(s.bindings,sessionId)?s.bindings[sessionId]:s.mainId;return s.characters.find(c=>c.id===id)!;}
  async #write(s:HubCharactersState){const temp=join(this.root,randomUUID()+".tmp");await writeFile(temp,JSON.stringify(s,null,2)+"\n",{mode:0o600});await rename(temp,join(this.root,"characters.json"));}
  async change(value:unknown,validate:(character:HubCharacter)=>Promise<void>){
    const command=characterCommandSchema.parse(value);
    const update=this.#queue.then(async()=>{
      const s=this.snapshot();if(s.revision!==command.revision)throw new CharacterConflict("Characters changed on another screen. Reload before saving.");
      if(command.action==="save" || command.action==="create"){
        const character=command.action==="create"?{...command.character,id:randomUUID()}:command.character;
        await validate(character);
        if(command.action==="save"){if(!s.characters.some(c=>c.id===character.id))throw new Error("Character no longer exists");s.characters=s.characters.map(c=>c.id===character.id?character:c);}
        else s.characters.push(character);
      }else{
        const c=s.characters.find(c=>c.id===command.id);if(!c)throw new Error("Character no longer exists");
        if(command.action==="delete"){
          if(command.id===s.mainId || command.id===s.voiceId)throw new Error("Choose another main/voice character before deleting this one");
          s.characters=s.characters.filter(c=>c.id!==command.id);
          for(const key of Object.keys(s.bindings))if(s.bindings[key]===command.id)delete s.bindings[key];
          for(const c of s.characters)if(c.delegateTo===command.id)c.delegateTo=null;
        }else{
          await validate(c);if(!c.route)throw new Error("Choose a model for this character first");
          if(command.action==="voice"){if(!c.speech)throw new Error("Configure local speech first");s.voiceId=c.id;}
          else if(command.action==="main")s.mainId=c.id;
          else Object.defineProperty(s.bindings,command.sessionId,{value:c.id,writable:true,enumerable:true,configurable:true});
        }
      }
      s.revision++;const valid=charactersStateSchema.parse(s);await this.#write(valid);this.#state=valid;return this.snapshot();
    });this.#queue=update.then(()=>{},()=>{});return update;
  }
}
