import type { HarnessClientContext, HarnessSessionJob } from "../core/context.ts";

/** Read-only projections of native sessions, descendants and visible jobs. */
export interface ActivitySession {
  readonly title?: string; readonly displayTitle?: string; readonly running?: boolean;
  readonly completed?: boolean; readonly blank?: boolean; readonly updatedAt?: number;
  readonly origin?: string; readonly parentId?: string;
  readonly failed?:boolean; readonly stopped?:boolean;
}
interface Observation { readonly queued?: number; readonly failed?: boolean; readonly lastAction?: string; }
export interface ActivityPendingSource {
  getSnapshot(): ReadonlyMap<string, { readonly kind: string }>;
  subscribe(listener: () => void): () => void;
}
export interface ActivitySnapshot {
  readonly phase?: "pending" | "ready";
  readonly byId: Readonly<Record<string, ActivitySession | undefined>>;
  readonly jobsBySession?: Readonly<Record<string, readonly HarnessSessionJob[]>>;
  readonly subagentsByParent?: Readonly<Record<string, { readonly entries: readonly { readonly kind: string; readonly id: string; readonly label?: string; readonly activity?: string }[] }>>;
  readonly observations?: Readonly<Record<string, Observation | undefined>>;
  readonly pendingBySession?: ReadonlyMap<string, { readonly kind: string }>;
}
type Status = "running" | "stopping" | "waiting" | "attention" | "finished" | "completed" | "killed" | "failed";
export interface ActivityStep { id: string; label: string; detail?: string; status: Status | "idle"; sessionId: string; }
export interface ActivityItem {
  id: string; sessionId: string; title: string; detail: string; status: Status;
  updatedAt: number; kind: "task" | "chat" | "job"; steps: ActivityStep[];
  memberIds: string[]; activeAssistants: number; activeProcesses: number;
}
const recentMs = 15 * 60_000;
const activeJob = (job: HarnessSessionJob) => job.status === "running" || job.status === "stopping";
const activeStatus = (status: Status) => ["running", "stopping", "waiting", "attention"].includes(status);
const internal = (id: string) => /^hub-(memory-|character-(eval|check)-)/.test(id);
const titleOf = (id: string, session?: ActivitySession) => {
  const title = (session?.title || session?.displayTitle || "").trim();
  return title && title !== id && !/^minke-im-/.test(title) ? title.slice(0, 180) : id.startsWith("minke-im-telegram-") ? "Telegram conversation" : session?.origin === "subagent" ? "Delegated task" : "Conversation";
};
function pendingLabel(kind: string) { return /permission|approval/i.test(kind) ? "Waiting for your permission" : /plan/i.test(kind) ? "Waiting for your review" : "Waiting for your reply"; }

