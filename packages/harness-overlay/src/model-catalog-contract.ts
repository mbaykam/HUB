export interface HubCatalogModel {
  provider: string; id: string; name: string; description?: string;
  contextWindow?: number; maxTokens?: number; created?: number;
  input: string[]; tools: boolean; reasoning: boolean;
  pricing?: { input: number; output: number };
  efforts?: { id: string; name: string }[];
  supportedParameters?:string[];
  defaults?:Record<string,number|string|boolean|null>;
  editableParameters?:string[];
  defaultEffort?:string;
  /** Sanitized live provider schema, retained through catalogue caching. */
  reasoningConfig?:{mandatory?:boolean;default_enabled?:boolean;supported_efforts?:string[]|null;default_effort?:string;supports_max_tokens?:boolean};
  available?:boolean;
  outputLimitFallback?:boolean;
  effortNote?:string;
  enabled: boolean; source: "provider" | "installed" | "upstream";
  favorite?: boolean;
}
/** A capability ceiling is not a reservation for every request. */
export function catalogOutputDefault(model: HubCatalogModel) {
  return Math.min(32768,catalogOutputLimit(model));
}
export interface HubModelCatalog {
  providers: { id: string; name: string }[];
  models: HubCatalogModel[]; refreshedAt: string | null; stale: boolean;
  warning?: string;
}
export function catalogOutputLimit(model: HubCatalogModel) {
  return model.outputLimitFallback ? Math.min(8192,model.contextWindow??8192) : model.maxTokens??model.contextWindow??1_000_000;
}
