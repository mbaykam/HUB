import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readInstalledUI} from './installed-ui-bundle.mjs';

const root=resolve(fileURLToPath(new URL('..',import.meta.url))),mode=process.argv[2];
if(!['write','verify'].includes(mode))throw Error('Choose write or verify');
if(process.env.GITHUB_REPOSITORY!=='mbaykam/HUB'||!/^[a-f0-9]{40}$/u.test(process.env.GITHUB_SHA??''))throw Error('Installed UI requires this repository and an exact source commit');
const bundle=await readInstalledUI(join(root,'build/installed-ui'));
const profile=JSON.parse(await readFile(join(root,'installed-ui-profile.json'),'utf8'));
if(JSON.stringify([...bundle.manifest.packages].sort())!==JSON.stringify([...profile.packages].sort()))throw Error('Installed UI package roster does not match this source');
const proof={schema:1,repository:process.env.GITHUB_REPOSITORY,sourceSha:process.env.GITHUB_SHA,compatibility:bundle.manifest.compatibility,manifestSHA256:createHash('sha256').update(bundle.data).digest('hex'),documentSHA256:bundle.manifest.document.sha256};
const file=join(root,'build/installed-ui-proof.json');
if(mode==='write')await writeFile(file,JSON.stringify(proof,null,2)+'\n',{flag:'wx'});
else{
 const actual=JSON.parse(await readFile(file,'utf8'));
 if(JSON.stringify(actual)!==JSON.stringify(proof))throw Error('Installed UI artifact does not match the requested source/build');
}
console.log(JSON.stringify({...proof,documentBytes:bundle.document.length,verified:true}));
