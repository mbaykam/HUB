import {billingBasis, type BillingBasis, type HelperRouting} from "./helper-routing.ts";

/** Public text and recorded operations only. Reasoning blocks are never exposed. */
export interface HelperWork {
  brief: string;
  running: boolean;
  outcome: "running" | "done" | "failed" | "stopped" | "waiting" | "retrying";
  currentOperation?: string;
  findings?: string;
  result?: string;
  blocker?: string;
  routing?: HelperRouting;
  actualRoute?: {provider: string; model: string; billingBasis: BillingBasis; evidence: "request" | "response"};
  routeChanges: {provider: string; model: string; billingBasis: BillingBasis; at: number}[];
  entries: ({kind: "step"; title: string; detail?: string; result?: string; status: "running" | "done" | "failed" | "stopped"; failed: boolean; at: number} | {kind: "text"; text: string; at: number} | {kind: "event"; title: string; detail?: string; at: number})[];
}

const MAX_ENTRIES = 200;
const text = (message: any) => (message?.content ?? []).filter((b: any) => b?.type === "text" && typeof b.text === "string").map((b: any) => b.text).join("\n").trim();
const brief = (value: unknown) => {
  if (value === undefined) return undefined;
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  try {
    const args = typeof value === "string" ? JSON.parse(value) : value;
    for (const key of ["description", "query", "url", "command", "file_path", "path", "action", "prompt"]) if (typeof args?.[key] === "string" && args[key].trim()) return args[key].trim().slice(0, 160);
  } catch { /* plain text arguments */ }
  return raw?.slice(0, 160);
};
const failureText = (reason: any) => typeof reason?.failure?.message === "string" ? reason.failure.message.slice(0, 1000) : typeof reason?.message === "string" ? reason.message.slice(0, 1000) : undefined;

export function helperWork(events: readonly any[], liveRunning?: boolean): HelperWork {
  let first = "", running = false, end: string | undefined, lastText: string | undefined, blocker: string | undefined;
  let currentOperation: string | undefined, waiting = false, retrying = false, routing: HelperRouting | undefined, actualRoute: HelperWork["actualRoute"];
  const entries: HelperWork["entries"] = [], steps = new Map<string, number>(), pending = new Set<string>(), routeChanges: HelperWork["routeChanges"] = [];
  const observeRoute = (route: any, at: number, evidence: "request" | "response") => {
    if (typeof route?.provider !== "string" || typeof route?.model !== "string") return;
    const changed = actualRoute && (actualRoute.provider !== route.provider || actualRoute.model !== route.model);
    actualRoute = {provider: route.provider, model: route.model, billingBasis: billingBasis(route), evidence};
    if (changed) routeChanges.push({provider: route.provider, model: route.model, billingBasis: billingBasis(route), at});
  };
  for (const event of events) {
    const at = Number(event.time) || 0, data = event.data;
    if (event.type === "user/message" && !first) first = text(data?.message);
    else if (event.type === "hub/helper-route" && typeof data?.preset === "string" && typeof data?.provider === "string" && typeof data?.model === "string" && typeof data?.reason === "string") routing = {...data, billingBasis: billingBasis(data)};
    else if (event.type === "request/header") observeRoute(data?.header?.config, at, "request");
    else if (event.type === "turn/start") { running = true; end = undefined; waiting = false; retrying = false; blocker = undefined; currentOperation = undefined; pending.clear(); }
    else if (event.type === "turn/end") {
      running = false; end = data?.reason?.kind; waiting = false; retrying = false; currentOperation = undefined;
      blocker = failureText(data?.reason);
      for (const id of pending) { const entry = entries[steps.get(id)!]; if (entry?.kind === "step") entry.status = "stopped"; }
      pending.clear();
    }
    else if (event.type === "llm/retry" || event.type === "llm/retry-started") {
      waiting = event.type === "llm/retry"; retrying = !waiting; currentOperation = waiting ? "Waiting to retry model request" : "Retrying model request";
      blocker = failureText(data) ?? data?.failure?.code;
      entries.push({kind: "event", title: currentOperation, detail: blocker, at});
    }
    else if (event.type === "assistant/message") {
      observeRoute(data?.message?.source, at, "response"); waiting = false; retrying = false; blocker = undefined;
      if (!pending.size) currentOperation = undefined;
      const value: string = text(data?.message).slice(0, 6000); if (value) {lastText = value; entries.push({kind: "text", text: value, at});}
    }
    else if (event.type === "tool/call" && typeof data?.name === "string") {
      waiting = false; retrying = false; steps.set(data.callId, entries.length); pending.add(data.callId);
      const detail = brief(data.arguments); currentOperation = data.name + (detail ? ": " + detail : "");
      entries.push({kind: "step", title: data.name, detail, status: "running", failed: false, at});
    } else if (event.type === "tool/result") {
      for (const result of data?.message?.content ?? []) {
        const index = steps.get(result?.toolCallId), entry = index === undefined ? undefined : entries[index];
        pending.delete(result?.toolCallId);
        if (entry?.kind === "step") { entry.failed = result?.isError === true; entry.status = entry.failed ? "failed" : "done"; entry.result = text(result).slice(0, 1000) || undefined; }
      }
      const last = [...pending].at(-1), entry = last ? entries[steps.get(last)!] : undefined;
      currentOperation = entry?.kind === "step" ? entry.title + (entry.detail ? ": " + entry.detail : "") : undefined;
    }
  }
  running = liveRunning ?? running;
  const outcome = running ? waiting ? "waiting" : retrying ? "retrying" : "running" : end === "error" ? "failed" : end && ["aborted", "interrupted"].includes(end) ? "stopped" : end === "completed" ? "done" : "waiting";
  if (!running) currentOperation = undefined;
  return {brief: first.slice(0, 4000), running, outcome, currentOperation, findings: outcome !== "done" ? lastText : undefined, result: outcome === "done" ? lastText : undefined, blocker, routing, actualRoute, routeChanges, entries: entries.slice(-MAX_ENTRIES)};
}
