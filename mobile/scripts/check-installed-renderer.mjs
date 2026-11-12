import {execFileSync} from 'node:child_process';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {validateRendererReceipt} from './renderer-receipt.mjs';
import {readInstalledUI} from './installed-ui-bundle.mjs';
import {selectSimulatorSeed} from './simulator-source.mjs';

if(process.platform!=='darwin')throw Error('Actual installed renderer checks require macOS/Xcode/iOS Simulator.');
if(!process.env.HUB_INSTALLED_UI_DOCUMENT_PATH)throw Error('Explicit verified installed document path is required.');
const documentPath=resolve(process.env.HUB_INSTALLED_UI_DOCUMENT_PATH);
if(!documentPath.endsWith('/document.html'))throw Error('Expected exact exported document.html.');
const built=await readInstalledUI(dirname(documentPath));
const output=resolve('mobile/build/installed-renderer'),evidence=resolve(output,'evidence');
await mkdir(evidence,{recursive:true});
const env=Object.fromEntries(['PATH','HOME','TMPDIR','DEVELOPER_DIR','LANG','LC_ALL'].filter(name=>process.env[name]).map(name=>[name,process.env[name]]));
env.HUB_INSTALLED_UI_DOCUMENT_PATH=documentPath;
const run=(command,args,timeout=60000)=>execFileSync(command,args,{env,encoding:'utf8',timeout,maxBuffer:18_000_000,stdio:['ignore','pipe','pipe']}).trim();
const sim=(...args)=>run('xcrun',['simctl',...args]);
const result=resolve(evidence,'renderer.xcresult'),project=resolve(output,'project'),derived=resolve(output,'derived');
let device,stage='prepare';
try{
 const xcode=run('xcodebuild',['-version']);
 if(!/^Xcode 27\b/mu.test(xcode))throw Error('Actual renderer probe requires the selected Xcode 27 toolchain.');
 run('python3',['mobile/probes/KeyboardAccessory/generate-project.py','--output',project]);
 const copied=await readInstalledUI(resolve(project,'InstalledUI'));
 if(copied.manifest.document.sha256!==built.manifest.document.sha256||!copied.document.equals(built.document)||!copied.data.equals(built.data))throw Error('Generator changed exact exported bytes.');
 const selected=selectSimulatorSeed(JSON.parse(sim('list','devices','available','-j')).devices);
 stage='clone';device=sim('clone',selected.seed,'HUB isolated renderer '+(process.env.GITHUB_RUN_ID??'local'));
 if(!/^[A-F0-9-]{36}$/iu.test(device))throw Error('Unexpected isolated simulator identity.');
 stage='boot';sim('boot',device);run('xcrun',['simctl','bootstatus',device,'-b'],480000);
 const args=['-project',resolve(project,'KeyboardAccessory.xcodeproj'),'-scheme','KeyboardAccessory','-destination','platform=iOS Simulator,id='+device,'-derivedDataPath',derived,'CODE_SIGNING_ALLOWED=NO'];
 stage='build-for-testing';await writeFile(resolve(evidence,'build.log'),run('xcodebuild',['build-for-testing',...args],600000));
 const embedded=await readInstalledUI(resolve(derived,'Build/Products/Debug-iphonesimulator/KeyboardAccessory.app/InstalledUI'));
 if(!embedded.document.equals(built.document)||!embedded.data.equals(built.data))throw Error('Built app does not embed exact verified renderer/manifest bytes.');
 stage='actual-renderer-ui-test';
 const log=run('xcodebuild',['test-without-building',...args,'-only-testing:KeyboardAccessoryUITests/KeyboardAccessoryUITests/testInstalledRendererActualHomeAndCompactComposer','-parallel-testing-enabled','NO','-resultBundlePath',result],600000);
 await writeFile(resolve(evidence,'xcodebuild.log'),log);
 if(!/testInstalledRendererActualHomeAndCompactComposer.*passed/u.test(log)||/testInstalledRendererActualHomeAndCompactComposer.*skipped/iu.test(log))throw Error('Required actual renderer test did not explicitly pass.');
 stage='fresh-renderer-receipt';
 const nonce=randomUUID(),bundle='dev.hub.probe.KeyboardAccessory';
 sim('launch','--terminate-running-process',device,bundle,'--installed-renderer','--renderer-receipt-nonce',nonce);
 const container=sim('get_app_container',device,bundle,'data');
 const receiptFile=resolve(container,'Documents',`installed-renderer-${nonce}.json`);
 let receipt;
 for(let attempt=0;attempt<240;attempt++){
  try{receipt=JSON.parse(await readFile(receiptFile,'utf8'));break;}catch(error){if(error.code!=='ENOENT')throw error;}
  await delay(250);
 }
 validateRendererReceipt(receipt,{nonce,documentSHA256:built.manifest.document.sha256,manifestSHA256:createHash('sha256').update(built.data).digest('hex'),documentBytes:built.document.length});
 await writeFile(resolve(evidence,'renderer-receipt.json'),JSON.stringify(receipt,null,2));
 stage='simulator-renderer-screenshot';
 const screenshot=resolve(evidence,'renderer-ios.png');
 sim('io',device,'screenshot','--display=1',screenshot);
 const png=await readFile(screenshot);
 if(png.length<1000||!png.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||png.readUInt32BE(16)<1||png.readUInt32BE(20)<1)throw Error('Simulator did not produce an actual renderer PNG');
 await writeFile(resolve(evidence,'proof.json'),JSON.stringify({screenshot:{file:'renderer-ios.png',sha256:createHash('sha256').update(png).digest('hex'),bytes:png.length,width:png.readUInt32BE(16),height:png.readUInt32BE(20)},receiptNonce:nonce,sourceSha:process.env.GITHUB_SHA,artifactSourceSha:process.env.HUB_PROBE_ARTIFACT_SOURCE_SHA??process.env.GITHUB_SHA,documentSHA256:built.manifest.document.sha256,documentBytes:built.document.length,manifestSHA256:createHash('sha256').update(built.data).digest('hex'),productionWebViewSHA256:createHash('sha256').update(await readFile('mobile/native/Sources/HubNative/HubWebView.swift')).digest('hex'),xcode,runtime:selected.runtime,isolatedSimulator:true,exactEmbeddedBytes:true,realRendered:true,actualUIKitScene:true,nativeBridge:false,networkBlockedByTestCSP:true,physicalIPhoneAcceptance:false},null,2));
 console.log('Actual exported renderer Home and compact composer passed in an isolated iOS UIKit app host; physical iPhone/auth acceptance remains separate.');
}catch(error){
 await writeFile(resolve(evidence,'failure.json'),JSON.stringify({stage,code:error.code??null,message:String(error.message).slice(0,2000),stdout:String(error.stdout??'').slice(-30000),stderr:String(error.stderr??'').slice(-5000)},null,2));
 throw error;
}finally{
 try{run('xcrun',['xcresulttool','export','attachments','--path',result,'--output-path',resolve(evidence,'attachments')],60000);}catch{}
 if(device&&/^[A-F0-9-]{36}$/iu.test(device))for(const action of ['shutdown','delete'])try{run('xcrun',['simctl',action,device],20000);}catch{}
}
