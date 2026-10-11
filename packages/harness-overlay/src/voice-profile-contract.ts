import { z } from "zod";

const identifier = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/);
const modelIdentifier = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._/:-]*$/);
export const voiceRouteSchema = z.object({
  provider: identifier, model: modelIdentifier, reasoningEffort: identifier.optional(),
}).strict();
// These are configuration identifiers, not paths or executable commands.
// The host must separately resolve their availability before admitting audio.
const kokoroVoice = z.string().max(60).regex(/^[ab][fm]_[a-z0-9_]+$/);
const piperModel = z.enum(["en_US-ljspeech-high", "tr_TR-dfki-medium"]);
const multilingualVoice = z.enum(["F1","F2","F3","F4","F5","M1","M2","M3","M4","M5"]);
export const whisperModels = ["tiny.en", "base.en", "small.en", "medium.en", "tiny", "base", "small", "medium"] as const;
export const speechLanguageSchema = z.enum(["auto", "en", "tr"]);
const whisperModelSchema = z.enum(whisperModels);
const nemotronModelSchema = z.literal("3.5-560ms");
export const localSpeechSchema = z.object({
  stt: z.discriminatedUnion("engine", [
    z.object({ engine: z.literal("whisper"), model: whisperModelSchema, language: speechLanguageSchema.optional() }).strict(),
    z.object({ engine: z.literal("nemotron"), model: nemotronModelSchema, language: speechLanguageSchema.optional() }).strict(),
  ]),
  tts: z.discriminatedUnion("engine", [
    z.object({ engine: z.literal("supertonic"), model: z.literal("supertonic-3"), voice: multilingualVoice, language: speechLanguageSchema.optional(), steps: z.number().int().min(4).max(8).optional() }).strict(),
    z.object({ engine: z.literal("kokoro"), model: z.literal("82m"), voice: kokoroVoice }).strict(),
    z.object({ engine: z.literal("piper"), model: piperModel, voice: piperModel }).strict(),
    z.object({ engine: z.literal("bilingual"), model: z.literal("kokoro-piper"), voice: kokoroVoice, turkishVoice: z.literal("tr_TR-dfki-medium"), language: speechLanguageSchema.optional() }).strict(),
  ]),
}).strict();
export const voiceToolPolicySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("inherit") }).strict(),
  z.object({ mode: z.literal("allow"), names: z.array(identifier).max(512).refine(names => new Set(names).size === names.length, "Duplicate tools") }).strict(),
]);
export const voiceProfileInputSchema = z.object({
  name: z.string().trim().min(1).max(60),
  instructions: z.string().max(12000),
  route: voiceRouteSchema,
  speech: localSpeechSchema,
  tools: voiceToolPolicySchema,
}).strict();
export const voiceProfileSchema = voiceProfileInputSchema.extend({ id: z.string().uuid() }).strict();
export const voiceProfilesStateSchema = z.object({
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1),
  selectedId: z.string().uuid(),
  profiles: z.array(voiceProfileSchema).min(1).max(50),
}).strict().superRefine((state, ctx) => {
  if (new Set(state.profiles.map(profile => profile.id)).size !== state.profiles.length) ctx.addIssue({ code: "custom", message: "Duplicate profile identity" });
  if (!state.profiles.some(profile => profile.id === state.selectedId)) ctx.addIssue({ code: "custom", message: "Selected profile is missing" });
});
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1);
const id = z.string().uuid();
export const voiceProfileCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("create"), revision, profile: voiceProfileInputSchema }).strict(),
  z.object({ type: z.literal("edit"), revision, id, profile: voiceProfileInputSchema }).strict(),
  z.object({ type: z.literal("duplicate"), revision, id, name: z.string().trim().min(1).max(60) }).strict(),
  z.object({ type: z.literal("delete"), revision, id }).strict(),
  z.object({ type: z.literal("select"), revision, id }).strict(),
]);
export type VoiceProfile = z.infer<typeof voiceProfileSchema>;
export type VoiceProfileInput = z.infer<typeof voiceProfileInputSchema>;
export type VoiceProfilesState = z.infer<typeof voiceProfilesStateSchema>;
export type VoiceProfileCommand = z.infer<typeof voiceProfileCommandSchema>;
export type VoiceToolPolicy = z.infer<typeof voiceToolPolicySchema>;
export type LocalSpeechConfig = z.infer<typeof localSpeechSchema>;
export const localSpeechCatalogSchema = z.object({
  stt: z.array(z.discriminatedUnion("engine", [
    z.object({ engine: z.literal("whisper"), model: whisperModelSchema, available: z.boolean(), downloadable: z.boolean().default(false), reason: z.string().max(300).nullable() }).strict(),
    z.object({ engine: z.literal("nemotron"), model: nemotronModelSchema, available: z.boolean(), downloadable: z.boolean().default(false), reason: z.string().max(300).nullable() }).strict(),
  ])).max(9),
  tts: z.array(z.discriminatedUnion("engine", [
    z.object({ engine: z.literal("supertonic"), model: z.literal("supertonic-3"), available: z.boolean(), downloadable: z.boolean().default(false), voices: z.array(multilingualVoice).max(10), reason: z.string().max(300).nullable() }).strict(),
    z.object({ engine: z.literal("kokoro"), model: z.literal("82m"), available: z.boolean(), downloadable: z.boolean().default(false), voices: z.array(kokoroVoice).max(100), reason: z.string().max(300).nullable() }).strict(),
    z.object({ engine: z.literal("piper"), model: piperModel, available: z.boolean(), downloadable: z.boolean().default(false), voices: z.array(piperModel).max(1), reason: z.string().max(300).nullable() }).strict(),
    z.object({ engine: z.literal("bilingual"), model: z.literal("kokoro-piper"), available: z.boolean(), downloadable: z.boolean().default(false), voices: z.array(kokoroVoice).max(100), reason: z.string().max(300).nullable() }).strict(),
  ])).max(5),
}).strict();
export const speechModelInstallSchema = z.discriminatedUnion("engine", [
  z.object({ engine: z.literal("supertonic"), model: z.literal("supertonic-3") }).strict(),
  z.object({ engine: z.literal("whisper"), model: whisperModelSchema }).strict(),
  z.object({ engine: z.literal("nemotron"), model: nemotronModelSchema }).strict(),
  z.object({ engine: z.literal("piper"), model: piperModel }).strict(),
]);
export type SpeechModelInstall = z.infer<typeof speechModelInstallSchema>;
export const speechDownloadStatusSchema = z.object({
  download: z.object({ id: z.string().uuid(), engine: z.enum(["whisper", "piper", "supertonic", "nemotron"]), model: z.string().max(100),
    phase: z.enum(["starting", "downloading", "verifying", "complete", "failed"]),
  }).strict().nullable(),
}).strict();
export type LocalSpeechCatalog = z.infer<typeof localSpeechCatalogSchema>;
