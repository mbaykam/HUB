import type { IncomingMessage, ServerResponse } from "node:http";
import type { PresentationRuntime } from "./presentation.ts";

/** Authenticated read-only access to an already attached conversation's canvas. */
export function createPresentationHandler(runtime: PresentationRuntime, reject: (request: IncomingMessage) => 401 | 403 | undefined, renderer: () => Promise<string>) {
  return async (request: IncomingMessage, response: ServerResponse) => {
    const send = (code: number, body: unknown) => { response.writeHead(code, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" }); response.end(JSON.stringify(body)); };
    const rejection = reject(request);
    if (rejection || request.headers["sec-fetch-site"] === "cross-site") { send(rejection ?? 403, { error: "unauthorized" }); return; }
    if (request.method !== "GET") { send(405, { error: "method-not-allowed" }); return; }
    const session = request.headers["x-hub-session"];
    if (typeof session !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(session)) { send(400, { error: "invalid-session" }); return; }
    if (request.url === "/api/hub/presentation") { send(200, { presentation: runtime.summary(session) }); return; }
    const id = request.headers["x-hub-presentation"];
    if (typeof id !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) { send(400, { error: "invalid-presentation" }); return; }
    try { send(200, { document: runtime.document(session, id, await renderer()) }); }
    catch { send(404, { error: "presentation-unavailable" }); }
  };
}
