/** Used verbatim in the pinned chat renderer patch. Preserve code and real
 * formula delimiters; a numeric dollar followed by prose is currency. */
export function escapeCurrencyMarkdown(text) {
  return text.split(/(`{3,}[\s\S]*?`{3,}|~{3,}[\s\S]*?~{3,}|`[^`\n]*`)/g).map((part,index)=>{
    if(index%2)return part;
    return part.replace(/(?<!\\)\$(?=\d)/g,(dollar,at)=>{
      const rest=part.slice(at+1),end=rest.indexOf('$');
      if(end>=0){const formula=rest.slice(0,end);if(formula&&!/\n/.test(formula)&&/^[\d\sA-Za-z.,+*/=^_{}()\\-]+$/.test(formula)&&!/(?:\d|\s)[A-Za-z]{2,}/.test(formula)&&!/[+*/=^_-]$/.test(formula.trim()))return dollar;}
      return '\\$';
    });
  }).join('');
}
