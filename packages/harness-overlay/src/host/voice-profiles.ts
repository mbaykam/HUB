import { randomUUID } from "node:crypto";
import { voiceProfileCommandSchema, voiceProfileInputSchema, voiceProfilesStateSchema, type VoiceProfileInput, type VoiceProfilesState } from "../voice-profile-contract.ts";

export const voiceProfilesDomain = {
  name: "hub_voice_profiles", version: 1,
  tables: { state: { valueSchema: voiceProfilesStateSchema } },
};
interface ProfileTable {
  get(key: string): VoiceProfilesState | undefined;
  put(key: string, value: VoiceProfilesState): Promise<void>;
  update(key: string, transform: (state: VoiceProfilesState) => VoiceProfilesState): Promise<VoiceProfilesState>;
}
export interface VoiceProfileStorage {
  open(spec: typeof voiceProfilesDomain): Promise<{ table(name: "state"): ProfileTable; close(): Promise<void> }>;
}
export class VoiceProfileConflict extends Error {
  constructor() { super("Voice settings changed on another screen. Reload before saving."); }
}
export class VoiceProfileOperationError extends Error {
  readonly code: "profile-not-found" | "last-profile";
  constructor(code: VoiceProfileOperationError["code"]) {
    super(code === "last-profile" ? "Keep at least one voice personality" : "Voice personality no longer exists");
    this.code = code;
  }
}

/** One native durable record makes profile edits, selection and revision atomic.
 * Native storage owns validation, serialization and persistence. No transcripts,
 * credentials, permission grants or separate memory banks are stored here. */
export async function openVoiceProfiles(storage: VoiceProfileStorage, initial: VoiceProfileInput) {
  const seed = voiceProfileInputSchema.parse(initial);
  const domain = await storage.open(voiceProfilesDomain);
  const table = domain.table("state");
  let closed = false;
  try {
    if (!table.get("profiles")) {
      const id = randomUUID();
      await table.put("profiles", { revision: 0, selectedId: id, profiles: [{ ...seed, id }] });
    }
    voiceProfilesStateSchema.parse(table.get("profiles"));
  } catch (error) { await domain.close(); throw error; }
  const snapshot = () => {
    if (closed) throw new Error("Voice profiles are closed");
    // Never lend storage objects to browser serializers or call-time overlays.
    return voiceProfilesStateSchema.parse(table.get("profiles"));
  };
  return {
    snapshot,
    selected() { const state = snapshot(); return state.profiles.find(profile => profile.id === state.selectedId)!; },
    async change(value: unknown) {
      if (closed) throw new Error("Voice profiles are closed");
      const command = voiceProfileCommandSchema.parse(value);
      const mintedId = randomUUID();
      const updated = await table.update("profiles", current => {
        if (current.revision !== command.revision) throw new VoiceProfileConflict();
        const state = voiceProfilesStateSchema.parse(current);
        if (command.type !== "create" && !state.profiles.some(profile => profile.id === command.id)) throw new VoiceProfileOperationError("profile-not-found");
        switch (command.type) {
          case "create": state.profiles.push({ ...command.profile, id: mintedId }); break;
          case "duplicate": state.profiles.push({ ...state.profiles.find(profile => profile.id === command.id)!, id: mintedId, name: command.name }); break;
          case "edit": state.profiles = state.profiles.map(profile => profile.id === command.id ? { ...command.profile, id: profile.id } : profile); break;
          case "delete":
            if (state.profiles.length === 1) throw new VoiceProfileOperationError("last-profile");
            state.profiles = state.profiles.filter(profile => profile.id !== command.id);
            if (state.selectedId === command.id) state.selectedId = state.profiles[0]!.id;
            break;
          case "select": state.selectedId = command.id; break;
        }
        state.revision++;
        return voiceProfilesStateSchema.parse(state);
      });
      return voiceProfilesStateSchema.parse(updated);
    },
    async close() { if (!closed) { closed = true; await domain.close(); } },
  };
}
