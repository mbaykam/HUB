import {createHash} from "node:crypto";
import {constants} from "node:fs";
import {lstat, open, realpath} from "node:fs/promises";
import {homedir} from "node:os";
import {basename, isAbsolute, join, relative, resolve, sep} from "node:path";
import {installDesktopControl, WindowsDesktopInput, type DesktopInputPort} from "./desktop-control.ts";
// pngjs ships without TypeScript declarations.
// @ts-expect-error No declarations are published by pngjs.
import pngjs from "pngjs";
import {AGENT_BROWSER_IPC_VERSION_ENV, AGENT_BROWSER_PROTOCOL_VERSION, type AgentDesktopScreenshotResult} from "../agent-browser-contract.ts";
import {AgentBrowserProcessClient, type AgentBrowserProcessPort} from "./agent-browser-process.ts";
import {currentTurnHasUserRequest} from "./task-turn.ts";

const toolName = "hub_show_screenshot";
const desktopToolName = "hub_capture_desktop";
const maxBytes = 8 * 1024 * 1024;
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const {PNG} = pngjs as {
  PNG: {sync: {read(data: Buffer): {data: Buffer}}};
};
const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

function requireVisiblePNG(data: Buffer): void {
  if (data.length < 33 || data.length > maxBytes || !data.subarray(0, 8).equals(pngSignature) ||
      data.toString("ascii", 12, 16) !== "IHDR") throw Error("Choose a valid PNG screenshot under 8 MB.");
  const width = data.readUInt32BE(16), height = data.readUInt32BE(20);
  if (!width || !height || width * height > 20_000_000) throw Error("Screenshot dimensions are invalid or too large.");
  if (data[28] !== 0) throw Error("Choose a non-interlaced PNG screenshot.");
  let pixels: Buffer;
  try { pixels = PNG.sync.read(data).data; }
  catch { throw Error("This screenshot could not be decoded as a PNG."); }
  if (!pixels.some((value, index) => index % 4 === 3 && value !== 0)) {
    throw Error("The screenshot is blank. Capture it again before sharing.");
  }
}

export async function readWorkspaceScreenshot(cwd: string, input: string, signal: AbortSignal) {
  signal.throwIfAborted();
  if (!isAbsolute(cwd) || typeof input !== "string" || input.length > 1024 || !/\.png$/i.test(input) ||
      /[\x00-\x1f]/u.test(input) || /(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(input) || /:/u.test(input.replace(/^[A-Za-z]:[\\/]/u, ""))) {
    throw new Error("Choose a PNG in this conversation's workspace.");
  }
  const requested = resolve(cwd, input);
  const root = await realpath(cwd);
  if (!inside(cwd, requested)) throw new Error("Screenshot is outside this conversation's workspace.");
  const actual = await realpath(requested);
  const info = await lstat(requested);
  if (!inside(root, actual) || !info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size < 24 || info.size > maxBytes) {
    throw new Error("Choose a regular workspace PNG under 8 MB.");
  }
  const file = await open(actual, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await file.stat();
    if (!opened.isFile() || opened.ino !== info.ino || opened.dev !== info.dev || opened.size !== info.size ||
        opened.nlink !== 1 || await realpath(requested) !== actual) throw new Error("Screenshot changed before it could be read.");
    const data = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < data.length) {
      signal.throwIfAborted();
      const {bytesRead} = await file.read(data, offset, data.length - offset, offset);
      if (!bytesRead) throw new Error("Screenshot changed while it was read.");
      offset += bytesRead;
    }
    const after = await file.stat();
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || !data.subarray(0, 8).equals(pngSignature)) {
      throw new Error("Choose an unchanged PNG screenshot.");
    }
    signal.throwIfAborted();
    requireVisiblePNG(data);
    return {data, name: basename(requested)};
  } finally { await file.close(); }
}

