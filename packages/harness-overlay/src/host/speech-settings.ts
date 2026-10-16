import {mkdir,readFile,writeFile,rename,rm} from "node:fs/promises";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {speechSettingsSchema,type SpeechSettings} from "../speech-settings-contract.ts";
import {localSpeechSchema,type LocalSpeechConfig} from "../voice-profile-contract.ts";

export class SpeechSettingsConflict extends Error{}
export class SharedSpeechSettings {
  #state!:SpeechSettings; #queue:Promise<unknown>=Promise.resolve();
  constructor(readonly root:string){}
  async load(seed:()=>LocalSpeechConfig){
    await mkdir(this.root,{recursive:true});
    try{this.#state=speechSettingsSchema.parse(JSON.parse(await readFile(join(this.root,"speech-settings.json"),"utf8")));}
    catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;const state={revision:0,speech:localSpeechSchema.parse(seed())};await this.write(state);this.#state=state;}
  }
  snapshot(){return speechSettingsSchema.parse(this.#state);}
  private async write(state:SpeechSettings){const tmp=join(this.root,randomUUID()+".tmp");try{await writeFile(tmp,JSON.stringify(state,null,2)+"\n",{flag:"wx",mode:0o600});await rename(tmp,join(this.root,"speech-settings.json"));}finally{await rm(tmp,{force:true});}}
  change(value:unknown,validate:(speech:LocalSpeechConfig)=>void|Promise<void>){
    const command=speechSettingsSchema.parse(value);
    const update=this.#queue.then(async()=>{if(command.revision!==this.#state.revision)throw new SpeechSettingsConflict("Speech settings changed. Reopen before saving.");await validate(command.speech);const state=speechSettingsSchema.parse({...command,revision:command.revision+1});await this.write(state);this.#state=state;return this.snapshot();});
    this.#queue=update.catch(()=>{});return update;
  }
}
