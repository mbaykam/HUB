/**
 * Projects: named groups of chats with shared instructions and a shared note.
 *
 * A project is HUB's own grouping, not a harness workspace, so any existing
 * chat can join one. Creating a project quietly makes a folder on this PC
 * (Documents/HUB Projects/<name>) for its files and keeps the project note
 * there as Markdown. Every chat in the project sees the instructions and the
 * note in its system prompt and can update the note with hub_project_note.
 * Removing a project only removes the grouping: chats and the folder stay.
 */
import {readFile,mkdir,writeFile,rename,stat} from "node:fs/promises";
import {readFileSync} from "node:fs";
import {homedir} from "node:os";
import {join} from "node:path";
import {randomUUID,createHash} from "node:crypto";
import type {IncomingMessage,ServerResponse} from "node:http";

export interface HubProject {
  id: string;
  name: string;
  folder: string;
  instructions: string;
  sessionIds: string[];
  createdAt: number;
  updatedAt: number;
}
export interface ProjectsFile { revision: number; projects: HubProject[] }
export type ProjectCommand =
  | {action: "create"; name: string; instructions?: string}
  | {action: "rename"; id: string; name: string}
  | {action: "instructions"; id: string; instructions: string}
  | {action: "note"; id: string; content: string}
  | {action: "remove"; id: string}
  | {action: "add"; id: string; sessionId: string}
  | {action: "detach"; sessionId: string};

export const NOTE_FILE = "Project note.md";
export const MAX_NOTE = 20_000;
const MAX_INSTRUCTIONS = 8_000;
const PROMPT_NOTE = 6_000;
const validSession = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 200 && !/[\s\u0000-\u001f]/.test(v);
const cleanText = (v: unknown, max: number, what: string) => {
  if (typeof v !== "string" || v.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v)) throw Error(`${what} is too long or contains invalid characters`);
  return v;
};
const cleanName = (v: unknown) => {
  const name = cleanText(v, 120, "The project name").replace(/\s+/g, " ").trim();
  if (!name) throw Error("Give the project a name");
  return name;
};
/** A Windows-safe folder name for a project title. */
export function folderName(name: string): string {
  const safe = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().replace(/[. ]+$/, "").slice(0, 80);
  return /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(safe) || !safe ? `Project ${safe}`.trim() : safe;
}

