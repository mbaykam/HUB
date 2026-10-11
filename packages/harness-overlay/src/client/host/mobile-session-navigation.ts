import type { HarnessClientContext } from "../core/context.ts";

/** Open delegated history through the native catalog, without resuming its agent.
 * @param sessions - Public native selection and catalog services.
 * @param id - Conversation selected from the voice view or task list.
 * @returns Completion after the validated history address has been selected.
 */
export async function openMobileConversation(sessions: HarnessClientContext["sessions"], id: string): Promise<void> {
  let snapshot = sessions.list.getSnapshot();
  const catalogParent = () => Object.entries(snapshot.subagentsByParent ?? {}).find(([, catalog]) =>
    catalog.entries.some(entry => entry.kind === "child" && entry.id === id))?.[0];
  if (!snapshot.byId[id] && !catalogParent()) {
    await sessions.refresh?.();
    snapshot = sessions.list.getSnapshot();
  }
  const summary = snapshot.byId[id];
  const parent = summary?.parentId ?? catalogParent();
  if (summary?.origin !== "subagent" && !catalogParent()) {
    sessions.open(id);
    return;
  }
  if (!parent || !sessions.refreshSubagents || !sessions.openSubagent) {
    throw new Error("The delegated conversation's parent is unavailable");
  }
  await sessions.refreshSubagents(parent);
  const child = sessions.list.getSnapshot().subagentsByParent?.[parent]?.entries.find(entry =>
    entry.kind === "child" && entry.id === id);
  if (!child?.mode) throw new Error("The delegated conversation's catalog is unavailable");
  sessions.openSubagent({ parentSessionId: parent, childSessionId: id, mode: child.mode });
}
