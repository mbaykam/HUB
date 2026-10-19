import type { IncomingMessage, ServerResponse } from "node:http";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createVoiceBridgeServer } from "./host/voice-bridge-server.ts";
import { openNativeVoiceSession, validateVoiceModel, type VoiceModelCatalog, type NativeVoiceContext } from "./host/voice-session.ts";
import { startVoiceSidecar, VoiceSidecarCleanupError, type VoiceSubprocess, type VoiceSidecar } from "./host/voice-sidecar.ts";
import { createVoiceWeb } from "./host/voice-web.ts";
import { openConversationHistory, type ConversationStorage } from "./host/conversation-history.ts";
import { parseVoiceIceServers, type VoiceIceServer } from "./voice-ice-contract.ts";
import { attachNativeVoiceTasks } from "./host/voice-tasks.ts";
import type { VoiceModelRoute } from "./host/voice-session.ts";
import type { ToolRuntime } from "@deepseek-ai/dsh-tools";
import { openVoiceProfiles, type VoiceProfileStorage } from "./host/voice-profiles.ts";
import { createVoiceProfilesHandler } from "./host/voice-profiles-web.ts";
import { readLocalSpeechCatalog, validateLocalSpeech } from "./host/local-speech.ts";
import {SpeechSettingsConflict} from "./host/speech-settings.ts";
import { createSpeechModelDownloads, createSpeechModelsHandler } from "./host/speech-model-downloads.ts";
import type { VoiceProfile, LocalSpeechCatalog } from "./voice-profile-contract.ts";
import type { HubCharacters } from "./characters.ts";
import { createVoiceTaskPolicies, type TaskPolicyContext, type TaskPolicyStorage } from "./host/voice-task-policy.ts";
import { createSpeechPreviewHandler } from "./host/speech-preview.ts";
import { voiceTranscript } from "./host/voice-transcript.ts";
import { createPreparedVoiceRuntime } from "./host/voice-runtime.ts";
import {installVoiceTitles} from "./host/voice-titles.ts";
import {prepareVoiceShare} from "./host/voice-media.ts";

export const name = "hub-voice";
export const inject = ["hubCharacters", "llm", "agents", "agentPresets", "tools", "sessionController", "storageDomain", "connection", "webServer", "subprocess"];
export interface Config { python: string; provider: string; model: string; reasoningEffort?: string; iceServers?: VoiceIceServer[]; taskModel?: VoiceModelRoute; telegramCallAccount?: string }
interface Context extends NativeVoiceContext {
  hubCharacters: HubCharacters;
  on: NativeVoiceContext["on"] & TaskPolicyContext["on"];
  agents: NativeVoiceContext["agents"] & TaskPolicyContext["agents"];
  llm: VoiceModelCatalog & {
    listProviders(): { id: string; name: string }[];
    listModels(provider: string): Promise<{ id: string; name: string; provider: string; reasoning?: { efforts: readonly { id: string; name?: string }[] } }[]>;
  };
  tools: Pick<ToolRuntime, "schemas">;
  agentPresets: { standingKeyFor(): Promise<Parameters<ToolRuntime["schemas"]>[0]> };
  subprocess: VoiceSubprocess;
  storageDomain: ConversationStorage & VoiceProfileStorage & TaskPolicyStorage;
  connection: { requestRejection(request: IncomingMessage): 401 | 403 | undefined };
  webServer: { register(route: { kind: "exact"; path: string; handler(request: IncomingMessage, response: ServerResponse): Promise<void> }): () => void };
  effect(callback: () => () => Promise<void>, label: string): unknown;
}

/** Explicit private-profile opt-in. Credentials and desktop model defaults are
 * never copied into this config or the speech process. No live installation is
 * changed simply by shipping the optional plugin entry point.
 */