export class ProjectsStore {
  private state: ProjectsFile = {revision: 0, projects: []};
  private chain: Promise<unknown> = Promise.resolve();
  constructor(readonly file: string, readonly root: string) {}

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.file, "utf8"));
      if (raw && Array.isArray(raw.projects) && Number.isSafeInteger(raw.revision)) this.state = raw;
    } catch (error: any) { if (error?.code !== "ENOENT") throw error; }
  }
  snapshot(): ProjectsFile { return structuredClone(this.state); }
  projectFor(sessionId: string): HubProject | undefined { return this.state.projects.find(p => p.sessionIds.includes(sessionId)); }

  async readNote(project: HubProject): Promise<string> {
    try { return (await readFile(join(project.folder, NOTE_FILE), "utf8")).slice(0, MAX_NOTE); }
    catch (error: any) { if (error?.code === "ENOENT") return ""; throw error; }
  }
  readNoteNow(project: HubProject): string {
    try { return readFileSync(join(project.folder, NOTE_FILE), "utf8").slice(0, MAX_NOTE); } catch { return ""; }
  }
  async writeNote(project: HubProject, content: string): Promise<void> {
    const text = cleanText(content, MAX_NOTE, "The project note");
    await mkdir(project.folder, {recursive: true});
    const target = join(project.folder, NOTE_FILE), temp = `${target}.${randomUUID()}.tmp`;
    await writeFile(temp, text, "utf8");
    await rename(temp, target);
  }

  change(command: ProjectCommand, now = Date.now()): Promise<ProjectsFile> {
    const next = this.chain.then(() => this.apply(command, now));
    this.chain = next.catch(() => {});
    return next;
  }

  private async apply(command: ProjectCommand, now: number): Promise<ProjectsFile> {
    const state = structuredClone(this.state);
    const find = (id: unknown) => {
      const project = state.projects.find(p => p.id === id);
      if (!project) throw Error("That project no longer exists; refresh and try again");
      return project;
    };
    switch (command?.action) {
      case "create": {
        if (state.projects.length >= 200) throw Error("You already have 200 projects; remove one first");
        const name = cleanName(command.name), base = folderName(name);
        let folder = join(this.root, base);
        for (let n = 2; await exists(folder) && n < 1000; n++) folder = join(this.root, `${base} (${n})`);
        await mkdir(folder, {recursive: true});
        const project: HubProject = {id: randomUUID(), name, folder, instructions: cleanText(command.instructions ?? "", MAX_INSTRUCTIONS, "The instructions").trim(), sessionIds: [], createdAt: now, updatedAt: now};
        await this.writeNote(project, `# ${name}\n\n`);
        state.projects.unshift(project);
        break;
      }
      case "rename": { const p = find(command.id); p.name = cleanName(command.name); p.updatedAt = now; break; }
      case "instructions": { const p = find(command.id); p.instructions = cleanText(command.instructions, MAX_INSTRUCTIONS, "The instructions").trim(); p.updatedAt = now; break; }
      case "note": { const p = find(command.id); await this.writeNote(p, command.content); p.updatedAt = now; break; }
      case "remove": { const p = find(command.id); state.projects = state.projects.filter(x => x !== p); break; }
      case "add": {
        const p = find(command.id);
        if (!validSession(command.sessionId)) throw Error("Choose a conversation");
        for (const other of state.projects) other.sessionIds = other.sessionIds.filter(s => s !== command.sessionId);
        p.sessionIds.unshift(command.sessionId);
        if (p.sessionIds.length > 5000) p.sessionIds.length = 5000;
        p.updatedAt = now;
        break;
      }
      case "detach": {
        if (!validSession(command.sessionId)) throw Error("Choose a conversation");
        for (const p of state.projects) if (p.sessionIds.includes(command.sessionId)) { p.sessionIds = p.sessionIds.filter(s => s !== command.sessionId); p.updatedAt = now; }
        break;
      }
      default: throw Error("Unknown project action");
    }
    state.revision += 1;
    await mkdir(join(this.file, ".."), {recursive: true});
    const temp = `${this.file}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(state, null, 2), "utf8");
    await rename(temp, this.file);
    this.state = state;
    return this.snapshot();
  }
}

async function exists(path: string) { try { await stat(path); return true; } catch { return false; } }

/** What a chat in a project is told about it. */
export function projectPrompt(project: HubProject, note: string): string {
  const shown = note.length > PROMPT_NOTE ? note.slice(0, PROMPT_NOTE) + "\n…(note continues; read it with hub_project_note)" : note;
  return [
    `This conversation is part of the user's project "${project.name}". Other chats in the project share its instructions and note.`,
    `Project folder on the PC: ${project.folder}. Save files you make for this project there.`,
    project.instructions ? `Project instructions from the user:\n${project.instructions}` : "",
    `Project note (shared memory for this project):\n${shown.trim() || "(empty)"}`,
    "Keep the project note current with hub_project_note when something durable changes: goals, decisions, status, open questions, next steps, key facts. Keep it organised and short; rewrite rather than pile up. Do not record chit-chat.",
  ].filter(Boolean).join("\n\n");
}

