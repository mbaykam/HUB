import {mkdir,readFile,readdir,copyFile,writeFile} from 'node:fs/promises';
import sharp from 'sharp';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {root,readJSON,validateConfig} from './common.mjs';

export async function buildWeb(){
  validateConfig(await readJSON('capacitor.config.json'));
  const output=join(root,'www'),allowed=new Set(['index.html','styles.css','app-icon.png','third-party-notices.txt']);
  await mkdir(output,{recursive:true});
  for(const name of await readdir(output))if(!allowed.has(name))throw Error('Unexpected file in generated www directory; inspect it before building.');
  await copyFile(join(root,'src/index.html'),join(output,'index.html'));
  await copyFile(join(root,'src/styles.css'),join(output,'styles.css'));
  const svg=await readFile(join(root,'../assets/brand/hub-icon.svg'));
  const icon=await sharp(svg).resize(1024,1024).flatten({background:'#f5f2ea'}).removeAlpha().png().toBuffer();
  await writeFile(join(output,'app-icon.png'),icon);
  await copyFile(join(root,'node_modules/@capacitor/ios/LICENSE'),join(output,'third-party-notices.txt'));
  console.log('Built the bundled iOS development page. No host data or credentials copied.');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await buildWeb();
