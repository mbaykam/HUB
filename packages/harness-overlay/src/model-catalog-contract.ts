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
  enabled: boolean; source: "provider" | "installed" | "upstream";
  favorite?: boolean;
}
export interface HubModelCatalog {
  providers: { id: string; name: string }[];
  models: HubCatalogModel[]; refreshedAt: string | null; stale: boolean;
  warning?: string;
}
