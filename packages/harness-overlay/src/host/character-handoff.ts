import type { HubCharacter } from "../character-contract.ts";

/** Only a direct request to speak to a character authorizes a handoff. Work
 * requests, quoted instructions and background notifications remain delegation. */
export function requestedCharacterHandoff(text: string, characters: readonly HubCharacter[]): HubCharacter | undefined {
  const input = text.trim().replace(/[.!?]+$/u, "").trim();
  for (const character of characters) {
    const name = character.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const english = new RegExp(`^(?:please\\s+)?(?:get(?:\\s+me)?|bring(?:\\s+me)?|call|switch(?:\\s+me)?\\s+to|go\\s+back\\s+to|(?:let\\s+me|I\\s+want\\s+to)\\s+(?:talk|speak)\\s+(?:to|with)|talk\\s+(?:to|with))\\s+${name}(?:\\s+(?:in|here|back|please))?$`, "iu");
    const turkish = new RegExp(`^(?:lütfen\\s+)?${name}(?:['’]?(?:y[ıiuü]|[ıiuüae]))?\\s+(?:çağır|getir|gelsin|ile\\s+konuş(?:mak\\s+istiyorum)?|ile\\s+konuşalım|geri\\s+dön)(?:\\s+lütfen)?$`, "iu");
    if (english.test(input) || turkish.test(input)) return character;
  }
  return undefined;
}

export function currentUserText(agent: { session: { snapshotEvents(): readonly { type: string; data?: unknown }[] } }): string | undefined {
  const events = agent.session.snapshotEvents();
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!;
    if (event.type === "turn/start" || event.type === "turn/end") return undefined;
    const data = event.data as { source?: { kind?: string }; content?: { type?: string; text?: string }[] } | undefined;
    if (event.type === "user/message" && data?.source?.kind === "user") return data.content?.filter(c => c.type === "text").map(c => c.text ?? "").join("\n");
  }
  return undefined;
}
