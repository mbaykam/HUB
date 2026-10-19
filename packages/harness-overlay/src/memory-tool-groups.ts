/** Current Knowledge operations stay independently permissioned. Legacy MCP
 * memory belongs to the retired store, not the portable second brain. */
export const isLegacyMemoryTool=(name:string)=>name.startsWith("mcp__hub_memory__");
export const knowledgeToolChoices=[
  {name:"hub_knowledge_search",description:"Search relevant saved knowledge and original conversations."},
  {name:"hub_knowledge_read",description:"Read original sources and their sourced connections."},
  {name:"hub_memory_index",description:"Browse domains, saved sources and the chat archive."},
  {name:"hub_knowledge_write_note",description:"Save a new note only after an explicit user request."},
  {name:"hub_skill_read",description:"Find and read reusable skills."},
  {name:"hub_skill_save",description:"Save a verified reusable workflow without granting permissions."},
];
export function memoryToolGroup(name:string){
  if(isLegacyMemoryTool(name))return "Legacy memory (unused)";
  if(["hub_knowledge_search","hub_knowledge_read","hub_memory_index"].includes(name))return "Read memory";
  if(name==="hub_knowledge_write_note")return "Save notes";
  if(name.startsWith("hub_skill_"))return "Skills";
  return "Other tools";
}
