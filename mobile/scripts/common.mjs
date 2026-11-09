import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';
import {spawnSync} from 'node:child_process';

export const root=dirname(dirname(fileURLToPath(import.meta.url)));
export const readJSON=async path=>JSON.parse(await readFile(join(root,path),'utf8'));
export function run(command,args){
  const result=spawnSync(command,args,{cwd:root,stdio:'inherit',shell:false});
  if(result.error)throw result.error;
  if(result.status!==0)throw Error(`${command} failed (${result.status??result.signal})`);
}
export const capacitor=(...args)=>run(process.execPath,[join(root,'node_modules/@capacitor/cli/bin/capacitor'),...args]);

export function validateConfig(config){
  if(!/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*){2,}$/.test(config.appId??''))throw Error('Choose a reverse-DNS iOS bundle identifier.');
  if(config.webDir!=='www')throw Error('The iOS foundation must use its bundled www directory.');
  if(config.server?.url||config.server?.allowNavigation?.length||config.server?.cleartext!==false)throw Error('Remote pages must not acquire the native bridge. Keep bundled content and HTTPS-only connections.');
}
