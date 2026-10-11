export const PRESENTATION_TOOL = "hub_present";
export type PresentationInput = { title: string; kind: "html"; html: string } | { title: string; kind: "vega"; spec: Record<string, unknown> };
export interface PresentationSummary { id: string; title: string; kind: "html" | "vega"; createdAt: number }
export type Presentation = PresentationInput & PresentationSummary;

/** Bounded, offline, data-only visuals. JavaScript is supplied only by HUB's
 * pinned renderer, not by model strings. Vega expressions use its interpreter. */
export function parsePresentation(value: unknown): PresentationInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Expected a visual explanation");
  const input = value as Record<string, unknown>;
  if (typeof input.title !== "string" || !input.title.trim() || input.title.length > 120) throw new TypeError("Use a title of 1–120 characters");
  const title = input.title.trim();
  if (input.kind === "html") {
    if (typeof input.html !== "string" || !input.html.trim() || input.html.length > 128_000) throw new TypeError("Use up to 128,000 characters of passive HTML/SVG");
    return { title, kind: "html", html: input.html };
  }
  if (input.kind !== "vega" || !input.spec || typeof input.spec !== "object" || Array.isArray(input.spec)) throw new TypeError("Use kind html or vega with its content");
  const source = JSON.stringify(input.spec);
  if (source.length > 128_000) throw new TypeError("Vega specification is too large");
  const spec = input.spec as Record<string, unknown>;
  let count = 0;
  function check(node: unknown, depth: number) {
    if (++count > 20_000 || depth > 32) throw new TypeError("Visual is too complex");
    if (typeof node === "number" && !Number.isFinite(node)) throw new TypeError("Visual numbers must be finite");
    if (Array.isArray(node)) { if (node.length > 5000) throw new TypeError("Use at most 5,000 data items"); node.forEach(item => check(item, depth + 1)); return; }
    if (!node || typeof node !== "object") return;
    const item = node as Record<string, unknown>;
    for (const key of Object.keys(item)) {
      if (["__proto__", "constructor", "prototype", "url", "href"].includes(key)) throw new TypeError("Visuals must be self-contained without links or external data");
      check(item[key], depth + 1);
    }
    if (item.type === "sequence") {
      const { start = 0, stop, step = 1 } = item;
      if (typeof start !== "number" || typeof stop !== "number" || typeof step !== "number" || step === 0 || Math.abs((stop - start) / step) > 5000) throw new TypeError("Sequence transforms require a bounded numeric range");
    }
    if (["cross", "kde2d", "contour", "density", "regression", "loess"].includes(String(item.type))) throw new TypeError("Precompute large statistical transforms before presenting");
  }
  check(spec, 0);
  for (const dimension of ["width", "height"]) {
    const size = spec[dimension];
    if (size !== undefined && (typeof size !== "number" || size < 1 || size > 1600)) throw new TypeError("Visual dimensions must be between 1 and 1600");
  }
  return { title, kind: "vega", spec: JSON.parse(source) as Record<string, unknown> };
}

export function parsePresentationSummary(value: unknown): PresentationSummary {
  if (!value || typeof value !== "object") throw new TypeError("Invalid presentation");
  const item = value as PresentationSummary;
  if (typeof item.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item.id) || typeof item.title !== "string" || !item.title.trim() || item.title.length > 120 || !["html", "vega"].includes(item.kind) || !Number.isSafeInteger(item.createdAt) || item.createdAt < 0) throw new TypeError("Invalid presentation");
  return { id: item.id, title: item.title, kind: item.kind, createdAt: item.createdAt };
}
