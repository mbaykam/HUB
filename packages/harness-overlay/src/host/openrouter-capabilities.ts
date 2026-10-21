import type {HubCatalogModel} from "../model-catalog-contract.ts";
import {catalogOutputDefault} from "../model-catalog-contract.ts";
const levels=["none","minimal","low","medium","high","xhigh","max"];
export function openRouterReasoning(value:unknown):Pick<HubCatalogModel,"efforts"|"defaultEffort"|"reasoningConfig"|"effortNote"> {
  if(!value||typeof value!=="object"||Array.isArray(value))return {};
  const raw=value as Record<string,unknown>,config:NonNullable<HubCatalogModel["reasoningConfig"]>={};
  for(const key of ["mandatory","default_enabled","supports_max_tokens"] as const)if(typeof raw[key]==="boolean")config[key]=raw[key];
  if(raw.supported_efforts===null)config.supported_efforts=null;
  else if(Array.isArray(raw.supported_efforts))config.supported_efforts=[...new Set(raw.supported_efforts.filter((x):x is string=>typeof x==="string"&&levels.includes(x)))];
  if(typeof raw.default_effort==="string"&&levels.includes(raw.default_effort))config.default_effort=raw.default_effort;
  const offered=config.supported_efforts===null?levels:config.supported_efforts;
  const efforts=offered?.filter(e=>e!=="none"||!config.mandatory).map(e=>({id:e==="none"?"off":e,name:e==="none"?"Off":e==="xhigh"?"Extra high":e[0]!.toUpperCase()+e.slice(1)}));
  return {reasoningConfig:config,...(efforts?{efforts}:{}),...(config.default_effort?{defaultEffort:config.default_effort==="none"?"off":config.default_effort}:{}),
    effortNote:config.mandatory?"Reasoning is required by this model. Levels come from its provider.":"Levels reported by this model’s provider."};
}
export function openRouterEffortProfile(model:HubCatalogModel) {
  return model.efforts?.length?Object.fromEntries(model.efforts.map(e=>[e.id,e.id==="off"?"none":e.id])):undefined;
}
export function prepareOpenRouterRequest(options:{provider:string;model:string;maxTokens?:number;reasoningEffort?:string},models:HubCatalogModel[]) {
  if(options.provider!=="openrouter")return;
  const model=models.find(m=>m.id===options.model);
  if(options.maxTokens===undefined)options.maxTokens=model?catalogOutputDefault(model):32768;
  if(options.reasoningEffort===undefined&&model?.defaultEffort&&model.efforts?.some(e=>e.id===model.defaultEffort))options.reasoningEffort=model.defaultEffort;
}
