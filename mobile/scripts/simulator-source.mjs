import {appendFile,mkdir,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

export function validateSimulatorSource(run,artifacts,{runId,sha,repository}){
  if(!/^\d{1,15}$/.test(runId??'')||!/^[a-f0-9]{40}$/.test(sha??'')||repository!=='mbaykam/HUB')throw Error('Invalid simulator source identity.');
  if(String(run.id)!==runId||run.status!=='completed'||run.conclusion!=='success'||run.event!=='workflow_dispatch'||run.head_branch!=='main'||run.head_sha!==sha||run.path!=='.github/workflows/ios-simulator.yml'||run.repository?.full_name!==repository||run.head_repository?.full_name!==repository)throw Error('Use a successful trusted main-branch manual iOS build, not a PR/fork or another workflow.');
  const name='HUB-ios-simulator-'+sha,matching=artifacts.filter(a=>a.name===name);
  if(matching.length!==1||matching[0].expired||matching[0].size_in_bytes<1||matching[0].size_in_bytes>200_000_000)throw Error('Simulator artifact is missing, expired, ambiguous or unexpectedly large.');
  return {repository,runId,sha,artifactName:name,artifactId:matching[0].id};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const runId=process.env.SOURCE_RUN_ID,sha=process.env.SOURCE_SHA,repository=process.env.GITHUB_REPOSITORY;
  if(!/^\d{1,15}$/.test(runId??'')||!/^[a-f0-9]{40}$/.test(sha??'')||repository!=='mbaykam/HUB'||!process.env.GH_TOKEN)throw Error('Missing trusted source identity/token.');
  const get=async path=>{
    const response=await fetch('https://api.github.com/repos/mbaykam/HUB/'+path,{headers:{Accept:'application/vnd.github+json',Authorization:'Bearer '+process.env.GH_TOKEN,'X-GitHub-Api-Version':'2026-03-10'},redirect:'error',signal:AbortSignal.timeout(20000)});
    if(!response.ok)throw Error('Source metadata request failed: HTTP '+response.status);
    return response.json();
  };
  const run=await get('actions/runs/'+runId),artifacts=await get('actions/runs/'+runId+'/artifacts?per_page=100');
  const source=validateSimulatorSource(run,artifacts.artifacts,{runId,sha,repository});
  await mkdir('mobile/build/simulator-launch',{recursive:true});
  await writeFile('mobile/build/simulator-launch/source-run.json',JSON.stringify(source,null,2));
  if(process.env.GITHUB_OUTPUT)await appendFile(process.env.GITHUB_OUTPUT,'artifact_name='+source.artifactName+'\n');
  console.log(JSON.stringify(source));
}
