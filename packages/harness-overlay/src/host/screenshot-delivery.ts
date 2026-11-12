import {createHash} from "node:crypto";
import {constants} from "node:fs";
import {lstat, open, realpath} from "node:fs/promises";
import {basename, isAbsolute, relative, resolve, sep} from "node:path";
import {currentTurnHasUserRequest} from "./task-turn.ts";

const toolName = "hub_show_screenshot";
const maxBytes = 8 * 1024 * 1024;
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

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
    return {data, name: basename(requested)};
  } finally { await file.close(); }
}

export function installScreenshotDelivery(ctx: any): () => void {
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
  const offGuide = ctx.systemPrompt?.section({
    name: "hub:screenshot-delivery",
    order: 92,
    text: "When a user asks to see a screenshot already captured as a workspace PNG, use hub_show_screenshot to put it in their chat. Share only the requested screenshot. A local path alone does not display the image.",
  });
  return () => { offGuide?.(); offTool(); };
}

/** Resolve only an image reference committed by this tool in this session. */
export function conversationScreenshots(events: readonly any[]) {
  const pending = new Set<string>();
  const images = new Map<string, {id: string; name: string; turn: number; attachment: any}>();
  for (const event of events) {
    if (event.type === "tool/call" && event.data?.name === toolName && typeof event.data.callId === "string") pending.add(event.data.callId);
    if (event.type !== "tool/result") continue;
    const result = event.data?.message?.content?.[0];
    const {kind, name, attachment} = event.data?.meta ?? {};
    if (result?.type !== "tool-result" || !pending.delete(result.toolCallId) || result.isError !== false || kind !== "hub-screenshot" ||
        !Number.isSafeInteger(event.data.turn) || typeof name !== "string" || name.length > 255 || !attachment ||
        !/^sha256:[a-f0-9]{64}$/u.test(attachment.attachmentId) || !/^image\/(png|jpeg|webp)$/u.test(attachment.mediaType) ||
        !Number.isSafeInteger(attachment.bytes) || attachment.bytes < 1 || attachment.bytes > maxBytes) continue;
    const id = createHash("sha256").update(result.toolCallId).digest("hex");
    images.set(id, {id, name, turn: event.data.turn, attachment});
  }
  return [...images.values()];
}
