import {createHash} from 'node:crypto';
import {lstat,readFile,readdir,mkdir,writeFile,unlink,rmdir} from 'node:fs/promises';
import {join} from 'node:path';

const names=['manifest.json','document.html'];
const sha=data=>createHash('sha256').update(data).digest('hex');
const hex=(value,size)=>typeof value==='string'&&new RegExp(`^[a-f0-9]{${size}}$`,'u').test(value);
async function regular(path,limit){const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||info.size<1||info.size>limit)throw Error('Invalid installed UI build file');return readFile(path);}
export async function readInstalledUI(source){
 const folder=await lstat(source);if(!folder.isDirectory()||folder.isSymbolicLink())throw Error('Invalid installed UI build directory');
 if((await readdir(source)).some(name=>!names.includes(name)))throw Error('Unexpected installed UI build resource');
 const data=await regular(join(source,'manifest.json'),131072),manifest=JSON.parse(data.toString('utf8'));
 if(manifest.schema!==1||manifest.profile!=='hub-installed-web-v1'||!hex(manifest.compatibility,64)||!hex(manifest.graphRevision,12)||manifest.document?.file!=='document.html'||manifest.document.embedded===true||!hex(manifest.document.sha256,64)||!Number.isSafeInteger(manifest.document.bytes)||manifest.document.bytes<1||manifest.document.bytes>64*1024*1024)throw Error('Invalid installed UI build manifest');
 if(!Array.isArray(manifest.packages)||!manifest.packages.length||manifest.packages.length>200||new Set(manifest.packages).size!==manifest.packages.length||manifest.packages.some(name=>typeof name!=='string'||!/^[@A-Za-z0-9/_.-]{1,160}$/u.test(name)))throw Error('Invalid installed UI package profile');
 if(!Array.isArray(manifest.resources)||manifest.resources.length!==2||new Set(manifest.resources.map(row=>row.file)).size!==2||manifest.resources.some(row=>!['memory-graph-browser.js','voice-browser.js'].includes(row.file)||row.embedded!==true||!hex(row.sha256,64)||!Number.isSafeInteger(row.bytes)||row.bytes<1||row.bytes>32*1024*1024))throw Error('Invalid installed UI embedded resources');
 const document=await regular(join(source,'document.html'),64*1024*1024);
 if(document.length!==manifest.document.bytes||sha(document)!==manifest.document.sha256||!document.subarray(0,15).equals(Buffer.from('<!doctype html>')))throw Error('Installed UI document checksum mismatch');
 return{manifest,data,document};
}

/** Copies only verified source-built resources. Never reuse an old generated
 * destination when this build has no source bundle. */
export async function copyInstalledUI(source,target,{required=false}={}){
 let found;try{found=await lstat(source);}catch(error){if(error.code!=='ENOENT')throw error;}
 if(!found&&required)throw Error('Build and export the installed UI before preparing this iPhone package');
 let existing;try{existing=await lstat(target);}catch(error){if(error.code!=='ENOENT')throw error;}
 if(existing){
  if(!existing.isDirectory()||existing.isSymbolicLink()||(await readdir(target)).some(name=>!names.includes(name)))throw Error('Unexpected generated installed UI destination');
  for(const name of await readdir(target)){const info=await lstat(join(target,name));if(!info.isFile()||info.isSymbolicLink())throw Error('Unexpected generated installed UI file');}
 }
 if(!found){if(existing){for(const name of await readdir(target))await unlink(join(target,name));await rmdir(target);}return;}
 const built=await readInstalledUI(source);
 await mkdir(target,{recursive:true});
 await writeFile(join(target,'document.html'),built.document);
 await writeFile(join(target,'manifest.json'),built.data);
 await readInstalledUI(target);
 return built.manifest;
}
