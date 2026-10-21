import { readFile, mkdir, writeFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import type { HubCatalogModel } from "../model-catalog-contract.ts";
import {openRouterReasoning} from "./openrouter-capabilities.ts";

const TTL = 6 * 60 * 60 * 1000;
const MAX_BYTES = 8 * 1024 * 1024;
function record(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid catalogue");
  return value as Record<string, any>;
}
const positive = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n > 0;
const safeId = (id: unknown): id is string => typeof id === "string" && id.length <= 200 && /^[a-zA-Z0-9][a-zA-Z0-9._:/+-]*$/.test(id);
export function parseOpenRouterModels(value: unknown): HubCatalogModel[] {
  const data = record(value).data;
  if (!Array.isArray(data) || data.length > 4000) throw new Error("Invalid catalogue");
  const result = new Map<string, HubCatalogModel>();
  for (const raw of data) {
    const m = record(raw);
    if (!safeId(m.id) || typeof m.name !== "string" || !positive(m.context_length)) continue;
    const architecture = record(m.architecture ?? {});
    if (Array.isArray(architecture.output_modalities) && !architecture.output_modalities.includes("text")) continue;
    const params: string[] = Array.isArray(m.supported_parameters) ? [...new Set<string>(m.supported_parameters.filter((x: unknown) => typeof x === "string"&&/^[a-z][a-z0-9_]{0,79}$/.test(x)).slice(0,100))] : [];
    const defaults=Object.fromEntries(Object.entries(m.default_parameters??{}).filter(([k,v])=>params.includes(k)&&(v===null||typeof v==="boolean"||typeof v==="number"&&Number.isFinite(v)||typeof v==="string"&&v.length<200))) as Record<string,number|string|boolean|null>;
    const prompt = Number(m.pricing?.prompt), completion = Number(m.pricing?.completion);
    result.set(m.id, { provider: "openrouter", id: m.id, name: m.name.slice(0, 240),
      description: typeof m.description === "string" ? m.description.slice(0, 1200) : undefined,
      contextWindow: m.context_length, ...(positive(m.top_provider?.max_completion_tokens) ? { maxTokens: m.top_provider.max_completion_tokens } : {}),
      ...(positive(m.created) ? { created: m.created } : {}),
      input: Array.isArray(architecture.input_modalities) ? architecture.input_modalities.filter((x: unknown) => ["text", "image", "audio", "file"].includes(String(x))) : ["text"],
      tools: params.includes("tools"), reasoning: params.includes("reasoning")||params.includes("reasoning_effort"),supportedParameters:params,defaults,
      ...openRouterReasoning(m.reasoning),
      ...(m.pricing?.prompt != null && m.pricing?.completion != null && Number.isFinite(prompt) && prompt >= 0 && Number.isFinite(completion) && completion >= 0 ? { pricing: { input: prompt * 1e6, output: completion * 1e6 } } : {}),
      enabled: false, source: "provider" });
  }
  if (!result.size) throw new Error("Empty catalogue");
  return [...result.values()];
}
/** Accept data only for the existing Codex transport; never downloaded code/endpoints. */
export function parseCodexModelData(value: unknown): Record<string, any>[] {
  const entries = Object.values(record(record(value)["openai-codex-responses"]));
  if (!entries.length || entries.length > 100) throw new Error("Invalid Codex catalogue");
  const ids = new Set<string>();
  return entries.map(raw => {
    const m = record(raw);
    if (!safeId(m.id) || !m.id.startsWith("gpt-") || ids.has(m.id) || m.provider !== "openai-codex" || m.api !== "openai-codex-responses"
      || m.baseUrl !== "https://chatgpt.com/backend-api" || !positive(m.contextWindow) || m.contextWindow > 10_000_000
      || !positive(m.maxTokens) || m.maxTokens > m.contextWindow || typeof m.name !== "string" || typeof m.reasoning !== "boolean"
      || !Array.isArray(m.input) || m.input.some((x: unknown) => x !== "text" && x !== "image")) throw new Error("Incompatible Codex catalogue");
    ids.add(m.id);
    const thinking: Record<string, string | null> = {};
    for (const [key, level] of Object.entries(record(m.thinkingLevelMap ?? {}))) {
      if (!/^[a-z][a-z0-9_-]{0,39}$/.test(key) || (level !== null && (typeof level !== "string"||level.length>80))) throw new Error("Incompatible reasoning catalogue");
      thinking[key] = level as string | null;
    }
    // No arbitrary headers/auth/transport URLs or executable compatibility fields.
    return { id: m.id, name: m.name.slice(0, 240), api: m.api, provider: m.provider, baseUrl: m.baseUrl,
      contextWindow: m.contextWindow, maxTokens: m.maxTokens, reasoning: m.reasoning, input: [...m.input],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, thinkingLevelMap: thinking };
  });
}
export function extractCodexTarData(bytes: Buffer): unknown {
  const tar = gunzipSync(bytes, { maxOutputLength: 32 * 1024 * 1024 });
  const path = "package/dist/providers/data/openai-codex.json";
  for (let offset = 0; offset + 512 <= tar.length;) {
    const name = tar.subarray(offset, offset + 100).toString("utf8").replace(/\0.*$/, "");
    const size = parseInt(tar.subarray(offset + 124, offset + 136).toString("ascii").replace(/\0.*$/, "").trim(), 8);
    if (!name) break;
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length) throw new Error("Invalid catalogue archive");
    if (name === path && ["0", "\0"].includes(tar.subarray(offset + 156, offset + 157).toString())) {
      if (size > 256_000) throw new Error("Oversized catalogue");
      return JSON.parse(tar.subarray(offset + 512, offset + 512 + size).toString("utf8"));
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error("Missing catalogue data");
}
async function bounded(response: Response): Promise<Buffer> {
  if (!response.ok || !response.body) throw new Error("Catalogue request failed");
  const chunks: Uint8Array[] = []; let length = 0;
  for await (const chunk of response.body as any) { length += chunk.length; if (length > MAX_BYTES) { await response.body.cancel().catch(() => {}); throw new Error("Catalogue too large"); } chunks.push(chunk); }
  return Buffer.concat(chunks);
}
async function atomic(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}
export class ModelCatalogStore {
  #favoriteQueue: Promise<unknown> = Promise.resolve();
  #flight: Promise<void> | undefined;
  #snapshot: { at: string; openrouter: HubCatalogModel[]; codex: Record<string, any>[] } | undefined;
  #loaded = false;
  #warning: string | undefined;
  #lastAttempt = 0;
  #legacyReasoning=false;
  readonly #abort = new AbortController();
  readonly root: string;
  readonly fetchImpl: typeof globalThis.fetch;
  constructor(root: string, fetchImpl = globalThis.fetch) { this.root = root; this.fetchImpl = fetchImpl; }
  async load() {
    if (this.#loaded) return;
    this.#loaded = true;
    try {
      const s = record(JSON.parse(await readFile(join(this.root, "catalog.json"), "utf8")));
      if (!Number.isFinite(Date.parse(s.at))) throw new Error("Invalid cache");
      const openrouter = parseOpenRouterModels({ data: s.openrouter });
      const codex = parseCodexModelData({ "openai-codex-responses": Object.fromEntries(s.codex.map((x: any) => [x.id, x])) });
      this.#snapshot = { at: s.at, openrouter, codex };
      this.#legacyReasoning=s.schemaVersion!==2;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.#warning = "Saved catalogue unavailable; refresh to recover."; }
  }
  snapshot() { return { ...this.#snapshot, warning: this.#warning, stale: this.#legacyReasoning||!this.#snapshot || Date.now() - Date.parse(this.#snapshot.at) >= TTL }; }
  async favorites(): Promise<Set<string>> {
    try {
      const data = record(JSON.parse(await readFile(join(this.root, "favorites.json"), "utf8")));
      if (data.version !== 1 || !Array.isArray(data.entries) || data.entries.length > 2000 || data.entries.some((x: unknown) => typeof x !== "string" || x.length > 500)) throw new Error("Invalid favorites");
      return new Set(data.entries);
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set(); throw error; }
  }
  favorite(provider: string, model: string, selected: boolean) {
    const operation = this.#favoriteQueue.then(async () => {
      const entries = await this.favorites(), key = JSON.stringify([provider, model]);
      if (selected) entries.add(key); else entries.delete(key);
      if (entries.size > 2000) throw new Error("Favorites full");
      await atomic(join(this.root, "favorites.json"), { version: 1, entries: [...entries] });
    });
    this.#favoriteQueue = operation.catch(() => {}); return operation;
  }
  async refresh() {
    if (this.#flight) return this.#flight;
    this.#lastAttempt = Date.now();
    this.#flight = (async () => {
      try {
        const signal = AbortSignal.any([this.#abort.signal, AbortSignal.timeout(30_000)]);
        const openrouter = parseOpenRouterModels(JSON.parse((await bounded(await this.fetchImpl("https://openrouter.ai/api/v1/models", { signal, redirect: "error" }))).toString("utf8")));
        const meta = record(JSON.parse((await bounded(await this.fetchImpl("https://registry.npmjs.org/@earendil-works/pi-ai/latest", { signal, redirect: "error" }))).toString("utf8")));
        const dist = record(meta.dist), url = new URL(String(dist.tarball));
        if (url.protocol !== "https:" || url.hostname !== "registry.npmjs.org" || url.username || url.password || !/^sha512-[A-Za-z0-9+/]+=*$/.test(String(dist.integrity))) throw new Error("Invalid catalogue origin");
        const archive = await bounded(await this.fetchImpl(url.href, { signal, redirect: "error" }));
        if (`sha512-${createHash("sha512").update(archive).digest("base64")}` !== dist.integrity) throw new Error("Catalogue checksum mismatch");
        const codex = parseCodexModelData(extractCodexTarData(archive));
        const at = new Date().toISOString();
        // Preserve the exact provider response for strict cache parsing.
        const data = { schemaVersion:2,at, openrouter: openrouter.map(m => ({ id: m.id, name: m.name, description: m.description, context_length: m.contextWindow,
          created: m.created, architecture: { input_modalities: m.input, output_modalities: ["text"] }, top_provider: { max_completion_tokens: m.maxTokens },
          supported_parameters: m.supportedParameters??[],default_parameters:m.defaults??{},reasoning:m.reasoningConfig,
          ...(m.pricing ? { pricing: { prompt: String(m.pricing.input / 1e6), completion: String(m.pricing.output / 1e6) } } : {}) })), codex };
        await atomic(join(this.root, "codex-models.json"), { version: 1, models: codex });
        await atomic(join(this.root, "catalog.json"), data);
        this.#snapshot = { at, openrouter, codex }; this.#warning = undefined;this.#legacyReasoning=false;
      } catch { this.#warning = "Refresh failed. The last saved catalogue and installed models remain available."; throw new Error(this.#warning); }
    })().finally(() => { this.#flight = undefined; });
    return this.#flight;
  }
  revalidate() { if (this.snapshot().stale && Date.now() - this.#lastAttempt > 60_000) void this.refresh().catch(() => {}); }
  dispose() { this.#abort.abort(); }
}
