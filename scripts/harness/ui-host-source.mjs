/** Text-only host contract inputs must hash identically after Git checkout on
 * Windows/Linux. Literal escaped newlines remain meaningful; checkout CRLFs do not. */
export function canonicalHostSource(bytes){
 return new TextDecoder('utf-8',{fatal:true}).decode(bytes).replace(/\r\n/gu,'\n');
}
