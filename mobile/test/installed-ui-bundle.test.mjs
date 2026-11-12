import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {copyInstalledUI,readInstalledUI} from '../scripts/installed-ui-bundle.mjs';

test('preparation copies only verified code and never reuses stale generated resources',async()=>{
 const root=await mkdtemp(join(tmpdir(),'hub-ui-bundle-')),source=join(root,'source'),target=join(root,'target');
 const document=Buffer.from('<!doctype html><div>Actual code fixture, no user data</div>');
 const manifest={schema:1,profile:'hub-installed-web-v1',compatibility:'a'.repeat(64),graphRevision:'b'.repeat(12),document:{file:'document.html',bytes:document.length,sha256:createHash('sha256').update(document).digest('hex')},resources:['memory-graph-browser.js','voice-browser.js'].map(file=>({file,bytes:1,sha256:'c'.repeat(64),embedded:true})),packages:['@example/renderer']};
 try{
  await mkdir(source);await writeFile(join(source,'document.html'),document);await writeFile(join(source,'manifest.json'),JSON.stringify(manifest));
  await copyInstalledUI(source,target,{required:true});assert.deepEqual((await readInstalledUI(target)).document,document);
  await writeFile(join(source,'document.html'),Buffer.concat([document,Buffer.from('corrupt')]));await assert.rejects(copyInstalledUI(source,target),/checksum/);assert.deepEqual(await readFile(join(target,'document.html')),document);
  await writeFile(join(target,'preserve.txt'),'unrelated');await assert.rejects(copyInstalledUI(join(root,'absent'),target),/Unexpected/);assert.equal(await readFile(join(target,'preserve.txt'),'utf8'),'unrelated');
  await assert.rejects(copyInstalledUI(join(root,'absent'),join(root,'other'),{required:true}),/Build and export/);
  await rm(join(target,'preserve.txt'));await copyInstalledUI(join(root,'absent'),target);await assert.rejects(readFile(join(target,'document.html')),/ENOENT/);
 }finally{await rm(root,{recursive:true,force:true});}
});
