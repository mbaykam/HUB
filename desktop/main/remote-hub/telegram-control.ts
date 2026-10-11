import { HUB_TELEGRAM_IPC, parseTelegramCommand, type HubTelegramCommand } from "@minke/harness-overlay/telegram-control-contract.ts";
import type { ChildProcess } from "node:child_process";
/** Only the owned Harness child reaches this port. Tokens never enter diagnostics. */
export function bindTelegramControl(child: ChildProcess, control: (command: HubTelegramCommand) => Promise<unknown>) {
  const seen = new Set<string>(); let active = 0, closed = false;
  const onMessage = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    const m = value as Record<string, unknown>;
    if (m.type !== HUB_TELEGRAM_IPC || m.direction !== "request" || typeof m.id !== "string" || !/^[a-f0-9-]{36}$/.test(m.id) || closed) return;
    const id = m.id;
    const send = (data: unknown) => { if (!closed && child.connected) child.send({ type: HUB_TELEGRAM_IPC, direction: "response", id, ...data as object }, () => {}); };
    if (seen.has(id) || active >= 8) { send({ ok: false, error: "control-busy" }); return; }
    let command;
    try { command = parseTelegramCommand(m.command); } catch { send({ ok: false, error: "invalid-command" }); return; }
    seen.add(id); if (seen.size > 256) seen.delete(seen.values().next().value!); active++;
    void control(command).then(value => send({ ok: true, value }), () => send({ ok: false, error: "telegram-control-failed" })).finally(() => { active--; });
  };
  child.on("message", onMessage);
  const dispose = () => { closed = true; child.off("message", onMessage); };
  child.once("exit", dispose);
  return dispose;
}