export function apply(ctx: Context, config: Config): void {
  if (!config.provider?.trim() || !config.model?.trim() || !isAbsolute(config.python ?? "")) throw new Error("Voice requires an absolute Python runtime and explicit native model route");
  const iceServers = parseVoiceIceServers(config.iceServers ?? []);
  const lifetime = new AbortController();
  let history: Awaited<ReturnType<typeof openConversationHistory>> | undefined;
  let offTitles:(()=>void)|undefined;
  let web: ReturnType<typeof createVoiceWeb> | undefined;
  let bridge: Awaited<ReturnType<typeof createVoiceBridgeServer<VoiceProfile>>> | undefined;
  let profiles: Awaited<ReturnType<typeof openVoiceProfiles>> | undefined;
  let profileHandler: ReturnType<typeof createVoiceProfilesHandler> | undefined;
  let cleanupUncertain = false;
  let telegramListener: VoiceSidecar | undefined;
  let preparedRuntime: ReturnType<typeof createPreparedVoiceRuntime> | undefined;
  let telegramState: "disabled" | "starting" | "ready" | "unavailable" = config.telegramCallAccount ? "starting" : "disabled";
  const taskPolicies = createVoiceTaskPolicies(ctx, ctx.storageDomain);
  const presentations = ctx.hubCharacters.presentations;
  let renderer: Promise<string> | undefined;
  let speechFlight: Promise<LocalSpeechCatalog> | undefined;
  let speechCache: { at: number; value: LocalSpeechCatalog } | undefined;
  let speechGeneration = 0;
  const downloads = createSpeechModelDownloads(ctx.subprocess, config.python, fileURLToPath(new URL("../voice/speech_download.py", import.meta.url)), lifetime.signal,
    () => { speechGeneration++; speechCache = undefined; });
  function speechCatalog(fresh = false): Promise<LocalSpeechCatalog> {
    if (cleanupUncertain) return Promise.reject(new Error("Voice runtime requires recovery"));
    if (!fresh && speechCache && Date.now() - speechCache.at < 30000) return Promise.resolve(speechCache.value);
    const generation = speechGeneration;
    speechFlight ??= readLocalSpeechCatalog(ctx.subprocess, config.python, fileURLToPath(new URL("../voice/speech_settings.py", import.meta.url)), lifetime.signal)
      .then(value => { if (generation === speechGeneration) speechCache = { at: Date.now(), value }; return value; })
      .catch(error => { if (error instanceof VoiceSidecarCleanupError) cleanupUncertain = true; throw error; })
      .finally(() => { speechFlight = undefined; });
    return speechFlight.then(value => generation === speechGeneration ? value : speechCatalog(true));
  }
  const startup = (async () => {
    history = await openConversationHistory(ctx.storageDomain);
    if (lifetime.signal.aborted) return;
    offTitles=installVoiceTitles(ctx,history);
    const localProfiles = await openVoiceProfiles(ctx.storageDomain, {
      name: "HUB", instructions: "Be warm, concise and practical. Ask one question at a time.",
      route: { provider: config.provider, model: config.model, ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}) },
      speech: { stt: { engine: "whisper", model: "base.en" }, tts: { engine: "kokoro", model: "82m", voice: "af_heart" } }, tools: { mode: "inherit" },
    });
    profiles = localProfiles;
    if (lifetime.signal.aborted) return;
    const localBridge = await createVoiceBridgeServer<VoiceProfile>((sessionId, profile) => {
      if (!profile) throw new Error("A host-selected voice personality is required");
      return openNativeVoiceSession(ctx, profile.route, {
      sessionId, profile, taskPolicies, created: agent => history!.markVoiceOrigin(agent.session), presentations, history,
      tasks: async agent => {
        const lease = await ctx.hubCharacters.beginVoice(agent, profile);
        try {
          if (!lease.toolName) throw new Error("Choose a configured delegation target for the voice character");
          const off = await attachNativeVoiceTasks(agent, undefined, lease);
          if (!off) throw new Error("Character background delegation is unavailable");
          return async () => { try { await off(); } finally { lease.release(); } };
        } catch (error) { lease.release(); throw error; }
      },
    }); }, { async incoming() {
      if (!web || !telegramListener || lifetime.signal.aborted) throw new Error("Telegram call admission is unavailable");
      const call = await web.openTelegram();
      return { callId: call.callId, speech: call.speech };
    } });
    bridge = localBridge;
    if (lifetime.signal.aborted) { await localBridge.dispose(); return; }
    preparedRuntime = createPreparedVoiceRuntime(ctx.subprocess, { python: config.python,
      script: fileURLToPath(new URL("../voice/runtime_server.py", import.meta.url)),
      bridgeUrl: localBridge.url, bridgeToken: localBridge.token }, lifetime.signal);
    const selectedSpeech = () => {
      return ctx.hubCharacters.speechFor();
    };
    void preparedRuntime.prepare(selectedSpeech()).catch(() => {});
    web = createVoiceWeb({
      history,
      runtimeStatus: () => preparedRuntime?.status() ?? "cold",
      transcript: sessionId => voiceTranscript(ctx.agents.get(sessionId)?.session.snapshotEvents() ?? []),
      presentations: {
        summary: sessionId => presentations.summary(sessionId),
        async document(sessionId, id) {
          renderer ??= readFile(new URL("./presentation-renderer.js", import.meta.url), "utf8");
          return presentations.document(sessionId, id, await renderer);
        },
      },
      reject: request => ctx.connection.requestRejection(request),
      async share(call,requestId,uploads,instruction){
        const text=await prepareVoiceShare(ctx,call.sessionId,uploads,instruction);
        await localBridge.share(call.callId,requestId,text);
      },
      async open(signal, sessionId, transport) {
        if (cleanupUncertain) throw new Error("Voice cleanup requires host recovery");
        // Telegram always keeps its main orchestrator. A spoken companion gets
        // its own native voice conversation while retaining shared HUB memory.
        if (sessionId?.startsWith("minke-im-")) {
          const source = await ctx.sessionController.resolveAgent(sessionId);
          if ("error" in source) throw new Error("Could not resume the selected conversation");
          sessionId = undefined;
        }
        // Capture ONCE before async validation. A concurrent saved-profile edit
        // changes the next call, never this admission or the active native turn.
        const profile = await ctx.hubCharacters.voiceProfile();
        const state = ctx.hubCharacters.store.snapshot();
        await validateVoiceModel(ctx.llm, profile.route, AbortSignal.any([signal, lifetime.signal]));
        validateLocalSpeech(await speechCatalog(), profile.speech);
        signal.throwIfAborted(); lifetime.signal.throwIfAborted();
        const call = await localBridge.open(sessionId, profile);
        try {
          if (transport === "telegram") {
            if (!telegramListener) throw new Error("Telegram call listener is unavailable");
            const listener = telegramListener;
            const sidecar: VoiceSidecar = { done: listener.done, request: (...args) => listener.request(...args),
              async stop() {
                const response = await listener.request("/offer", "POST", { action: "hangup", callId: call.callId });
                if (response.status !== 200) throw new Error("Telegram call shutdown could not be confirmed");
              } };
            return { ...call, sidecar, speech: profile.speech, transport,
              profile: { id: profile.id, name: profile.name, revision: state.revision, speech: profile.speech } };
          }
          const sidecar = await preparedRuntime!.open(call.callId, profile.speech, iceServers, signal);
          return { ...call, sidecar, profile: { id: profile.id, name: profile.name, revision: state.revision, speech: profile.speech }, ...(iceServers.length ? { iceServers } : {}) };
        } catch (error) {
          if (error instanceof VoiceSidecarCleanupError) cleanupUncertain = true;
          await localBridge.closeCall(call.callId);
          throw error;
        }
      },
      async close(call) {
        const results = await Promise.allSettled([call.sidecar.stop(), localBridge.closeCall(call.callId)]);
        if (results.some(result => result.status === "rejected")) throw new Error("Voice cleanup could not be confirmed");
      },
    });
    profileHandler = createVoiceProfilesHandler({
      profiles: localProfiles, reject: request => ctx.connection.requestRejection(request), active: () => web?.activeProfile() ?? null,
      async catalog(provider) {
        const providers = ctx.llm.listProviders().map(item => ({ id: item.id, name: item.name }));
        if (provider !== undefined) {
          if (!providers.some(item => item.id === provider)) throw new Error("Provider is unavailable");
          const models = await ctx.llm.listModels(provider);
          return { models: await Promise.all(models.map(async model => {
            const info = ctx.llm.resolveModelInfo ? await ctx.llm.resolveModelInfo(provider, model.id) : model;
            return { provider: model.provider, id: model.id, name: model.name,
              efforts: info.reasoning?.efforts.map(effort => ({ id: effort.id, name: effort.name ?? effort.id })) ?? [] };
          })) };
        }
        const key = await ctx.agentPresets.standingKeyFor();
        const tools = ctx.tools.schemas(key).map(tool => ({ name: tool.name, description: tool.description.slice(0, 300) }));
        for (const tool of [
          { name: "hub_present", description: "Show visual explanations during voice." },
          { name: "hub_save_conversation", description: "Save this voice conversation to Recents when requested." },
          ...(tools.some(tool => tool.name === "subagent") ? [{ name: "hub_task", description: "Delegate work in the background. Also requires the native subagent tool." }] : []),
        ]) if (!tools.some(item => item.name === tool.name)) tools.push(tool);
        return { providers, tools, speech: await speechCatalog() };
      },
    });
    if (config.telegramCallAccount) {
      if (!isAbsolute(config.telegramCallAccount)) throw new Error("Telegram call account path must be absolute");
      try {
        telegramListener = await startVoiceSidecar(ctx.subprocess, { python: config.python,
          script: fileURLToPath(new URL("../voice/telegram_calls.py", import.meta.url)),
          bridgeUrl: localBridge.url, bridgeToken: localBridge.token, callId: randomUUID(),
          telegramAccount: config.telegramCallAccount,
          speech: selectedSpeech(),
        }, lifetime.signal, { startupMs: 60000 });
        const warmed = await telegramListener.request("/prepare", "POST", { speech: selectedSpeech() });
        if (warmed.status !== 200 || warmed.body.ok !== true) throw new Error("Telegram speech models could not prepare");
        telegramState = "ready";
        void telegramListener.done.finally(() => { telegramState = "unavailable"; }).catch(() => {});
      } catch { telegramState = "unavailable"; }
    }
  })();
  // Keep startup rejection handled even if no browser ever opens voice.
  void startup.catch(() => {});
  const off = ["open", "close", "offer", "status", "diagnostics", "history", "presentation", "presentation-document", "interrupt", "share"].map(action => ctx.webServer.register({ kind: "exact", path: `/api/hub/voice/${action}`,
    async handler(request, response) {
      const rejection = ctx.connection.requestRejection(request);
      if (rejection || request.headers["sec-fetch-site"] === "cross-site" || !web || lifetime.signal.aborted || cleanupUncertain) {
        response.writeHead(rejection ?? (request.headers["sec-fetch-site"] === "cross-site" ? 403 : 503), { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify({ error: rejection ? "unauthorized" : "voice-unavailable" })); return;
      }
      await web.handler(request, response);
    },
  }));
  for (const action of ["profiles", "catalog"]) off.push(ctx.webServer.register({ kind: "exact", path: `/api/hub/voice/${action}`, async handler(request, response) {
    if (!profileHandler || lifetime.signal.aborted || cleanupUncertain) { response.writeHead(503, { "cache-control": "no-store" }); response.end(); return; }
    await profileHandler(request, response);
  } }));
  off.push(ctx.webServer.register({kind:"exact",path:"/api/hub/voice/settings",async handler(req,res){
    const send=(code:number,value:unknown)=>{res.writeHead(code,{"content-type":"application/json","cache-control":"no-store","x-content-type-options":"nosniff"});res.end(JSON.stringify(value));};
    const rejection=ctx.connection.requestRejection(req);
    if(rejection||req.headers["sec-fetch-site"]==="cross-site"||req.headers["x-hub-speech-settings"]!=="1"){send(rejection??403,{error:"unauthorized"});return;}
    try{
      await ctx.hubCharacters.ready;
      if(req.method==="GET"){send(200,ctx.hubCharacters.speechSettings.snapshot());return;}
      if(req.method!=="POST"){send(405,{error:"method-not-allowed"});return;}
      if(!/^application\/json(?:;|$)/i.test(String(req.headers["content-type"]??""))){send(415,{error:"json-required"});return;}
      let size=0;const chunks:Buffer[]=[];for await(const chunk of req){size+=chunk.length;if(size>16000){send(413,{error:"body-too-large"});return;}chunks.push(chunk);}
      const saved=await ctx.hubCharacters.speechSettings.change(JSON.parse(Buffer.concat(chunks).toString("utf8")),async speech=>validateLocalSpeech(await speechCatalog(true),speech));
      send(200,saved);
    }catch(e){send(e instanceof SpeechSettingsConflict?409:400,{error:e instanceof SpeechSettingsConflict?"revision-conflict":"invalid-speech-settings"});}
  }}));
  off.push(ctx.webServer.register({ kind: "exact", path: "/api/hub/voice/speech-models",
    handler: createSpeechModelsHandler(downloads, request => ctx.connection.requestRejection(request)),
  }));
  const speechPreviews = createSpeechPreviewHandler({
    subprocess: ctx.subprocess, python: config.python, script: fileURLToPath(new URL("../voice/speech_preview.py", import.meta.url)),
    signal: lifetime.signal, reject: request => ctx.connection.requestRejection(request), catalog: () => speechCatalog(),
  });
  off.push(ctx.webServer.register({ kind: "exact", path: "/api/hub/voice/preview", handler: speechPreviews }));
  const prepareSamples = () => { if (!lifetime.signal.aborted && web && !web.isBusy()) void speechPreviews.prepare().catch(() => {}); };
  void startup.then(prepareSamples).catch(() => {});
  const sampleTimer = setInterval(prepareSamples, 60000); sampleTimer.unref();
  off.push(() => clearInterval(sampleTimer));
  off.push(ctx.webServer.register({ kind: "exact", path: "/api/hub/voice/telegram-calls", async handler(request, response) {
    const rejected = ctx.connection.requestRejection(request);
    response.writeHead(rejected ?? (request.headers["sec-fetch-site"] === "cross-site" ? 403 : request.method === "GET" ? 200 : 405), { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify(rejected || request.headers["sec-fetch-site"] === "cross-site" ? { error: "unauthorized" } : { state: telegramState, incomingOnly: true }));
  } }));
  off.push(ctx.webServer.register({ kind: "exact", path: "/api/hub/voice/client.js", async handler(request, response) {
    const rejection = ctx.connection.requestRejection(request);
    if (rejection || request.headers["sec-fetch-site"] === "cross-site") { response.writeHead(rejection ?? 403); response.end(); return; }
    if (request.method !== "GET") { response.writeHead(405); response.end(); return; }
    try {
      // Fixed build artifact only; no browser-controlled file path or vendor
      // bundle in the PWA startup module. Authentication also protects this URL.
      const asset = await readFile(new URL("./voice-browser.js", import.meta.url));
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "private, no-cache", "x-content-type-options": "nosniff" });
      response.end(asset);
    } catch { response.writeHead(503); response.end(); }
  } }));
  ctx.effect(() => async () => {
    off.forEach(remove => remove()); offTitles?.(); lifetime.abort();
    await startup.catch(() => {});
    try { await web?.dispose(); }
    finally { try { await preparedRuntime?.close(); } finally { try { await telegramListener?.stop(); } finally { try { await bridge?.dispose(); } finally { await downloads.close(); await speechFlight?.catch(() => {}); try { await taskPolicies.close(); } finally { await profiles?.close(); await history?.close(); } } } } }
  }, "hub-voice lifetime");
}
