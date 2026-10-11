export type HubTelegramCommand = { action: "read" | "reconnect" } | { action: "connect"; token: string } | { action: "approve"; requestId: string };
export function parseTelegramCommand(value: unknown): HubTelegramCommand {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Telegram command");
  const c = value as Record<string, unknown>, keys = Object.keys(c);
  if ((c.action === "read" || c.action === "reconnect") && keys.length === 1) return { action: c.action };
  if (c.action === "connect" && keys.length === 2 && typeof c.token === "string" && /^\d{6,16}:[A-Za-z0-9_-]{30,100}$/.test(c.token)) return { action: "connect", token: c.token };
  if (c.action === "approve" && keys.length === 2 && typeof c.requestId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(c.requestId)) return { action: "approve", requestId: c.requestId };
  throw new Error("Invalid Telegram command");
}
export const HUB_TELEGRAM_IPC = "hub-telegram-control-v1";
