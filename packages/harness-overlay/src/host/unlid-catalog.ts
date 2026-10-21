import {mkdir, readFile, rename, rm, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import type {HubCatalogModel} from "../model-catalog-contract.ts";
import type {UsageCredentials} from "./usage.ts";

const TTL = 6 * 60 * 60 * 1000;
const object = (v: unknown): Record<string, any> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw Error("Invalid Unlid catalogue");
  return v as Record<string, any>;
};
const positive = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0 && v <= 10_000_000;
const price = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/** Project only public model facts. Never cache credentials, account data or transport overrides. */
export function parseUnlidModels(value: unknown): HubCatalogModel[] {
  const data = object(value).data;
  if (!Array.isArray(data) || !data.length || data.length > 4000) throw Error("Invalid Unlid catalogue");
  const models = new Map<string, HubCatalogModel>();
  for (const raw of data) {
    const m = object(raw), u = object(m.unlid);
    if (typeof m.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:/+-]{0,199}$/.test(m.id)
      || typeof u.name !== "string" || !positive(u.context_length)
      || typeof u.available !== "boolean" || typeof u.supports_tools !== "boolean" || typeof u.supports_reasoning !== "boolean") continue;
    const efforts = u.supports_reasoning ? [
      ...(u.can_disable_reasoning === true ? [{id:"off", name:"Off"}] : []),
      ...["minimal", "low", "medium", "high"].map(id => ({id, name:id[0]!.toUpperCase()+id.slice(1)})),
    ] : undefined;
    models.set(m.id, {provider:"unlid", id:m.id, name:u.name.slice(0,240),
      ...(typeof u.description === "string" ? {description:u.description.slice(0,1200)} : {}),
      contextWindow:u.context_length, ...(positive(u.max_output) && u.max_output <= u.context_length ? {maxTokens:u.max_output} : {outputLimitFallback:true}),
      ...(typeof m.created==="number"&&Number.isSafeInteger(m.created)&&m.created>0 ? {created:m.created} : {}),
      // The catalogue does not yet declare image input in a structured field.
      input:["text"], tools:u.supports_tools, reasoning:u.supports_reasoning, available:u.available,
      ...(u.supports_reasoning ? {efforts, effortNote:"Unlid accepts these levels and translates them for the upstream model. Some models use on/off only; effort granularity is not guaranteed."} : {}),
      ...(price(u.pricing?.input_usd_per_m) && price(u.pricing?.output_usd_per_m) ? {pricing:{input:u.pricing.input_usd_per_m, output:u.pricing.output_usd_per_m}} : {}),
      supportedParameters:["max_tokens", "temperature", "top_p", "stop", "response_format", ...(u.supports_tools ? ["tools", "tool_choice"] : []), ...(u.supports_reasoning ? ["reasoning_effort"] : [])],
      defaults:{max_tokens:Math.min(8192, positive(u.max_output)?u.max_output:u.context_length, u.context_length)}, enabled:false, source:"provider"});
  }
  if (!models.size) throw Error("Empty Unlid catalogue");
  return [...models.values()];
}

export class UnlidCatalogStore {
  #at: string | undefined;
  #models: HubCatalogModel[] = [];
  #warning: string | undefined;
  #lastAttempt = 0;
  #flight: Promise<void> | undefined;
  #abort = new AbortController();
  constructor(readonly root: string, readonly credentials: UsageCredentials, readonly fetchImpl = globalThis.fetch) {}
  async load() {
    try {
      const cache = object(JSON.parse(await readFile(join(this.root,"unlid.json"),"utf8")));
      if (!Number.isFinite(Date.parse(cache.at))) throw Error("Invalid cache date");
      this.#models = parseUnlidModels(cache); this.#at = cache.at;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.#warning = "Saved Unlid catalogue unavailable; refresh to recover."; }
  }
  snapshot() { return {models:this.#models, at:this.#at, warning:this.#warning, stale:!this.#at || Date.now()-Date.parse(this.#at)>=TTL}; }
  refresh() {
    if (this.#flight) return this.#flight;
    this.#lastAttempt = Date.now();
    this.#flight = (async () => {
      try {
        const key = (await this.credentials.resolve("UNLID_API_KEY"))?.value.trim();
        if (!key) throw Error("not-configured");
        const response = await this.fetchImpl("https://api.unlid.ai/v1/models", {redirect:"error", headers:{authorization:`Bearer ${key}`, accept:"application/json"}, signal:AbortSignal.any([this.#abort.signal,AbortSignal.timeout(15_000)])});
        if (!response.ok || !response.body) throw Error("unavailable");
        const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
        try {
          while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length;
            if (size > 2*1024*1024) { await reader.cancel(); throw Error("oversized"); } chunks.push(chunk.value); }
        } finally { reader.releaseLock(); }
        const models = parseUnlidModels(JSON.parse(Buffer.concat(chunks).toString("utf8"))), at = new Date().toISOString();
        // Reconstruct a strict, key-free cache instead of persisting the upstream response.
        const cache = {at, data:models.map(m => ({id:m.id,created:m.created,unlid:{name:m.name,description:m.description,context_length:m.contextWindow,max_output:m.maxTokens??null,
          available:m.available,supports_tools:m.tools,supports_reasoning:m.reasoning,can_disable_reasoning:m.efforts?.some(e=>e.id==="off")??false,
          pricing:m.pricing?{input_usd_per_m:m.pricing.input,output_usd_per_m:m.pricing.output}:undefined}}))};
        await mkdir(this.root,{recursive:true,mode:0o700}); const file=join(this.root,"unlid.json"), temp=`${file}.${randomUUID()}.tmp`;
        try { await writeFile(temp,JSON.stringify(cache),{flag:"wx",mode:0o600}); await rename(temp,file); } finally { await rm(temp,{force:true}); }
        this.#models=models; this.#at=at; this.#warning=undefined;
      } catch { this.#warning="Unlid catalogue could not refresh. Check its API key and connection; saved models remain available."; throw Error(this.#warning); }
    })().finally(()=>{this.#flight=undefined;});
    return this.#flight;
  }
  revalidate() { if (this.snapshot().stale && Date.now()-this.#lastAttempt>60_000) void this.refresh().catch(()=>{}); }
  dispose() { this.#abort.abort(); }
}

/** This changes a request's capabilities, never the character's saved tool permissions. */
export function prepareUnlidRequest(options: {provider:string;model:string;tools?:unknown[];system?:string}, models: readonly HubCatalogModel[]) {
  if (options.provider !== "unlid" || models.find(m=>m.id===options.model)?.tools !== false) return;
  options.tools = [];
  options.system = (options.system ? options.system+"\n\n" : "")+"This model endpoint supports conversation only and cannot call tools. Explain that limitation when an action needs a tool. Never claim an action, delegation or memory write was performed.";
}
