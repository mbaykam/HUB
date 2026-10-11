import type { IncomingMessage, ServerResponse } from "node:http";
import { ZodError } from "zod";
import { VoiceProfileConflict, VoiceProfileOperationError, type openVoiceProfiles } from "./voice-profiles.ts";

export interface ActiveVoiceProfile { id: string; name: string; revision: number; speech?: import("../voice-profile-contract.ts").LocalSpeechConfig }
export function createVoiceProfilesHandler(ports: {
  reject(request: IncomingMessage): 401 | 403 | undefined;
  profiles: Awaited<ReturnType<typeof openVoiceProfiles>>;
  active(): ActiveVoiceProfile | null;
  catalog(provider?: string): Promise<unknown>;
}) {
  return async (request: IncomingMessage, response: ServerResponse) => {
    const send = (status: number, body: unknown) => {
      if (response.destroyed || response.writableEnded) return;
      response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store, private", "x-content-type-options": "nosniff", "cross-origin-resource-policy": "same-origin" });
      response.end(JSON.stringify(body));
    };
    const rejection = ports.reject(request);
    if (rejection || request.headers["sec-fetch-site"] === "cross-site") { send(rejection ?? 403, { error: "unauthorized" }); return; }
    const url = new URL(request.url ?? "/", "http://localhost");
    try {
      if (url.pathname === "/api/hub/voice/catalog") {
        if (request.method !== "GET") { send(405, { error: "method-not-allowed" }); return; }
        const provider = url.searchParams.get("provider");
        if (provider !== null && (!provider || provider.length > 200)) { send(400, { error: "invalid-provider" }); return; }
        send(200, await ports.catalog(provider ?? undefined)); return;
      }
      if (url.pathname !== "/api/hub/voice/profiles") { send(404, { error: "not-found" }); return; }
      if (request.method === "GET") { send(200, { ...ports.profiles.snapshot(), active: ports.active(), appliesAt: "next-call" }); return; }
      if (request.method !== "POST") { send(405, { error: "method-not-allowed" }); return; }
      if (request.headers["x-hub-voice-profiles"] !== "1") { send(403, { error: "unauthorized" }); return; }
      if (request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json") { send(415, { error: "json-required" }); return; }
      const chunks: Buffer[] = []; let size = 0;
      for await (const part of request) {
        const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part); size += bytes.length;
        if (size > 128000) { send(413, { error: "request-too-large" }); return; }
        chunks.push(bytes);
      }
      let value: unknown;
      try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { send(400, { error: "invalid-request" }); return; }
      const state = await ports.profiles.change(value);
      send(200, { ...state, active: ports.active(), appliesAt: "next-call" });
    } catch (error) {
      if (error instanceof VoiceProfileConflict) send(409, { error: "revision-conflict" });
      else if (error instanceof VoiceProfileOperationError) send(error.code === "profile-not-found" ? 404 : 400, { error: error.code });
      else if (error instanceof ZodError) send(400, { error: "invalid-profile" });
      else send(503, { error: "voice-settings-unavailable" });
    }
  };
}
