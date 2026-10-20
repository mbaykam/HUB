import {readFile} from "node:fs/promises";
import {writeFileAtomic} from "./runtime-state.mjs";

function releaseAgeParts(source) {
  const lines=source.replaceAll("\r\n","\n").split("\n");
  const start=lines.findIndex(line=>line==="minimumReleaseAgeExclude:");
  if(start<0)throw new Error("Pinned workspace has no release-age exclusion list");
  let end=start+1;
  while(end<lines.length&&(!lines[end].trim()||/^\s/u.test(lines[end])))end++;
  return {outside:[...lines.slice(0,start),"minimumReleaseAgeExclude:",...lines.slice(end)].join("\n"),list:lines.slice(start+1,end)};
}

/** pnpm can append approval bookkeeping during deploy. Restore only that
 * generated addition, including on a failed command. Never discard other edits
 * or change the installer's existing supply-chain approval rules. */
export async function preservePnpmWorkspace(path,operation) {
  const before=await readFile(path,"utf8");
  try { return await operation(); }
  finally {
    const after=await readFile(path,"utf8");
    if(after!==before){
      const original=releaseAgeParts(before),current=releaseAgeParts(after);
      const exactPackage=/^  - (['"]?)(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+@\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.+-]+)?\1$/u;
      let index=0;
      const approved=current.list.every(line=>line===original.list[index]?(index++,true):exactPackage.test(line))&&index===original.list.length;
      if(!approved||original.outside!==current.outside){
        throw new Error("pnpm changed the pinned workspace beyond generated release-age bookkeeping; preserving the changed file for inspection");
      }
      await writeFileAtomic(path,before);
    }
  }
}
