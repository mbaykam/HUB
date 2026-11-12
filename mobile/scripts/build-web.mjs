import {mkdir,readFile,readdir,copyFile,writeFile} from 'node:fs/promises';
import sharp from 'sharp';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {root,readJSON,validateConfig} from './common.mjs';
import {copyInstalledUI} from './installed-ui-bundle.mjs';

export async function buildWeb(){
  validateConfig(await readJSON('capacitor.config.json'));
  const output=join(root,'www'),allowed=new Set(['index.html','styles.css','app-icon.png','third-party-notices.txt','installed-ui']);
  await mkdir(output,{recursive:true});
  for(const name of await readdir(output))if(!allowed.has(name))throw Error('Unexpected file in generated www directory; inspect it before building.');
  const installed=await copyInstalledUI(join(root,'build/installed-ui'),join(output,'installed-ui'),{required:process.env.HUB_REQUIRE_INSTALLED_UI==='1'});
  await copyFile(join(root,'src/index.html'),join(output,'index.html'));
  await copyFile(join(root,'src/styles.css'),join(output,'styles.css'));
  const svg=await readFile(join(root,'../assets/brand/hub-icon.svg'));
  const icon=await sharp(svg).resize(1024,1024).flatten({background:'#f5f2ea'}).removeAlpha().png().toBuffer();
  await writeFile(join(output,'app-icon.png'),icon);
  const notices=await Promise.all([
    readFile(join(root,'node_modules/@capacitor/ios/LICENSE'),'utf8'),
    readFile(join(root,'third-party-notices/WebRTC.txt'),'utf8'),
  ]);
  await writeFile(join(output,'third-party-notices.txt'),notices.join('\n\n'));
  console.log(installed?`Bundled verified installed UI ${installed.graphRevision}. No host data or credentials copied.`:'Built the remote-client development page. No host data or credentials copied.');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await buildWeb();