export function projectMobileActivity(snapshot: ActivitySnapshot, voiceSession?: string, now = Date.now(), recent: ReadonlyMap<string, number> = new Map()): ActivityItem[] {
  const sessions: Record<string, ActivitySession | undefined> = Object.assign(Object.create(null), snapshot.byId);
  // Catalog-only children may be absent from the top-level session list.
  for (const [parentId, catalog] of Object.entries(snapshot.subagentsByParent ?? {})) for (const entry of catalog.entries) {
    if (entry.kind !== "child") continue;
    if (!sessions[entry.id]) sessions[entry.id] = { title: entry.label, origin: "subagent", parentId, running: entry.activity === "running" };
  }
  const rootOf = (id: string) => {
    let current = id; const seen = new Set<string>([id]);
    while (sessions[current]?.origin === "subagent") {
      const parent = sessions[current]?.parentId;
      if (!parent || parent === voiceSession || !sessions[parent] || seen.has(parent) || internal(parent)) break;
      seen.add(parent); current = parent;
    }
    return current;
  };
  const groups = new Map<string, { members: Set<string>; jobs: { job: HarnessSessionJob; sessionId: string }[] }>();
  const group = (id: string) => { let value = groups.get(id); if (!value) { value = { members: new Set(), jobs: [] }; groups.set(id, value); } return value; };
  for (const [id, session] of Object.entries(sessions)) if (session && id !== voiceSession && !internal(id)) group(rootOf(id)).members.add(id);
  const jobs = new Map<string, { job: HarnessSessionJob; contexts: string[] }>();
  for (const [sessionId, visible] of Object.entries(snapshot.jobsBySession ?? {})) for (const job of visible) {
    if (!activeJob(job) && (job.finishedAt === undefined || now - job.finishedAt > recentMs)) continue;
    const previous = jobs.get(job.id);
    if (previous) {
      previous.contexts.push(sessionId);
      if ((job.finishedAt ?? job.startedAt) > (previous.job.finishedAt ?? previous.job.startedAt)) previous.job = job;
    } else jobs.set(job.id, { job, contexts: [sessionId] });
  }
  for (const { job, contexts } of jobs.values()) {
    const usable = contexts.filter(id => !internal(id)); if (!usable.length) continue;
    // Visibility is not ownership; this is a link, never a cancel permission.
    usable.sort((a, b) => Number(b !== voiceSession && !!sessions[b]) - Number(a !== voiceSession && !!sessions[a]) || Number(!!sessions[b]?.running) - Number(!!sessions[a]?.running) || a.localeCompare(b));
    const sessionId = usable[0]!, key = sessionId === voiceSession || !sessions[sessionId] ? "job:" + job.id : rootOf(sessionId);
    group(key).jobs.push({ job, sessionId });
  }
  const result: ActivityItem[] = [];
  for (const [rootId, value] of groups) {
    const members = [...value.members].sort((a, b) => (sessions[b]?.updatedAt ?? 0) - (sessions[a]?.updatedAt ?? 0) || a.localeCompare(b));
    const running = members.filter(id => sessions[id]?.running), queued = members.filter(id => (snapshot.observations?.[id]?.queued ?? 0) > 0);
    const pending = members.find(id => snapshot.pendingBySession?.has(id));
    const activeProcesses = value.jobs.filter(({ job }) => activeJob(job));
    const finished = members.some(id => sessions[id]?.completed || sessions[id]?.failed || sessions[id]?.stopped || now - (recent.get(id) ?? -Infinity) < recentMs);
    if (!running.length && !queued.length && !pending && !activeProcesses.length && !finished && !value.jobs.length) continue;
    const latestJob = [...value.jobs].sort((a, b) => (b.job.finishedAt ?? b.job.startedAt) - (a.job.finishedAt ?? a.job.startedAt))[0];
    const failed = members.some(id => sessions[id]?.failed||snapshot.observations?.[id]?.failed),stopped=members.some(id=>sessions[id]?.stopped);
    const status: Status = pending ? "attention" : activeProcesses.some(({ job }) => job.status === "stopping") ? "stopping" : running.length || activeProcesses.length ? "running" : queued.length ? "waiting" : failed || latestJob?.job.status === "failed" ? "failed" : stopped||latestJob?.job.status === "killed" ? "killed" : finished ? "finished" : "completed";
    const actionId = running[0] ?? queued[0], lastAction = members.map(id => snapshot.observations?.[id]?.lastAction).find(Boolean), process = activeProcesses[0];
    const detail = pending ? pendingLabel(snapshot.pendingBySession!.get(pending)!.kind) : process ? process.job.detail || process.job.label : running.length ? lastAction ? "Last observed step: " + lastAction : actionId !== rootId ? "Delegated work: " + titleOf(actionId!, sessions[actionId!]) : "The assistant is working on this conversation" : queued.length ? "A message is queued for the next turn" : failed || status === "failed" ? "The last operation reported an error; open the conversation to inspect it" : lastAction ? "Last observed step: " + lastAction : latestJob ? "Background process ended · " + latestJob.job.label : "A reply is ready to review";
    const steps: ActivityStep[] = members.filter(id => id !== rootId).map(id => ({ id: "session:" + id, sessionId: id, label: titleOf(id, sessions[id]), status: snapshot.pendingBySession?.has(id) ? "attention" : sessions[id]?.running ? "running" : (snapshot.observations?.[id]?.queued ?? 0) > 0 ? "waiting" : snapshot.observations?.[id]?.failed ? "failed" : sessions[id]?.completed || recent.has(id) ? "finished" : "idle", detail: snapshot.observations?.[id]?.lastAction }));
    for (const { job, sessionId } of value.jobs) steps.push({ id: "job:" + job.id, sessionId, label: job.label.slice(0, 180), detail: job.detail?.slice(0, 240), status: job.status });
    const selected = pending ?? process?.sessionId ?? running[0] ?? rootId;
    result.push({ id: value.members.size ? "session:" + rootId : rootId, sessionId: selected.startsWith("job:") ? latestJob!.sessionId : selected,
      title: value.members.size ? titleOf(rootId, sessions[rootId]) : latestJob!.job.label.slice(0, 180), detail: detail.slice(0, 300), status,
      updatedAt: Math.max(0, ...members.map(id => sessions[id]?.updatedAt ?? 0), ...value.jobs.map(({ job }) => job.finishedAt ?? job.startedAt)),
      kind: !value.members.size ? "job" : sessions[rootId]?.origin === "subagent" ? "task" : "chat", steps, memberIds: members, activeAssistants: running.length, activeProcesses: activeProcesses.length });
  }
  return result.sort((a, b) => Number(b.status === "attention") - Number(a.status === "attention") || Number(activeStatus(b.status)) - Number(activeStatus(a.status)) || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
}

function toolAction(name: string): string {
  if (/hub_task|hub_delegate|subagent|spawn_agent/.test(name)) return "Delegating work";
  if (/job_output|list_agents/.test(name)) return "Checking background work";
  if (/search|camofox|web_fetch|browser/.test(name)) return "Web research";
  if (/hub_memory/.test(name)) return "Working with memory";
  if (/write|edit|patch/.test(name)) return "Editing files";
  if (/read|file|ls|glob/.test(name)) return "Reading files";
  if (/bash|terminal|exec|run_command/.test(name)) return "Running a command";
  if (/send_message/.test(name)) return "Reporting a result";
  return "Using a tool";
}
/** Observe public faces without opening histories or executing model/tools. */
export function createActivitySignals(sessions: HarnessClientContext["sessions"], changed: () => void) {
  const watched = new Map<string, { binding: NonNullable<ReturnType<typeof sessions.binding>>; off: () => void }>();
  const observed = new Map<string, Observation>();
  return {
    read(snapshot: ActivitySnapshot): Readonly<Record<string, Observation>> {
      const wanted = new Set(Object.entries(snapshot.byId).filter(([id, s]) => !internal(id) && (s?.running || s?.completed)).map(([id]) => id));
      for (const [id] of Object.entries(snapshot.byId).filter(([id, s]) => !internal(id) && !s?.blank && Date.now() - (s?.updatedAt ?? 0) < recentMs).sort((a, b) => (b[1]?.updatedAt ?? 0) - (a[1]?.updatedAt ?? 0)).slice(0, 12)) wanted.add(id);
      for (const id of Object.keys(snapshot.jobsBySession ?? {})) if (!internal(id)) wanted.add(id);
      for (const [id, entry] of watched) if (!wanted.has(id)) { entry.off(); watched.delete(id); }
      for (const id of [...wanted].slice(0, 64)) {
        const binding = sessions.binding(id), previous = watched.get(id); if (binding === previous?.binding) continue;
        previous?.off(); watched.delete(id); if (!binding) continue;
        const offSession = binding.session.subscribe?.(changed), offEvents = binding.eventSource?.subscribe(changed);
        watched.set(id, { binding, off: () => { offSession?.(); offEvents?.(); } });
      }
      const result: Record<string, Observation> = Object.create(null);
      for (const id of observed.keys()) if (!snapshot.byId[id]) observed.delete(id);
      for (const [id, { binding }] of watched) {
        const value = binding.session.getSnapshot?.(), entries = binding.eventSource?.getSnapshot().entries ?? []; let action: string | undefined;
        for (let i = entries.length - 1; i >= Math.max(0, entries.length - 100); i--) {
          const event = entries[i]?.event; if (event?.type !== "tool/call") continue;
          const data = event.data as { name?: string; call?: { name?: string } } | undefined, name = data?.name ?? data?.call?.name;
          if (typeof name === "string") { action = toolAction(name); break; }
        }
        observed.set(id, { queued: value?.queue?.length ?? 0, failed: !!value?.lastAgentError, lastAction: action });
      }
      while (observed.size > 1000) observed.delete(observed.keys().next().value!);
      for (const [id, value] of observed) result[id] = watched.has(id) ? value : { ...value, queued: 0 };
      return result;
    },
    dispose() { for (const entry of watched.values()) entry.off(); watched.clear(); observed.clear(); },
  };
}

const labels: Record<Status | "idle", string> = { running: "Working", stopping: "Stopping", waiting: "Queued", attention: "Needs your input", finished: "Reply ready", completed: "Process ended", killed: "Stopped", failed: "Failed", idle: "Idle" };
function age(at: number, now: number) { if (!at) return ""; const minutes = Math.max(0, Math.floor((now - at) / 60000)); return minutes < 1 ? "Updated just now" : minutes < 60 ? `Updated ${minutes}m ago` : `Updated ${Math.floor(minutes / 60)}h ago`; }
export function createMobileActivity(root: Document, open: (id: string,parentHint?:string) => void) {
  const panel = root.createElement("section"); panel.setAttribute("data-hub-activity", ""); panel.setAttribute("aria-label", "Your work");
  const heading = root.createElement("h2"); heading.textContent = "Your work";
  const status = root.createElement("p"); status.setAttribute("role", "status");
  const list = root.createElement("div"); list.setAttribute("data-hub-work-grid", "");
  const more = root.createElement("button"); more.type = "button"; panel.append(heading, status, list, more);
  let lastKey = "", expanded = false, snapshot: ActivitySnapshot = { byId: {} }, voice: string | undefined;
  let connection: "connected" | "disconnected" | "connecting" = "connected";
  const wasRunning = new Set<string>(), recent = new Map<string, number>(), expandedSteps = new Set<string>();
  function update(value: ActivitySnapshot, voiceSession?: string, link: typeof connection = "connected") {
    snapshot = value; voice = voiceSession; connection = link; const now = Date.now();
    if (link === "connected" && value.phase !== "pending") for (const [id, session] of Object.entries(value.byId)) {
      if (session?.running) { wasRunning.add(id); recent.delete(id); }
      else if (session) { if (wasRunning.delete(id) || (session.completed && !recent.has(id))) recent.set(id, now); }
    }
    for (const [id, at] of recent) if (now - at > recentMs || !value.byId[id]) recent.delete(id);
    const items = projectMobileActivity(value, voiceSession, now, recent);
    const key = JSON.stringify([items, value.phase, expanded, link, Math.floor(now / 60000)]); if (key === lastKey) return; lastKey = key;
    const active = items.filter(item => activeStatus(item.status));
    panel.toggleAttribute("data-empty", !items.length && link === "connected" && value.phase !== "pending");
    status.textContent = link !== "connected" ? "Connection lost or reconnecting. Status is unavailable; the last observed work is shown below." : value.phase === "pending" ? "Connecting to your work…" : items.length ? `${active.length} active · ${items.length - active.length} recently ended` : "Nothing running. Your assistant’s work will appear here.";
    list.replaceChildren(); let section = "";
    for (const item of expanded ? items : items.slice(0, 4)) {
      const nextSection = activeStatus(item.status) ? "In progress" : "Recently ended";
      if (section !== nextSection) { const h = root.createElement("h3"); h.textContent = nextSection; list.append(h); section = nextSection; }
      const row = root.createElement("article"); row.setAttribute("data-hub-work", item.id); row.setAttribute("data-work-status", link === "connected" ? item.status : "unknown");
      const button = root.createElement("button"); button.type = "button"; button.setAttribute("data-hub-work-open", "");
      const line = root.createElement("div"); line.setAttribute("data-work-heading", ""); const title = root.createElement("strong"); title.textContent = item.title;
      const badge = root.createElement("span"); badge.setAttribute("data-work-badge", ""); badge.textContent = link === "connected" ? labels[item.status] : "Status unavailable"; line.append(title, badge);
      const detail = root.createElement("p"); detail.textContent = item.detail;
      const meta = root.createElement("small"); meta.textContent = [item.activeAssistants ? `${item.activeAssistants} assistant${item.activeAssistants === 1 ? "" : "s"} working` : "", item.activeProcesses ? `${item.activeProcesses} background process${item.activeProcesses === 1 ? "" : "es"}` : "", age(item.updatedAt, now), item.status === "attention" ? "Open to respond →" : "Open conversation →"].filter(Boolean).join(" · ");
      button.append(line, detail, meta); button.addEventListener("click", () => open(item.sessionId,value.byId[item.sessionId]?.parentId)); row.append(button);
      if (item.steps.length) {
        const steps = root.createElement("details"); steps.open = expandedSteps.has(item.id); const summary = root.createElement("summary"); summary.textContent = `Steps & background work (${item.steps.length})`; steps.append(summary);
        steps.addEventListener("toggle", () => { if (steps.open) expandedSteps.add(item.id); else expandedSteps.delete(item.id); });
        const ul = root.createElement("ul");
        for (const step of item.steps) {
          const li = root.createElement("li"), b = root.createElement("button"); b.type = "button"; b.setAttribute("data-work-step", step.id);
          const name = root.createElement("strong"); name.textContent = step.label; const state = root.createElement("span"); state.textContent = `${link === "connected" ? labels[step.status] : "Last known: " + labels[step.status]}${step.detail ? " · " + step.detail : ""}`;
          b.append(name, state); b.addEventListener("click", () => open(step.sessionId,value.byId[step.sessionId]?.parentId)); li.append(b); ul.append(li);
        }
        steps.append(ul); row.append(steps);
      }
      list.append(row);
    }
    more.hidden = items.length <= 4; more.textContent = expanded ? "Show less" : `Show all ${items.length}`;
  }
  more.addEventListener("click", () => { expanded = !expanded; update(snapshot, voice, connection); });
  return { panel, update };
}