export function installProjects(ctx: any, characters: any, root = join(homedir(), "Documents", "HUB Projects")) {
  const store = new ProjectsStore(join(characters.store.root, "..", "hub-projects", "projects.json"), root), ready = store.load();
  void ready.catch(() => {});
  characters.projects = store;
  /** Sub-agents and forks belong to their parent chat's project. */
  const projectOf = (header: any): HubProject | undefined => store.projectFor(header?.id) ?? (header?.parentSession ? store.projectFor(header.parentSession) : undefined);
  // Prompt sections are synchronous; the note is a small local file the user
  // may also edit on the PC, so it is read fresh each time.
  const offPrompt = ctx.systemPrompt.section({name: "hub:project", order: 89, text: (context: any) => {
    const scope = context.scope, id = scope?.id;
    if (typeof id !== "string" || id.startsWith("hub-")) return "";
    const project = projectOf(scope?.session?.header ?? {id});
    return project ? projectPrompt(project, store.readNoteNow(project)) : "";
  }});
  const output = {schema: {type: "object"}, render: (_a: any, v: any) => [{type: "text", text: JSON.stringify(v)}]};
  const offTool = ctx.tools.register({
    name: "hub_project_note",
    description: "Read or update the shared note of the project this conversation belongs to. Use replace with the complete, reorganised note (Markdown, under 20000 characters), or append to add a short dated entry. Only works in a chat that is part of a project.",
    parameters: {type: "object", properties: {action: {enum: ["read", "replace", "append"]}, content: {type: "string"}}, required: ["action"], additionalProperties: false},
    output,
    async execute(args: any, exec: any) {
      if (!exec.agent) throw Error("This tool needs an active conversation");
      await ready;
      const project = projectOf(exec.agent.session.header);
      if (!project) throw Error("This conversation is not part of a project. The user can add it to one from the chat list.");
      const note = await store.readNote(project);
      if (args.action === "read") return {project: project.name, folder: project.folder, note};
      if (typeof args.content !== "string" || !args.content.trim()) throw Error("Give the note content");
      const next = args.action === "replace" ? args.content : `${note.replace(/\s+$/, "")}\n\n- ${new Date().toISOString().slice(0, 10)}: ${args.content.trim()}\n`;
      if (next.length > MAX_NOTE) throw Error(`The note would be ${next.length} characters; rewrite it shorter (limit ${MAX_NOTE}) with replace`);
      await store.change({action: "note", id: project.id, content: next});
      return {saved: true, project: project.name, characters: next.length};
    },
  });
  const chatTools = installChatTools(ctx, characters, store, ready, projectOf, output);
  const offRoute = ctx.webServer.register({kind: "exact", path: "/api/hub/projects", async handler(req: IncomingMessage, res: ServerResponse) {
    const send = (code: number, data: unknown) => { res.writeHead(code, {"content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff"}); res.end(JSON.stringify(data)); };
    const rejected = ctx.connection.requestRejection(req);
    if (rejected || req.headers["sec-fetch-site"] === "cross-site" || req.headers["x-hub-projects"] !== "1") { send(rejected ?? 403, {error: "unauthorized"}); return; }
    try {
      await ready;
      if (req.method === "POST") {
        if (!req.headers["content-type"]?.startsWith("application/json")) { send(415, {error: "json-required"}); return; }
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 64_000) throw Error("Project edit is too large"); chunks.push(chunk); }
        await store.change(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } else if (req.method !== "GET") { send(405, {error: "method-not-allowed"}); return; }
      const snapshot = store.snapshot();
      send(200, {revision: snapshot.revision, projects: await Promise.all(snapshot.projects.map(async p => ({...p, note: await store.readNote(p).catch(() => "")})))});
    } catch (error) { send(409, {error: "project-operation-failed", detail: (error as Error).message.slice(0, 300)}); }
  }});
  return async () => { offRoute(); offTool(); chatTools(); offPrompt(); await ready.catch(() => {}); };
}

/** True when the newest message in this chat came from the user, not a tool or automation. */
export function userAskedNow(agent: any): boolean {
  const events = agent?.session?.snapshotEvents?.() ?? [];
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type === "turn/end") return false;
    if (event.type === "user/message") return event.data?.source?.kind === "user";
  }
  return false;
}

/** Find a project by id or (case-insensitive) name. */
export function findProject(projects: HubProject[], ref: unknown): HubProject | undefined {
  if (typeof ref !== "string" || !ref.trim()) return undefined;
  const key = ref.trim().toLocaleLowerCase();
  return projects.find(p => p.id === ref) ?? projects.find(p => p.name.toLocaleLowerCase() === key);
}

/**
 * Lets a chat open new chats and organise projects for the user. These act
 * only on the user's own request in the current turn, from a top-level chat.
 */
