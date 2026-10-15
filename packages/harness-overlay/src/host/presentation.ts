import { createHash, randomUUID } from "node:crypto";
import { parsePresentation, PRESENTATION_TOOL, type Presentation, type PresentationSummary } from "../presentation-contract.ts";

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
      description: "Show or update a concise visual explanation in this HUB conversation. Use passive HTML/SVG with inline styles for diagrams, or a self-contained Vega v6 JSON specification for interactive sliders/plots. No model JavaScript, links, external images or fetched data. The user can dismiss or reopen the canvas. Publishing is not proof the user has seen it.",
      parameters: { type: "object", properties: { title: { type: "string", maxLength: 120 }, kind: { type: "string", enum: ["html", "vega"] }, html: { type: "string", description: "Passive HTML/SVG, only for kind html" }, spec: { type: "object", description: "Vega v6 JSON with inline data, only for kind vega" } }, required: ["title", "kind"], additionalProperties: false },
      output: {
        schema: { type: "object", properties: { id: { type: "string" }, title: { type: "string" }, status: { type: "string", const: "available" } }, required: ["id", "title", "status"], additionalProperties: false },
        render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
      },
      execute: async (args, exec) => {
        exec.signal.throwIfAborted();
        if (exec.agent?.id !== agent.id || this.#sessions.get(agent.id) !== state) throw new Error("Visuals require this active conversation");
        const input = parsePresentation(args);
        state.latest = { ...input, id: randomUUID(), createdAt: Date.now() };
        return { id: state.latest.id, title: state.latest.title, status: "available" };
      },
    });
    let offPrompt: () => void;
    try {
      offPrompt = agent.ctx.systemPrompt.section({ name: "hub:visual-explanations", order: 1001, text: "Use hub_present when a diagram or interactive example would materially help your explanation. Each call updates this conversation's canvas. Keep speaking naturally during voice. Prefer simple, readable dark visuals with pale text and blue/teal accents. HTML/SVG must be passive and use inline styles. Interactive examples use Vega v6 signals with standard range/select bindings and inline data; arbitrary JavaScript and external data/links are unavailable. Do not claim a visual was displayed or seen until the user confirms; the tool makes it available in HUB, and they may dismiss it." });
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
    const item = this.#sessions.get(sessionId)?.latest;
    return item ? { id: item.id, title: item.title, kind: item.kind, createdAt: item.createdAt } : null;
  }
  document(sessionId: string, id: string, renderer: string): string {
    const item = this.#sessions.get(sessionId)?.latest;
    if (!item || item.id !== id) throw new Error("Presentation is no longer current");
    return presentationDocument(item, renderer);
  }
}

/** The only executable script is the pinned renderer hash. The payload is JSON,
 * escaped out of HTML syntax, then sanitized/interpreted inside an opaque frame.
 * No message listener, tool bridge, camera/mic, forms, network or same-origin. */
export function presentationDocument(item: Presentation, renderer: string): string {
  const hash = createHash("sha256").update(renderer).digest("base64");
  const csp = `default-src 'none'; script-src 'sha256-${hash}'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; media-src 'none'; base-uri 'none'; form-action 'none'`;
  const payload = JSON.stringify(item).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
  if (/<\/script/i.test(renderer)) throw new Error("Renderer must escape script closing tags");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer"></head><body><main id="visual"></main><script type="application/json" id="visual-data">${payload}</script><script>${renderer}</script></body></html>`;
}
