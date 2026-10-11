import { defineOverlayStyle } from "../shared/style-runtime.ts";
import { pwaUiAsset } from "./mobile-ui-update.ts";
import styles from "./mobile-hubs.css";
const installStyles = defineOverlayStyle("hub-mobile-hubs", styles);
import type { HarnessClientContext } from "../core/context.ts";
import type { createVoiceClient, VoiceState } from "../voice/browser-client.ts";
import { createMobileActivity, createActivitySignals, type ActivityPendingSource } from "./mobile-activity.ts";
import { returnToMobileHome } from "./mobile-home-navigation.ts";
import { openMobileConversation } from "./mobile-session-navigation.ts";
import { createMobileBrowserView } from "./mobile-browser-view.ts";
import { createMobilePresentation } from "./mobile-presentation.ts";
import { createMobileLiveTranscript } from "./mobile-live-transcript.ts";

/** PWA-owned view layer. The native conversation, attachments, approvals and
 * workspace controls stay mounted; the audio owner survives Home/chat changes.
 */
export function installMobileHubs(ctx: HarnessClientContext, root: Document = document): () => void {
  const view = root.defaultView;
  if (!view) return () => {};
  const lifetime = new AbortController();
  const audio = root.createElement("audio"); audio.autoplay = true;
  audio.setAttribute("playsinline", "");
  const removeStyles = installStyles(root);
  const nav = root.createElement("div"); nav.setAttribute("data-hub-home-nav", "");
  const intro = root.createElement("header"); intro.setAttribute("data-hub-home-intro", "");
  const welcome = root.createElement("h1"); welcome.textContent = "What’s on your mind?";
  const invitation = root.createElement("p"); invitation.textContent = "Conversation for voice. HUB for messages. Ask either assistant to bring in a specialist.";
  intro.append(welcome, invitation);
  const textHeading = root.createElement("div"); textHeading.setAttribute("data-hub-text-heading", "");
  const textLabel = root.createElement("span"); textLabel.textContent = "Write to HUB";
  const options = root.createElement("button"); options.type = "button"; options.textContent = "Chat options"; options.setAttribute("aria-expanded", "false");
  textHeading.append(textLabel, options);
  let optionsOpen = false;
  options.addEventListener("click", () => { optionsOpen = !optionsOpen; render(); });
  const home = root.createElement("button"); home.type = "button"; home.textContent = "‹ Home";
  home.addEventListener("click", () => returnToMobileHome(ctx)); nav.append(home);
  const hub = root.createElement("section"); hub.setAttribute("data-hub-voice-hub", ""); hub.setAttribute("aria-label", "Voice hub");
  const start = root.createElement("button"); start.type = "button"; start.setAttribute("data-voice-start", "");
  const voiceLabel = root.createElement("span"); voiceLabel.setAttribute("data-voice-kicker", ""); voiceLabel.textContent = "Speak";
  const voiceGlyph = root.createElement("span"); voiceGlyph.setAttribute("data-voice-glyph", ""); voiceGlyph.setAttribute("aria-hidden", "true");
  for (let index = 0; index < 5; index++) voiceGlyph.append(root.createElement("i"));
  const title = root.createElement("strong"); title.textContent = "Talk to Conversation";
  const hint = root.createElement("span"); hint.textContent = "Quick conversation · delegates complex work to HUB";
  start.append(voiceLabel, title, hint, voiceGlyph);
  const controls = root.createElement("div"); controls.setAttribute("data-voice-controls", "");
  const status = root.createElement("span"); status.setAttribute("role", "status");
  const mute = root.createElement("button"); mute.type = "button"; mute.textContent = "Mute";
  const end = root.createElement("button"); end.type = "button"; end.textContent = "End voice"; end.setAttribute("data-voice-end", "");
  const interrupt = root.createElement("button"); interrupt.type = "button"; interrupt.textContent = "Interrupt"; interrupt.setAttribute("data-voice-interrupt", ""); interrupt.hidden = true;
  const openCall = root.createElement("button"); openCall.type = "button"; openCall.textContent = "Open chat ↗"; openCall.setAttribute("aria-label", "Open live conversation"); openCall.setAttribute("data-voice-open-chat", ""); openCall.hidden = true;
  openCall.addEventListener("click", async () => {
    const id = voiceSession;
    if (!id) return;
    openCall.disabled = true;
    try {
      await openMobileConversation(ctx.sessions, id);
    } catch { error.textContent = "The conversation could not open. Your call is still connected; try again."; }
    finally { openCall.disabled = false; }
  });
  const actions = root.createElement("div"); actions.setAttribute("data-voice-actions", ""); actions.append(mute, interrupt, end);
  controls.append(status, openCall, actions);
  const writeHub = root.createElement("button"); writeHub.type = "button"; writeHub.textContent = "Back to voice";
  writeHub.addEventListener("click", () => returnToMobileHome(ctx));
  const error = root.createElement("p"); error.setAttribute("data-voice-error", ""); error.setAttribute("role", "status");
  const liveVoice=root.createElement("section");liveVoice.setAttribute("data-voice-now","");liveVoice.setAttribute("aria-label","Live voice");
  const orb=root.createElement("div");orb.setAttribute("data-voice-orb","");orb.setAttribute("aria-hidden","true");
  const liveLabel=root.createElement("strong"),liveWords=root.createElement("p");liveWords.setAttribute("data-voice-live-words","");liveWords.textContent="Speak naturally in English or Turkish.";liveVoice.append(orb,liveLabel,liveWords);
  liveLabel.setAttribute("role", "status"); liveLabel.setAttribute("aria-live", "polite");
  const play = root.createElement("button"); play.type = "button"; play.textContent = "Tap to hear audio"; play.hidden = true;
  const transcript = createMobileLiveTranscript(root);
  hub.append(start, controls,liveVoice, transcript.panel, writeHub, play, error); root.body.append(audio);
  const activity = createMobileActivity(root, id => {
    void openMobileConversation(ctx.sessions, id).catch(() => {
      error.textContent = "Couldn’t open this task’s conversation. Try again; your voice call is still connected.";
    });
  });
  const browser = createMobileBrowserView(root);
  const presentation = createMobilePresentation(root); hub.append(presentation.button);
  let voice: ReturnType<typeof createVoiceClient> | undefined;
  let voiceSession: string | undefined;
  let state: VoiceState = "idle", enabled = false, muted = false, loading = false, cancelledLoad = false,audioStage="listening";
  let inputPaused = false;
  let receivingAudio: boolean | undefined;
  let audioConnection: string | undefined;
  let external: { callId: string; sessionId: string; profile?: { name: string } } | undefined, externalTranscriptKey = "", statusFlight = false,lastStatusAt=0;
  let frame: number | undefined;
  let conversation: HTMLElement | undefined;
  const activitySignals = createActivitySignals(ctx.sessions, schedule);
  let pendingSource: ActivityPendingSource | undefined;
  ctx.inject?.(["uiSession"], scope => {
    scope.effect(() => {
      const service = scope.get("uiSession") as { pendingInteractions?: ActivityPendingSource };
      pendingSource = service.pendingInteractions;
      const off = pendingSource?.subscribe(schedule); schedule();
      return () => { off?.(); pendingSource = undefined; };
    }, "hub: observed task interactions");
  });
  const active = () => !!external || loading || !["idle", "error"].includes(state);
  const isHome = () => ctx.sessions.list.getSnapshot().current === undefined || conversation?.getAttribute("data-phase") === "hero";
  function render() {
    if (lifetime.signal.aborted) return;
    const inHome = isHome();
    const busy = active();
    const viewingCall = busy && !inHome && !!voiceSession && ctx.sessions.list.getSnapshot().current === voiceSession;
    writeHub.hidden = !viewingCall;
    conversation?.toggleAttribute("data-hub-voice-chat", viewingCall);
    conversation?.toggleAttribute("data-hub-voice-active", busy);
    intro.hidden = !inHome || busy;
    textHeading.hidden = !inHome || busy;
    options.hidden = !conversation?.querySelector('[data-hub-chat-options]');
    options.setAttribute("aria-expanded", String(optionsOpen));
    conversation?.toggleAttribute("data-hub-options-open", optionsOpen);
    conversation?.toggleAttribute("data-hub-home", inHome);
    hub.setAttribute("data-voice-state", loading ? "starting" : state);
    hub.toggleAttribute("data-external-call", !!external);
    hub.toggleAttribute("data-home", inHome);
    hub.removeAttribute("data-shared");
    hub.hidden = !inHome && !busy;
    nav.hidden = inHome;
    activity.panel.hidden = !inHome;
    const nativeSessions = ctx.sessions.list.getSnapshot();
    browser.update(inHome && root.querySelector("[data-minke-mobile-web]") !== null && view!.innerWidth <= 1024, new Map(Object.entries(nativeSessions.byId).filter(([, session]) => session !== undefined).map(([id, session]) => [id, session?.displayTitle ?? session?.title ?? "Task"])), voiceSession);
    activity.update({ ...nativeSessions, observations: activitySignals.read(nativeSessions), pendingBySession: pendingSource?.getSnapshot() }, voiceSession, ctx.connection?.state ? ctx.connection.state.getSnapshot() ?? "connecting" : "connected");
    start.hidden = busy; start.disabled = !enabled || loading;
    controls.hidden = !busy;
    liveVoice.hidden=!busy;liveLabel.textContent=loading||["microphone","starting","connecting"].includes(state)?"Preparing voice…":state==="ending"?"Ending voice…":audioConnection==="connecting"?"Connecting audio…":muted&&!external?"Microphone muted":audioStage==="echo-tail"?"Resuming listening…":state==="speaking"?"Speaking":state==="thinking"?"Preparing a reply…":audioStage==="transcribing"?"Understanding your words…":receivingAudio===false?"Audio hasn’t reached HUB yet":"Listening to you";
    mute.hidden = !!external; openCall.hidden = !voiceSession || viewingCall;
    interrupt.hidden = !busy || audioStage === "echo-tail" || !(state === "speaking" || state === "thinking");
    transcript.panel.hidden = !busy || !inHome;
    conversation?.removeAttribute("data-hub-shared-input");
    status.textContent = external ? `Telegram · ${external.profile?.name ?? "Conversation"}` : hub.getAttribute("data-active-character") ?? "Conversation";
    mute.disabled = loading || ["microphone", "starting", "connecting", "ending"].includes(state);
    mute.textContent = muted ? "Unmute" : "Mute"; mute.setAttribute("aria-pressed", String(muted));
  }
  function reconcile() {
    frame = undefined;
    const mobile = root.querySelector("[data-minke-mobile-web]") !== null && view!.innerWidth <= 1024;
    // A running PWA call must retain End/Mute controls through a resize.
    const next = mobile || active() ? root.querySelector<HTMLElement>('[data-slot="conversation"] [data-phase]') : null;
    const seat = next?.querySelector<HTMLElement>("[data-composer-seat]");
    if (!next || !seat) { hub.remove(); intro.remove(); textHeading.remove(); nav.remove(); activity.panel.remove(); browser.panel.remove(); browser.update(false, new Map()); clearConversation(); conversation = undefined; return; }
    if (conversation !== next) { clearConversation(); conversation = next; }
    if (nav.parentElement !== next) next.prepend(nav);
    const stack = seat.querySelector('[data-slot="conversation.composer.bar"]')?.parentElement ?? seat;
    stack.setAttribute("data-hub-composer-stack", "");
    if (hub.parentElement !== stack) stack.prepend(hub);
    if (intro.parentElement !== stack) stack.prepend(intro);
    const nativeBar = seat.querySelector('[data-slot="conversation.composer.bar"]');
    if (nativeBar && textHeading.parentElement !== stack) stack.insertBefore(textHeading, nativeBar);
    const nativeOptions = stack.querySelector('[data-slot="conversation.hero.agentPreset"]')?.parentElement;
    if (nativeOptions && nativeOptions !== stack) nativeOptions.setAttribute("data-hub-chat-options", "");
    if (activity.panel.parentElement !== stack) stack.append(activity.panel);
    if (browser.panel.parentElement !== stack) stack.append(browser.panel);
    render();
  }
  function clearConversation() {
    for (const name of ["data-hub-shared-input", "data-hub-voice-chat", "data-hub-voice-active", "data-hub-home", "data-hub-options-open"]) conversation?.removeAttribute(name);
    for (const node of conversation?.querySelectorAll('[data-hub-composer-stack],[data-hub-chat-options]') ?? []) { node.removeAttribute("data-hub-composer-stack"); node.removeAttribute("data-hub-chat-options"); }
  }
  function schedule() { if (!lifetime.signal.aborted && frame === undefined) frame = view!.requestAnimationFrame(reconcile); }
  const observer = new view.MutationObserver(records => {
    if (records.some(record => !hub.contains(record.target) && !intro.contains(record.target) && !textHeading.contains(record.target) && !nav.contains(record.target) && !activity.panel.contains(record.target) && !browser.panel.contains(record.target) && !browser.dialog.contains(record.target) && !(record.target instanceof Element && record.target.closest('[data-hub-characters]')) && !presentation.dialog.contains(record.target))) schedule();
  });
  // Avoid observing our own changing text/controls; only seat replacement and
  // native phase/viewport changes schedule a reconciliation.
  observer.observe(root.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-phase", "data-minke-mobile-web"] });
  const unsubscribe = ctx.sessions.list.subscribe(schedule);
  const unsubscribeConnection = ctx.connection?.state?.subscribe(schedule);
  // Expire finished jobs even when their native snapshots stop changing.
  // This is a local render tick, not another host polling loop.
  const refreshTime = view.setInterval(() => { if (!root.hidden && isHome()) schedule(); }, 60_000);
  start.addEventListener("click", async () => {
    if (active()) return;
    transcript.reset();
    liveWords.textContent="Speak naturally in English or Turkish.";liveWords.removeAttribute("data-interim");audioStage="listening";inputPaused=false;receivingAudio=undefined;audioConnection=undefined;
    loading = true; cancelledLoad = false; muted = false; error.textContent = ""; render();
    try {
      if (!voice) {
        const endpoint = pwaUiAsset(root, "voice-browser.js", "/api/hub/voice/client.js");
        const module = await import(/* @vite-ignore */ endpoint) as { createVoiceClient: typeof createVoiceClient };
        if (lifetime.signal.aborted || cancelledLoad) return;
        voice = module.createVoiceClient({ audio,
          onState(value) { state = value; if (value === "idle") { transcript.reset(); root.dispatchEvent(new CustomEvent("hub:voice-history-changed")); voiceSession = undefined; muted = false; play.hidden = true; schedule(); } render(); },
          onSession(id) { voiceSession = id; void ctx.sessions.refresh?.().catch(() => {}); root.dispatchEvent(new CustomEvent("hub:voice-history-changed")); render(); },
          onCall(id) { presentation.setCall(id); },
          onProfile(profile) { if(profile){hub.setAttribute("data-active-character", profile.name); title.textContent = profile.name;transcript.setAssistant(profile.name);}else{hub.removeAttribute("data-active-character");} render(); },
          onTranscript(role, text, final) { transcript.update(role, text, final);if(role==="user"){liveWords.textContent=text;liveWords.toggleAttribute("data-interim",!final);} },
          onActivity(event) {
            root.dispatchEvent(new CustomEvent("hub:voice-activity", { detail: { sessionId: voiceSession, event } }));
            // Tool results arrive after native durability. Invalidate rather
            // than guessing promotion from a tool name or spoken claim.
            if ((event as { type?: string } | null)?.type === "tool-end") root.dispatchEvent(new CustomEvent("hub:voice-history-changed"));
          },
          onAudioBlocked() { play.hidden = false; },
          onError(message) { error.textContent = message; },
          onNotice(message) { error.textContent = message; },
        });
      }
      // Voice owns a Conversation session; opening a text chat never changes it.
      loading = false; await voice.start();
    } catch { if (!error.textContent) error.textContent = "Couldn’t start voice. Please try again."; }
    finally { loading = false; render(); }
  });
  end.addEventListener("click", () => {
    cancelledLoad = true;
    if (external) {
      end.disabled = true;
      void view.fetch("/api/hub/voice/close", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ callId: external.callId }), signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(15000)]) })
        .then(response => { if (!response.ok) throw new Error(); })
        .catch(() => { error.textContent = "Couldn’t confirm the hangup. You can end the call in Telegram."; })
        .finally(() => { end.disabled = false; void checkStatus(); });
    } else void voice?.stop();
  });
  mute.addEventListener("click", () => { muted = !muted; voice?.mute(muted); render(); });
  interrupt.addEventListener("click", async () => {
    interrupt.disabled = true;
    try {
      if (external) {
        const response = await view!.fetch("/api/hub/voice/interrupt", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ callId: external.callId }), signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(10000)]) });
        if (!response.ok) throw new Error();
      } else await voice?.interrupt();
    } catch { error.textContent = "Couldn’t interrupt the reply. Your call is still connected."; }
    finally { interrupt.disabled = false; void checkStatus(); }
  });
  play.addEventListener("click", () => { play.hidden = true; void voice?.play(); });
  view.addEventListener("resize", schedule); schedule();
  async function checkStatus() {
    if (statusFlight || root.hidden || lifetime.signal.aborted) return;
    statusFlight = true;
    lastStatusAt=Date.now();
    try {
      const response = await view!.fetch("/api/hub/voice/status", { credentials: "same-origin", cache: "no-store", signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(10000)]) });
      if (!response.ok) throw new Error();
      const value = await response.json(); enabled = value.enabled === true;
      const call = value.externalCall;
      if (call?.transport === "telegram" && typeof call.callId === "string" && typeof call.sessionId === "string") {
        if (!external || external.callId !== call.callId) { transcript.reset(); externalTranscriptKey = ""; }
        external = call; voiceSession = call.sessionId; state = "listening";
        transcript.setAssistant(call.profile?.name ?? "Conversation");
        presentation.setCall(call.callId); hub.setAttribute("data-active-character", call.profile?.name ?? "Conversation");
        const lines = Array.isArray(call.transcript) ? call.transcript.filter((line: any) => ["user", "assistant"].includes(line?.role) && typeof line.text === "string" && typeof line.final === "boolean").slice(-60) : [];
        const next = JSON.stringify(lines); if (next !== externalTranscriptKey) { externalTranscriptKey = next; transcript.snapshot(lines); const spoken = lines.findLast((line: any) => line.role === "user"); if(spoken){liveWords.textContent=spoken.text;liveWords.removeAttribute("data-interim");} }
      } else if (external) {
        external = undefined; externalTranscriptKey = ""; voiceSession = undefined; state = "idle";
        transcript.reset(); presentation.setCall(undefined); hub.removeAttribute("data-active-character"); root.dispatchEvent(new CustomEvent("hub:voice-history-changed"));
      }
      hint.textContent = enabled ? "Quick conversation · delegates complex work to HUB" : "Voice isn’t enabled on this host yet"; schedule();
      if (active() && !loading && !["microphone", "starting", "ending"].includes(state)) {
        const response = await view!.fetch("/api/hub/voice/diagnostics", { credentials: "same-origin", cache: "no-store", signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(10000)]) });
        if (response.ok) {
          const diagnostics = await response.json(), audioState = diagnostics.audio;
          if (diagnostics.active && audioState) {
            const inputLevel = Math.min(1, Math.sqrt(Math.max(0, Number(audioState.inputLevel) || 0)) * 3);
            orb.style.setProperty("--input-level",String(inputLevel));
            receivingAudio = audioState.receivingAudio === true;
            audioConnection = diagnostics.status;
            inputPaused=audioState.inputPaused===true;
            audioStage=audioState.stage;
            if((external || ["listening","thinking","speaking"].includes(state)) && ["listening","thinking","speaking"].includes(audioStage))state=audioStage as VoiceState;
            if(!inputPaused&&typeof audioState.partialText==="string"&&audioState.partialText.trim()){transcript.update("user",audioState.partialText,false);liveWords.textContent=audioState.partialText;liveWords.setAttribute("data-interim","");}
            schedule();
          }
        }
      }
    } catch { if (!enabled) { hint.textContent = "Voice couldn’t connect to HUB"; render(); } }
    finally { statusFlight = false; }
  }
  const callPoll = view.setInterval(() => {if(active()||Date.now()-lastStatusAt>=2500)void checkStatus();}, 500);
  const visibleStatus = () => { if (!root.hidden) void checkStatus(); }; root.addEventListener("visibilitychange", visibleStatus);
  void checkStatus();
  return () => { lifetime.abort(); root.removeEventListener("visibilitychange", visibleStatus); view.clearInterval(callPoll); activitySignals.dispose(); observer.disconnect(); unsubscribe(); unsubscribeConnection?.(); view.clearInterval(refreshTime); view.removeEventListener("resize", schedule); if (frame !== undefined) view.cancelAnimationFrame(frame); void voice?.stop(); clearConversation(); transcript.dispose(); hub.remove(); intro.remove(); textHeading.remove(); nav.remove(); activity.panel.remove(); browser.dispose(); presentation.dispose(); audio.remove(); removeStyles(); };
}
