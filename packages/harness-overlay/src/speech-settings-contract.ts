import {z} from "zod";
import {localSpeechSchema,type LocalSpeechConfig} from "./voice-profile-contract.ts";

export const speechSettingsSchema=z.object({revision:z.number().int().nonnegative(),speech:localSpeechSchema}).strict();
export type SpeechSettings=z.infer<typeof speechSettingsSchema>;
/** Engines, languages and quality belong to HUB. Characters only contribute a
 * compatible voice. Older character engine settings are retained for rollback. */
/** One assistant, one voice: the voice chosen in Speech settings is the one
 * every call uses. A voice saved on a model slot no longer overrides it (that
 * made the user's choice in Speech have no effect). */
export function characterSpeech(shared:LocalSpeechConfig,_character:LocalSpeechConfig|null):LocalSpeechConfig {
  return structuredClone(shared);
}