export function installScreenshotDelivery(ctx: any, desktopPort = windowsDesktopPort(),
  desktopInput: () => DesktopInputPort = () => new WindowsDesktopInput(join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "hub-desktop"))): () => void {
  if (!ctx.tools?.register || !ctx.attachments?.saveImage) return () => {};
  const offTool = ctx.tools.register({
    name: toolName,
    description: "Show a PNG screenshot already saved in this conversation's workspace as a real image in chat. Use after capturing a screenshot the user asked to see, instead of replying with a local file path. This only shares the selected file and does not capture the desktop. Maximum 8 MB.",
    parameters: {type: "object", properties: {path: {type: "string", maxLength: 1024}}, required: ["path"], additionalProperties: false},
    output: {
      schema: {type: "object"},
      render: (_: unknown, value: any) => [{type: "text", text: `Screenshot shown in chat: ${value.name}`}],
      presentationMeta: (_: unknown, value: unknown) => value,
    },
    async execute(args: {path: string}, exec: any) {
      if (exec.parent) throw new Error("Call the screenshot display tool directly in the conversation.");
      const agent = exec.agent;
      const cwd = agent?.session.header.cwd;
      if (!cwd || agent.session.header.origin === "subagent" || !currentTurnHasUserRequest(agent)) {
        throw new Error("Sharing a screenshot requires a current request in this conversation.");
      }
      const {data, name} = await readWorkspaceScreenshot(cwd, args.path, exec.signal);
      const attachment = await ctx.attachments.saveImage({data, mediaType: "image/png", name});
      exec.signal.throwIfAborted();
      return {kind: "hub-screenshot", name, attachment};
    },
  });
  const desktop = desktopPort && new AgentBrowserProcessClient(desktopPort, {requestTimeoutMs: 12_000, cancelGraceMs: 750});
  const input = desktop ? desktopInput() : undefined;
  // An idle PC shows its screen saver on a separate desktop, and while it runs
  // Windows cannot capture the screen at all. Close it first, as moving the
  // mouse would, then capture the real screen.
  const captureScreen = async (sessionId: string, signal: AbortSignal) => {
    await input?.wake?.(signal);
    const result = await desktop!.request(sessionId, "desktop-screenshot", {}, signal) as AgentDesktopScreenshotResult;
    const data = Buffer.from(result.data, "base64");
    requireVisiblePNG(data);
    return {data};
  };
  const offDesktop = desktop && ctx.tools.register({
    name: desktopToolName,
    description: "Capture the primary Windows display and show it in this chat. Use it whenever the user should see the screen: when they ask for it in any words, or to show the result of desktop work.",
    parameters: {type: "object", properties: {}, additionalProperties: false},
    output: {
      schema: {type: "object"},
      render: () => [{type: "text", text: "Primary Windows display captured in chat."}],
      presentationMeta: (_: unknown, value: unknown) => value,
    },
    async execute(_args: unknown, exec: any) {
      const agent = exec.agent;
      if (exec.parent || !agent?.session?.header?.id || agent.session.header.origin === "subagent" || !currentTurnHasUserRequest(agent)) {
        throw Error("Desktop screenshots are taken during a conversation turn the user started, not from background work. Tell the user the screenshot was not taken.");
      }
      const {data} = await captureScreen(agent.session.header.id, exec.signal);
      exec.signal.throwIfAborted();
      const name = "desktop-screenshot.png";
      const attachment = await ctx.attachments.saveImage({data, mediaType: "image/png", name});
      exec.signal.throwIfAborted();
      return {kind: "hub-screenshot", name, attachment};
    },
  });
  // Computer use on this PC shares the same desktop capture.
  const offControl = desktop ? installDesktopControl(ctx, {
    async capture(sessionId, signal) {
      return (await captureScreen(sessionId, signal)).data;
    },
    input: input!,
    async vision(agent, signal) {
      const route = agent?.session?.requestHeader?.()?.config;
      if (!route?.provider || !route.model || !ctx.llm?.resolveModelInfo) return false;
      const info = await ctx.llm.resolveModelInfo(route.provider, route.model, signal);
      return info?.inputModalities?.includes("image") === true;
    },
    save: data => ctx.attachments.saveImage({data, mediaType: "image/png", name: "Desktop look.png"}),
  }) : undefined;
  // Live view of this PC's screen for the iPhone: one fresh frame per request,
  // only while the phone has the view open. Concurrent viewers share a frame.
  let latest: {at: number; data: Buffer} | undefined, inFlight: Promise<Buffer> | undefined;
  const frame = async () => {
    if (latest && Date.now() - latest.at < 700) return latest.data;
    inFlight ??= captureScreen("hub-screen-view", AbortSignal.timeout(10_000)).then(({data}) => {
      latest = {at: Date.now(), data};
      return data;
    }).finally(() => { inFlight = undefined; });
    return inFlight;
  };
  const offView = desktop && ctx.webServer?.register?.({kind: "exact", path: "/api/hub/screen-view", async handler(req: any, res: any) {
    const reply = (code: number, value: unknown) => { res.writeHead(code, {"content-type": "application/json", "cache-control": "no-store"}); res.end(JSON.stringify(value)); };
    const rejection = ctx.connection?.requestRejection?.(req);
    if (rejection || req.headers["sec-fetch-site"] === "cross-site" || req.headers["x-hub-screen-view"] !== "1") { reply(rejection ?? 403, {error: "unauthorized"}); return; }
    if (req.method !== "GET") { reply(405, {error: "method-not-allowed"}); return; }
    try {
      const data = await frame();
      res.writeHead(200, {"content-type": "image/png", "content-length": data.length, "cache-control": "no-store, private", "x-content-type-options": "nosniff"});
      res.end(data);
    } catch (error) {
      reply(503, {error: "screen-unavailable", detail: String((error as Error).message).slice(0, 200)});
    }
  }});
  const offGuide = ctx.systemPrompt?.section({
    name: "hub:screenshot-delivery",
    order: 92,
    text: "To show the user this PC's screen, use hub_capture_desktop: it captures and displays the primary screen in the chat in one call. Screenshots saved to a file by other tools (a Windows or PowerShell screenshot) do not appear in the chat, and a local path does not display anything; use hub_show_screenshot for an existing PNG in this conversation's workspace. Use browser_screenshot for a web page. If a capture fails, say so plainly instead of claiming the user can see it.",
  });
  return () => { offView?.(); offGuide?.(); offControl?.(); offDesktop?.(); desktop?.dispose(); offTool(); };
}

