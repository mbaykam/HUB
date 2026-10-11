import { z } from "zod";
import { localSpeechSchema, voiceRouteSchema, voiceToolPolicySchema } from "./voice-profile-contract.ts";

export const characterSchema = z.object({
  id: z.string().uuid(), name: z.string().trim().min(1).max(60),
  avatar: z.enum(["hub", "voice", "devil", "mint", "rose", "amber"]),
  description: z.string().max(240), instructions: z.string().max(12000),
  route: voiceRouteSchema.nullable(), tools: voiceToolPolicySchema,
  speech: localSpeechSchema.nullable(), delegateTo: z.string().uuid().nullable(),
}).strict();
export const charactersStateSchema = z.object({
  revision: z.number().int().nonnegative(), mainId: z.string().uuid(), voiceId: z.string().uuid(),
  characters: z.array(characterSchema).min(2).max(50),
  bindings: z.record(z.string().max(200), z.string().uuid()),
}).strict().superRefine((s,c) => {
  const ids = new Set(s.characters.map(x=>x.id));
  if(new Set(s.characters.map(x=>x.name.toLowerCase())).size!==s.characters.length)c.addIssue({code:"custom",message:"Character names must be unique"});
  if(ids.size!==s.characters.length || !ids.has(s.mainId) || !ids.has(s.voiceId)) c.addIssue({code:"custom",message:"Invalid character selection"});
  for(const x of s.characters) if(x.delegateTo && (!ids.has(x.delegateTo) || x.delegateTo===x.id)) c.addIssue({code:"custom",message:"Invalid delegation target"});
  for(const id of Object.values(s.bindings)) if(!ids.has(id)) c.addIssue({code:"custom",message:"Invalid conversation character"});
  if(!s.characters.find(x=>x.id===s.mainId)?.route) c.addIssue({code:"custom",message:"Main character needs a model"});
  const voice=s.characters.find(x=>x.id===s.voiceId);
  if(!voice?.route || !voice.speech) c.addIssue({code:"custom",message:"Voice character needs a model and local speech"});
});
const revision=z.number().int().nonnegative(), id=z.string().uuid();
export const characterCommandSchema=z.discriminatedUnion("action",[
  z.object({action:z.literal("save"),revision,character:characterSchema}).strict(),
  z.object({action:z.literal("create"),revision,character:characterSchema.omit({id:true})}).strict(),
  z.object({action:z.literal("delete"),revision,id}).strict(),
  z.object({action:z.literal("main"),revision,id}).strict(),
  z.object({action:z.literal("voice"),revision,id}).strict(),
  z.object({action:z.literal("select"),revision,id,sessionId:z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)}).strict(),
]);
export type HubCharacter=z.infer<typeof characterSchema>;
export type HubCharactersState=z.infer<typeof charactersStateSchema>;
export type HubCharacterCommand=z.infer<typeof characterCommandSchema>;
