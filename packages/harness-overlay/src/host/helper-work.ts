/**
 * A helper's work, condensed for reading on the phone: the brief it was
 * given, the steps it took (tool calls, with failures marked) and what it
 * wrote. Read-only; nothing here resumes or changes the helper.
 */
export interface HelperWork {
  brief: string;
  running: boolean;
  outcome: "running" | "done" | "failed" | "stopped";
  entries: ({kind: "step"; title: string; detail?: string; failed: boolean; at: number} | {kind: "text"; text: string; at: number})[];
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
  return raw.slice(0, 160);
};

export function helperWork(events: readonly any[]): HelperWork {
  let first = "", running = false, end: string | undefined;
  const entries: HelperWork["entries"] = [], steps = new Map<string, number>();
  for (const event of events) {
    const at = Number(event.time) || 0;
    if (event.type === "user/message" && !first) first = text(event.data?.message);
    else if (event.type === "turn/start") { running = true; end = undefined; }
    else if (event.type === "turn/end") { running = false; end = event.data?.reason?.kind; }
    else if (event.type === "assistant/message") { const value = text(event.data?.message); if (value) entries.push({kind: "text", text: value.slice(0, 6000), at}); }
    else if (event.type === "tool/call" && typeof event.data?.name === "string") {
      steps.set(event.data.callId, entries.length);
      entries.push({kind: "step", title: event.data.name, detail: brief(event.data.arguments), failed: false, at});
    } else if (event.type === "tool/result") {
      for (const result of event.data?.message?.content ?? []) {
        const index = steps.get(result?.toolCallId);
        const entry = index === undefined ? undefined : entries[index];
        if (entry?.kind === "step" && result?.isError === true) entry.failed = true;
      }
    }
  }
  const outcome = running ? "running" : end === "error" ? "failed" : end && ["aborted", "interrupted"].includes(end) ? "stopped" : "done";
  return {brief: first.slice(0, 4000), running, outcome, entries: entries.slice(-MAX_ENTRIES)};
}