function installChatTools(ctx: any, characters: any, store: ProjectsStore, ready: Promise<void>, projectOf: (header: any) => HubProject | undefined, output: any) {
  const controller = () => characters.host?.sessionController ?? ctx.sessionController;
  const topLevel = (exec: any) => {
    const header = exec.agent?.session?.header;
    if (!header || header.origin === "subagent" || typeof header.id !== "string" || header.id.startsWith("hub-")) throw Error("Only a chat with the user can do this.");
    if (!userAskedNow(exec.agent)) throw Error("Do this only when the user asks for it in this conversation.");
    return header;
  };
  const opened = new Map<string, number>();
  const offNew = ctx.tools.register({
    name: "hub_new_chat",
    description: "Open a new, separate chat for the user when they ask (\"start a new chat about X\", \"continue this in a fresh chat\"). message is the first message of the new chat: a self-contained brief with everything it needs, because the new chat cannot see this one. project: a project name or id to put it in, \"same\" (default: this chat's project, if any) or \"none\". The new chat starts working on the brief right away and appears in the user's chat list. Tell the user it was opened; do not do its work here too.",
    parameters: {type: "object", properties: {message: {type: "string"}, project: {type: "string"}}, required: ["message"], additionalProperties: false},
    output,
    async execute(args: any, exec: any) {
      const header = topLevel(exec);
      const brief = cleanText(args.message, 12_000, "The message").trim();
      if (!brief) throw Error("Write the first message for the new chat");
      const turnKey = `${header.id}:${(exec.agent.session.snapshotEvents?.() ?? []).filter((e: any) => e.type === "user/message").length}`;
      const count = (opened.get(turnKey) ?? 0) + 1;
      if (count > 3) throw Error("At most three new chats per request");
      await ready;
      const ref = typeof args.project === "string" ? args.project.trim() : "same";
      const target = ref.toLowerCase() === "none" ? undefined : ref.toLowerCase() === "same" || !ref ? projectOf(header) : findProject(store.snapshot().projects, ref);
      if (ref && !["same", "none"].includes(ref.toLowerCase()) && !target) throw Error(`No project called "${ref}". Use hub_projects list, or create it first.`);
      const sessions = controller();
      if (!sessions?.create || !sessions?.prompt) throw Error("This HUB cannot open chats from a conversation.");
      const sessionId = "session-" + randomUUID();
      const created = await sessions.create({sessionId});
      if (created?.sessionId !== sessionId) throw Error("HUB could not open the chat");
      opened.set(turnKey, count);
      if (target) await store.change({action: "add", id: target.id, sessionId});
      await sessions.prompt({requestId: randomUUID(), sessionId, mode: "queue", content: [{type: "text", text: `(Opened by HUB from another chat at your request.)\n\n${brief}`}]}, AbortSignal.timeout(30_000));
      return {opened: true, sessionId, project: target?.name ?? null};
    },
  });
  // "We talked about this before": find that chat and send the user back to it
  // instead of starting over. Read-only; opening only shows a button in the chat.
  const offFind = ctx.tools.register({
    name: "hub_find_chat",
    description: "Find an earlier chat when the user refers to something you talked about before (\"we discussed X\", \"that chat about Y\", \"continue where we left off\"). query searches chat titles and the saved chat archive and returns up to 5 matches, newest first. When one clearly matches (or the user picks one), call again with open set to its sessionId and title set to its title: the chat then shows a button that takes the user back to that chat so the conversation continues there. You can also read it with hub_knowledge_read using its archiveId to pick up the details. Do not open a chat the user did not mean.",
    parameters: {type: "object", properties: {query: {type: "string"}, open: {type: "string"}, title: {type: "string"}}, additionalProperties: false},
    output,
    async execute(args: any, exec: any) {
      const header = exec.agent?.session?.header;
      if (!header || header.origin === "subagent" || typeof header.id !== "string" || header.id.startsWith("hub-")) throw Error("Only a chat with the user can do this.");
      const sessions = controller();
      if (!sessions?.list) throw Error("This HUB cannot list chats.");
      const {items} = await sessions.list({}, AbortSignal.timeout(15_000));
      const chats = items.filter((s: any) => !s.blank && s.origin !== "subagent" && typeof s.sessionId === "string" && !s.sessionId.startsWith("hub-") && s.sessionId !== header.id)
        .map((s: any) => ({sessionId: s.sessionId as string, title: typeof s.projections?.values?.title === "string" && s.projections.values.title.trim() ? String(s.projections.values.title).slice(0, 200) : "Untitled conversation", updatedAt: Number(s.updatedAt) || 0}));
      if (typeof args.open === "string" && args.open.trim()) {
        const chat = chats.find((c: any) => c.sessionId === args.open.trim());
        if (!chat) throw Error("No such chat; search first and use a returned sessionId.");
        return {open: true, sessionId: chat.sessionId, title: chat.title, notice: "The user now sees a button that opens this chat. Tell them in one line."};
      }
      const query = typeof args.query === "string" ? args.query.trim().slice(0, 300) : "";
      if (!query) throw Error("Say what the earlier chat was about.");
      const words = query.toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length > 2);
      const score = new Map<string, number>();
      for (const chat of chats) {
        const title = chat.title.toLocaleLowerCase(), hits = words.filter(w => title.includes(w)).length;
        if (hits) score.set(chat.sessionId, hits * 2);
      }
      // The archive knows what was said, not only the title.
      const archiveOf = new Map(chats.map((c: any) => ["conversation-" + createHash("sha256").update("hub:" + c.sessionId).digest("hex").slice(0, 32), c.sessionId]));
      try {
        const result = await exec.agent.ctx.tools.execute({agent: exec.agent, name: "hub_knowledge_search", arguments: {query}, callId: `${exec.callId ?? "find"}:archive`, signal: exec.signal ?? AbortSignal.timeout(15_000)});
        const text = (result.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
        const parsed = text ? JSON.parse(text) : [];
        const records: any[] = Array.isArray(parsed) ? parsed : parsed.records ?? [];
        records.forEach((r: any, i: number) => {
          const session = archiveOf.get(r?.id);
          if (session) score.set(session, (score.get(session) ?? 0) + Math.max(1, 5 - i));
        });
      } catch {}
      const matches = chats.filter((c: any) => score.has(c.sessionId))
        .sort((a: any, b: any) => score.get(b.sessionId)! - score.get(a.sessionId)! || b.updatedAt - a.updatedAt).slice(0, 5)
        .map((c: any) => ({sessionId: c.sessionId, title: c.title, updated: new Date(c.updatedAt).toISOString().slice(0, 10),
          archiveId: "conversation-" + createHash("sha256").update("hub:" + c.sessionId).digest("hex").slice(0, 32)}));
      return {matches, notice: matches.length ? "Open the one the user means with open and title." : "No earlier chat matched; ask the user for another detail."};
    },
  });  const offProjects = ctx.tools.register({
    name: "hub_projects",
    description: "Organise the user's projects (named groups of chats with shared instructions and a note), when the user asks. Actions: list; create (name, optional instructions; add_this_chat to put this chat in it); add (project, optional sessionId — default this chat — moves the chat into the project); detach (optional sessionId, default this chat — takes it out of its project); rename (project, name); instructions (project, instructions — replaces them). project is a name or id. Removing a whole project is left to the user in the app.",
    parameters: {type: "object", properties: {action: {enum: ["list", "create", "add", "detach", "rename", "instructions"]}, project: {type: "string"}, name: {type: "string"}, instructions: {type: "string"}, sessionId: {type: "string"}, add_this_chat: {type: "boolean"}}, required: ["action"], additionalProperties: false},
    output,
    async execute(args: any, exec: any) {
      await ready;
      const summary = () => store.snapshot().projects.map(p => ({id: p.id, name: p.name, chats: p.sessionIds.length, instructions: p.instructions.slice(0, 300)}));
      if (args.action === "list") return {projects: summary(), thisChatProject: exec.agent ? projectOf(exec.agent.session.header)?.name ?? null : null};
      const header = topLevel(exec);
      const need = () => { const p = findProject(store.snapshot().projects, args.project); if (!p) throw Error(`No project called "${args.project ?? ""}". Use list to see them.`); return p; };
      const session = typeof args.sessionId === "string" && args.sessionId ? args.sessionId : header.id;
      switch (args.action) {
        case "create": {
          const after = await store.change({action: "create", name: args.name ?? args.project, instructions: args.instructions});
          const project = after.projects[0];
          if (args.add_this_chat) await store.change({action: "add", id: project.id, sessionId: header.id});
          return {created: true, project: project.name, folder: project.folder, thisChatAdded: !!args.add_this_chat};
        }
        case "add": { const p = need(); await store.change({action: "add", id: p.id, sessionId: session}); return {added: true, project: p.name, sessionId: session}; }
        case "detach": { const was = store.projectFor(session); await store.change({action: "detach", sessionId: session}); return {detached: !!was, project: was?.name ?? null}; }
        case "rename": { const p = need(); await store.change({action: "rename", id: p.id, name: args.name}); return {renamed: true, from: p.name, to: cleanName(args.name)}; }
        case "instructions": { const p = need(); await store.change({action: "instructions", id: p.id, instructions: args.instructions ?? ""}); return {saved: true, project: p.name}; }
        default: throw Error("Unknown action");
      }
    },
  });
  return () => { offNew(); offFind(); offProjects(); };
}
