export function redactKnowledgeSecrets(text:string){return text
  .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|(?:ghp|github_pat)_[A-Za-z0-9_-]{12,})\b/g,"[REDACTED_TOKEN]")
  .replace(/\b\d{6,16}:[A-Za-z0-9_-]{25,}\b/g,"[REDACTED_BOT_TOKEN]")
  .replace(/\bBearer\s+[^\s"']+/gi,"Bearer [REDACTED_TOKEN]")
  .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,"[REDACTED_JWT]")
  .replace(/((?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|password)\s*[=:]\s*["']?)[^\s"',;}]+/gi,"$1[REDACTED_VALUE]");}
