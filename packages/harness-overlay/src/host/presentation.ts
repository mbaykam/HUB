import { createHash, randomUUID } from "node:crypto";
import { parsePresentation, parsePresentationSummary, PRESENTATION_TOOL, type Presentation, type PresentationSummary } from "../presentation-contract.ts";
import {containedAppDocument} from "./conversation-artifacts.ts";

const reactiveGuidance = " For interactive Vega charts, put data/signal-dependent mark positions, sizes and labels in encode.update. encode.enter only initializes new marks and will leave controls disconnected from existing marks.";

export interface PresentationTool {
  name: string; description: string; parameters: Record<string, unknown>;
  output: { schema: Record<string, unknown>; render(args: unknown, value: unknown): { type: "text"; text: string }[] };
  execute(args: unknown, exec: { signal: AbortSignal; agent?: { id: string } }): Promise<unknown>;
}
export interface PresentationAgent {
  id: string;
  ctx: {
    tools: { register(definition: PresentationTool): () => void };
    systemPrompt: { section(section: { name: string; order: number; text: string }): () => void };
  };
}

/** Transient screen state only. Native tool arguments/results already retain
 * the original artifact in the ordinary conversation transcript. No new DB. */
export class PresentationRuntime {
  readonly #sessions = new Map<string, { users: number; latest?: Presentation; release(): void }>();
  readonly #recovered = new Map<string, Presentation>();
  recover(sessionId:string,events:readonly any[]) {
    if(this.summary(sessionId))return;
    const item=recordedPresentation(events);
    if(item){this.#recovered.set(sessionId,item);if(this.#recovered.size>128)this.#recovered.delete(this.#recovered.keys().next().value!);}
  }
  attach(agent: PresentationAgent): () => void {
    const existing = this.#sessions.get(agent.id);
    if (existing) {
      existing.users++;
      let active = true;
      return () => { if (active) { active = false; if (--existing.users === 0) existing.release(); } };
    }
    const state: { users: number; latest?: Presentation; release(): void } = { users: 1, release() {} };
    const offTool = agent.ctx.tools.register({
      name: PRESENTATION_TOOL,
      description: "Show or replace this conversation's interactive canvas. Use it proactively for useful explanations, diagrams, charts, simulations and small tools. kind html: passive HTML/SVG; kind vega: Vega v6 JSON; kind app: self-contained HTML with inline CSS/JavaScript and its own touch/keyboard controls. Offline only: no network, storage, host access or agent tool bridge. Local interactions make no model requests. Follow canvas.md for examples and design guidance. Publishing means available, not seen." + reactiveGuidance,
      parameters: { type: "object", properties: { title: { type: "string", maxLength: 120 }, kind: { type: "string", enum: ["html", "vega", "app"] }, html: { type: "string", description: "Passive HTML/SVG for html, or one self-contained HTML/CSS/JavaScript document for app; max 128000 characters", maxLength:128000 }, spec: { type: "object", description: "Vega v6 JSON with inline data, only for kind vega" } }, required: ["title", "kind"], additionalProperties: false },
      output: {
        schema: { type: "object", properties: { id: { type: "string" }, title: { type: "string" }, status: { type: "string", const: "available" } }, required: ["id", "title", "status"], additionalProperties: false },
        render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
      },
      execute: async (args, exec) => {
        exec.signal.throwIfAborted();
        if (exec.agent?.id !== agent.id || this.#sessions.get(agent.id) !== state) throw new Error("Visuals require this active conversation");
        const input = parsePresentation(args);
        state.latest = { ...input, id: randomUUID(), createdAt: Date.now() };
        this.#recovered.delete(agent.id);
        return { id: state.latest.id, title: state.latest.title, status: "available" };
      },
    });
    let offPrompt: () => void;
    try {
      offPrompt = agent.ctx.systemPrompt.section({ name: "hub:visual-explanations", order: 1001, text: "Use hub_present proactively when a diagram, chart, simulation or interactive utility materially helps. Follow shared canvas.md: html is passive, vega uses interpreted signals, app supports inline JavaScript in an offline isolated frame. Supply complete content and its own controls. Each call replaces this conversation's canvas. Keep voice natural. Success means available, not seen." + reactiveGuidance });
    } catch (error) { offTool(); throw error; }
    this.#sessions.set(agent.id, state);
    state.release = () => {
      try { offPrompt(); }
      finally { try { offTool(); } finally { if (this.#sessions.get(agent.id) === state) this.#sessions.delete(agent.id); } }
    };
    let active = true;
    return () => { if (active) { active = false; if (--state.users === 0) state.release(); } };
  }
  summary(sessionId: string): PresentationSummary | null {
    const item = this.#sessions.get(sessionId)?.latest??this.#recovered.get(sessionId);
    return item ? { id: item.id, title: item.title, kind: item.kind, createdAt: item.createdAt } : null;
  }
  document(sessionId: string, id: string, renderer: string): string {
    const item = this.#sessions.get(sessionId)?.latest??this.#recovered.get(sessionId);
    if (!item || item.id !== id) throw new Error("Presentation is no longer current");
    return presentationDocument(item, renderer);
  }
}

/** The only executable script is the pinned renderer hash. The payload is JSON,
 * escaped out of HTML syntax, then sanitized/interpreted inside an opaque frame.
 * No message listener, tool bridge, camera/mic, forms, network or same-origin. */
export function presentationDocument(item: Presentation, renderer: string): string {
  if(item.kind==="app")return containedAppDocument(item.title,item.html);
  const hash = createHash("sha256").update(renderer).digest("base64");
  const csp = `default-src 'none'; script-src 'sha256-${hash}'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; media-src 'none'; base-uri 'none'; form-action 'none'`;
  const payload = JSON.stringify(item).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
  if (/<\/script/i.test(renderer)) throw new Error("Renderer must escape script closing tags");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer"></head><body><main id="visual"></main><script type="application/json" id="visual-data">${payload}</script><script>${renderer}</script></body></html>`;
}

/** Native successful tool receipts are the source of truth after a restart.
 * Never recover a model claim, failed call or content without a matching receipt. */
export function recordedPresentation(events:readonly any[]):Presentation|undefined {
  const calls=new Map<string,unknown>();let latest:Presentation|undefined;
  for(const event of events){
    if(event.type==="tool/call"&&event.data?.name===PRESENTATION_TOOL)calls.set(event.data.callId,event.data.arguments);
    if(event.type!=="tool/result")continue;
    for(const result of event.data?.message?.content??[]){
      if(result.type!=="tool-result"||result.isError!==false||!calls.has(result.toolCallId))continue;
      try{
        const args=calls.get(result.toolCallId),input=parsePresentation(typeof args==="string"?JSON.parse(args):args);
        const text=(result.content??[]).filter((b:any)=>b.type==="text").map((b:any)=>b.text).join("");
        const receipt=JSON.parse(text);if(receipt.status!=="available"||receipt.title!==input.title)continue;
        const summary=parsePresentationSummary({...receipt,kind:input.kind,createdAt:event.time});
        latest={...input,id:summary.id,createdAt:summary.createdAt};
      }catch{/* Incomplete or malformed events cannot manufacture a canvas. */}
    }
  }return latest;
}
