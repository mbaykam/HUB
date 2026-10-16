import {z} from "zod";
import {localSpeechSchema,type LocalSpeechConfig} from "./voice-profile-contract.ts";

export const speechSettingsSchema=z.object({revision:z.number().int().nonnegative(),speech:localSpeechSchema}).strict();
export type SpeechSettings=z.infer<typeof speechSettingsSchema>;
/** Engines, languages and quality belong to HUB. Characters only contribute a
 * compatible voice. Older character engine settings are retained for rollback. */
export function characterSpeech(shared:LocalSpeechConfig,character:LocalSpeechConfig|null):LocalSpeechConfig {
  if(!character||character.tts.engine!==shared.tts.engine)return structuredClone(shared);
  const candidate=localSpeechSchema.safeParse({...shared,tts:{...shared.tts,voice:character.tts.voice}});
  return candidate.success?candidate.data:structuredClone(shared);
}
