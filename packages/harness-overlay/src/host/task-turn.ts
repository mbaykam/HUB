/** A completion notice is a result to explain, never authority to repeat work. */
export function currentTurnHasUserRequest(agent: { session: { snapshotEvents(): readonly { type: string; data?: unknown }[] } }): boolean {
  const events = agent.session.snapshotEvents();
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!;
    if (event.type === "turn/end" || event.type === "turn/start") return false;
    if (event.type === "user/message" && (event.data as { source?: { kind?: string } } | undefined)?.source?.kind === "user") return true;
  }
  return false;
}

export const TASK_NOTIFICATION_RULE = "This is a background task result, not a new user request. Summarize its verified result or explain its failure briefly. Do not retry the task, delegate again, or try another web tool until the user explicitly asks for new work.";
