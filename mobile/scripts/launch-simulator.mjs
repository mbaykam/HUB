import {execFileSync} from 'node:child_process';
import {mkdir,readFile,writeFile,lstat,realpath} from 'node:fs/promises';
import {resolve,sep} from 'node:path';

if(process.platform!=='darwin')throw Error('Native simulator launch requires macOS/Xcode.');
const run=(command,args,timeout=60000)=>execFileSync(command,args,{encoding:'utf8',timeout,killSignal:'SIGKILL',maxBuffer:10_000_000,stdio:['ignore','pipe','pipe']}).trim();
const sim=(...args)=>run('xcrun',['simctl',...args]);
const source=JSON.parse(await readFile('mobile/build/simulator-launch/source-run.json','utf8'));
if(source.repository!=='mbaykam/HUB'||source.sha!==process.env.SOURCE_SHA||source.runId!==process.env.SOURCE_RUN_ID)throw Error('Simulator source proof does not match the requested build.');
const folder=resolve('mobile/build/simulator-launch'),extracted=resolve(folder,'extracted'),zip=resolve('mobile/build/simulator-download/HUB-ios-simulator.zip');
await mkdir(extracted,{recursive:true});
const entries=run('/usr/bin/unzip',['-Z1',zip]).split('\n');
if(entries.some(name=>name.startsWith('/')||name.includes('\\')||name.split('/').includes('..')))throw Error('Unsafe archive paths.');
run('/usr/bin/ditto',['-x','-k',zip,extracted]);
const app=resolve(extracted,'App.app');
if((await lstat(app)).isSymbolicLink()||!(await realpath(app)).startsWith(extracted+sep))throw Error('Unexpected simulator bundle location.');
const info=JSON.parse(run('/usr/bin/plutil',['-convert','json','-o','-',resolve(app,'Info.plist')]));
if(info.CFBundleIdentifier!=='com.mbaykam.hub'||!info.CFBundleSupportedPlatforms?.includes('iPhoneSimulator')||info.CFBundleExecutable!=='App')throw Error('Not the expected HUB simulator app.');
const available=JSON.parse(sim('list','devices','available','-j')).devices;
const types=JSON.parse(sim('list','devicetypes','-j')).devicetypes;
let selected;
for(const [runtime,devices]of Object.entries(available).sort(([a],[b])=>b.localeCompare(a,undefined,{numeric:true}))){
  if(!runtime.includes('.iOS-'))continue;
  const phone=devices.find(device=>device.isAvailable&&device.name.startsWith('iPhone'));
  if(!phone)continue;
  const type=phone.deviceTypeIdentifier??types.find(type=>type.name===phone.name)?.identifier;
  if(type){selected={runtime,type};break;}
}
if(!selected)throw Error('The runner has no available iPhone simulator runtime; compilation alone does not prove launch.');
let device,stage='create';
try{
  console.log('Creating an isolated simulator: '+JSON.stringify(selected));
  device=sim('create','HUB isolated launch '+process.env.GITHUB_RUN_ID,selected.type,selected.runtime);
  if(!/^[A-F0-9-]{36}$/i.test(device))throw Error('Invalid new simulator identity.');
  stage='boot';console.log('Booting '+device);sim('boot',device);
  run('/usr/bin/open',['-a','Simulator','--args','-CurrentDeviceUDID',device]);
  stage='bootstatus';console.log('Waiting for native simulator startup');
  run('xcrun',['simctl','bootstatus',device,'-b'],240000);
  stage='install';console.log('Installing the verified existing bundle');
  sim('install',device,app);
  stage='launch';console.log('Launching HUB');
  const launch=sim('launch',device,'com.mbaykam.hub'),pid=Number(launch.match(/:\s*(\d+)$/)?.[1]);
  if(!pid)throw Error('The app did not report a process ID.');
  // Allow the initial window + queued native Connect sheet to render.
  await new Promise(resolve=>setTimeout(resolve,4000));
  stage='process';const processName=run('/bin/ps',['-ww','-p',String(pid),'-o','comm=']);
  if(processName!=='App'&&!processName.endsWith('/App.app/App'))throw Error('HUB did not stay running after first launch.');
  stage='screenshot';sim('io',device,'screenshot',resolve(folder,'native-first-launch.png'));
  await writeFile(resolve(folder,'launch-proof.json'),JSON.stringify({...source,runtime:selected.runtime,hostArchitecture:process.arch,bundleId:info.CFBundleIdentifier,appProcessAlive:true,screenshot:'native-first-launch.png',freshSimulator:true,configuredServer:false,physicalAcceptance:false,signedIPhoneDelivery:false},null,2));
  console.log('Fresh native simulator launched HUB and captured its initial UI; no account/server/microphone was configured.');
}catch(error){
  await writeFile(resolve(folder,'launch-failure.json'),JSON.stringify({...source,stage,runtime:selected.runtime,code:error.code??null,signal:error.signal??null,message:String(error.message).slice(0,4000),stdout:String(error.stdout??'').slice(-12000),stderr:String(error.stderr??'').slice(-12000)},null,2));
  throw error;
}finally{
  if(device&&/^[A-F0-9-]{36}$/i.test(device)){
    for(const action of ['shutdown','delete']){
      try{run('xcrun',['simctl',action,device],20000);}catch(error){console.warn('Isolated simulator cleanup '+action+' failed: '+(error.code??error.message));}
    } // Never mask the original launch failure; runner disposal is the final boundary.
  }
}
