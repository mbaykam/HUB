/** Read-only PWA viewing channel. Deliberately separate from browser tools:
 * watching must never claim control, focus a tab or invalidate agent refs. */
export const BROWSER_VIEW_CHANNEL = "hub:browser-view:v1";
export const BROWSER_VIEW_ROUTE = "/api/hub/browser-view";
export interface BrowserViewTab {
  sessionId: string;
  ownerSessionId: string;
  title: string;
  url: string;
  status: string;
  owner: "agent" | "human";
}
export interface BrowserViewFrame {
  tab: BrowserViewTab;
  capturedAt: number;
  width: number;
  height: number;
  mimeType: "image/jpeg";
  data: string;
}
export type BrowserViewQuery = { type: "list" } | { type: "frame"; ownerSessionId: string; sessionId: string };
export function browserViewId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value)) throw new TypeError("Invalid browser view ID");
  return value;
}
export function parseBrowserViewQuery(value: unknown): BrowserViewQuery {
  if (!value || typeof value !== "object") throw new TypeError("Invalid browser view query");
  const query = value as Record<string, unknown>;
  if (query.type === "list") return { type: "list" };
  if (query.type === "frame") return { type: "frame", ownerSessionId: browserViewId(query.ownerSessionId), sessionId: browserViewId(query.sessionId) };
  throw new TypeError("Invalid browser view operation");
}
export function parseBrowserViewTab(value: unknown): BrowserViewTab {
  if (!value || typeof value !== "object") throw new TypeError("Invalid browser tab");
  const tab = value as Record<string, unknown>;
  if (tab.owner !== "agent" && tab.owner !== "human") throw new TypeError("Invalid browser owner");
  for (const key of ["title", "url", "status"]) if (typeof tab[key] !== "string" || (tab[key] as string).length > 8192) throw new TypeError("Invalid browser metadata");
  return { sessionId: browserViewId(tab.sessionId), ownerSessionId: browserViewId(tab.ownerSessionId), owner: tab.owner, title: tab.title as string, url: tab.url as string, status: tab.status as string };
}
export function parseBrowserViewResult(query: BrowserViewQuery, value: unknown): BrowserViewTab[] | BrowserViewFrame {
  if (query.type === "list") {
    if (!Array.isArray(value) || value.length > 32) throw new TypeError("Invalid browser list");
    return value.map(parseBrowserViewTab);
  }
  if (!value || typeof value !== "object") throw new TypeError("Invalid browser frame");
  const frame = value as BrowserViewFrame;
  const tab = parseBrowserViewTab(frame.tab);
  if (tab.sessionId !== query.sessionId || tab.ownerSessionId !== query.ownerSessionId || frame.mimeType !== "image/jpeg" ||
      !Number.isSafeInteger(frame.capturedAt) || frame.capturedAt < 0 ||
      !Number.isSafeInteger(frame.width) || frame.width < 1 || frame.width > 1024 ||
      !Number.isSafeInteger(frame.height) || frame.height < 1 || frame.height > 4096 ||
      typeof frame.data !== "string" || frame.data.length > 3_000_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(frame.data)) throw new TypeError("Invalid browser frame");
  return { tab, capturedAt: frame.capturedAt, width: frame.width, height: frame.height, mimeType: frame.mimeType, data: frame.data };
}
