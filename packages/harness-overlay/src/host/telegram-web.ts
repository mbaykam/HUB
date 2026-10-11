import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { HUB_TELEGRAM_IPC, parseTelegramCommand, type HubTelegramCommand } from "../telegram-control-contract.ts";
interface Host {
  connection: { requestRejection(req: IncomingMessage): 401 | 403 | undefined };
  webServer: { register(route: { kind: "exact"; path: string; handler(req: IncomingMessage, res: ServerResponse): Promise<void> }): () => void };
}
function publicState(raw: unknown) {
  if (!raw || typeof raw !== "object") throw new Error("Invalid Telegram status");
  const value = raw as Record<string, any>;
  if (typeof value.state !== "string" || !/^[a-z-]{1,40}$/.test(value.state)) throw new Error("Invalid Telegram status");
  const text = (v: unknown, max: number) => typeof v === "string" ? v.slice(0, max) : "";
  return { state: value.state, ...(typeof value.accountLabel === "string" ? { accountLabel: text(value.accountLabel, 200) } : {}),
    ...(value.request && typeof value.request.requestId === "string" && typeof value.request.code === "string" ? { request: {
      requestId: text(value.request.requestId, 128), code: text(value.request.code, 40), senderLabel: text(value.request.senderLabel, 200),
      ...(typeof value.request.expiresAt === "number" && Number.isFinite(value.request.expiresAt) ? { expiresAt: value.request.expiresAt } : {}),
    } } : {}), ...(typeof value.issue === "string" ? { issue: text(value.issue, 80) } : {}) };
}
export function installTelegramWeb(host: Host, control?: (command: HubTelegramCommand) => Promise<unknown>) {
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  const onMessage = (raw: unknown) => {
    if (!raw || typeof raw !== "object") return;
    const m = raw as Record<string, unknown>; if (m.type !== HUB_TELEGRAM_IPC || m.direction !== "response" || typeof m.id !== "string") return;
    const entry = pending.get(m.id); if (!entry) return; clearTimeout(entry.timer); pending.delete(m.id);
    if (m.ok === true) entry.resolve(m.value); else entry.reject(new Error("Telegram control unavailable"));
  };
  process.on("message", onMessage);
  const native = control ?? ((command: HubTelegramCommand) => new Promise((resolve, reject) => {
    if (!process.send || !process.connected || pending.size >= 8) { reject(new Error("Desktop bridge unavailable")); return; }
    const id = randomUUID();
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("Telegram operation timed out; check status before retrying")); }, 45_000); timer.unref();
    pending.set(id, { resolve, reject, timer });
    process.send({ type: HUB_TELEGRAM_IPC, direction: "request", id, command }, error => { if (error) { clearTimeout(timer); pending.delete(id); reject(new Error("Desktop bridge unavailable")); } });
  }));
  function send(res: ServerResponse, status: number, value: unknown) { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" }); res.end(JSON.stringify(value)); }
  const remove = host.webServer.register({ kind: "exact", path: "/api/hub/telegram", async handler(req, res) {
    const rejected = host.connection.requestRejection(req);
    if (rejected || req.headers["sec-fetch-site"] === "cross-site" || req.headers["x-hub-telegram"] !== "1") { send(res, rejected ?? 403, { error: "forbidden" }); return; }
    let command: HubTelegramCommand;
    if (req.method === "GET") command = { action: "read" };
    else if (req.method === "POST") {
      if (!/^application\/json(?:;|$)/i.test(String(req.headers["content-type"] ?? ""))) { send(res, 415, { error: "json-required" }); return; }
      try { const chunks: Buffer[] = []; let size = 0; for await (const chunk of req) { size += chunk.length; if (size > 2048) throw new Error(); chunks.push(chunk); } command = parseTelegramCommand(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { send(res, 400, { error: "bad-request" }); return; }
    } else { res.writeHead(405, { allow: "GET, POST" }); res.end(); return; }
    try { send(res, 200, publicState(await native(command))); } catch { send(res, 503, { error: "telegram-unavailable-check-status" }); }
  } });
  return () => { remove(); process.off("message", onMessage); for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error("Telegram bridge closed")); } pending.clear(); };
}