function windowsDesktopPort(): AgentBrowserProcessPort | undefined {
  if (process.platform === "win32" && typeof process.send === "function" && process.connected &&
      process.env[AGENT_BROWSER_IPC_VERSION_ENV] === String(AGENT_BROWSER_PROTOCOL_VERSION)) {
    return process as unknown as AgentBrowserProcessPort;
  }
}

/** Resolve only an image reference committed by this tool in this session. */
export function conversationScreenshots(events: readonly any[]) {
  const pending = new Set<string>();
  const images = new Map<string, {id: string; name: string; turn: number; seq?: number; attachment: any}>();
  for (const event of events) {
    if (event.type === "tool/call" && [toolName, desktopToolName].includes(event.data?.name) && typeof event.data.callId === "string") pending.add(event.data.callId);
    if (event.type !== "tool/result") continue;
    const result = event.data?.message?.content?.[0];
    const {kind, name, attachment} = event.data?.meta ?? {};
    if (result?.type !== "tool-result" || !pending.delete(result.toolCallId) || result.isError !== false || kind !== "hub-screenshot" ||
        !Number.isSafeInteger(event.data.turn) || typeof name !== "string" || name.length > 255 || !attachment ||
        !/^sha256:[a-f0-9]{64}$/u.test(attachment.attachmentId) || !/^image\/(png|jpeg|webp)$/u.test(attachment.mediaType) ||
        !Number.isSafeInteger(attachment.bytes) || attachment.bytes < 1 || attachment.bytes > maxBytes) continue;
    const id = createHash("sha256").update(result.toolCallId).digest("hex");
    // seq lets the phone keep the image between the messages around it once
    // the reply has finished, instead of moving it after the whole reply.
    images.set(id, {id, name, turn: event.data.turn, ...(Number.isSafeInteger(event.seq) ? {seq: event.seq} : {}), attachment});
  }
  return [...images.values()];
}
