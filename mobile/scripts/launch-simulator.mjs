import {execFileSync} from 'node:child_process';
import {mkdir,readFile,writeFile,lstat,realpath} from 'node:fs/promises';
import {resolve,sep} from 'node:path';

if(process.platform!=='darwin')throw Error('Native simulator launch requires macOS/Xcode.');
const run=(command,args,timeout=60000)=>execFileSync(command,args,{encoding:'utf8',timeout,maxBuffer:10_000_000,stdio:['ignore','pipe','pipe']}).trim();
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
let device;
try{
  device=sim('create','HUB isolated launch '+process.env.GITHUB_RUN_ID,selected.type,selected.runtime);
  if(!/^[A-F0-9-]{36}$/i.test(device))throw Error('Invalid new simulator identity.');
  sim('boot',device);
  run('xcrun',['simctl','bootstatus',device,'-b'],240000);
  sim('install',device,app);
  const launch=sim('launch',device,'com.mbaykam.hub'),pid=Number(launch.match(/:\s*(\d+)$/)?.[1]);
  if(!pid)throw Error('The app did not report a process ID.');
  // Allow the initial window + queued native Connect sheet to render.
  await new Promise(resolve=>setTimeout(resolve,4000));
  const processName=run('/bin/ps',['-ww','-p',String(pid),'-o','comm=']);
  if(processName!=='App'&&!processName.endsWith('/App.app/App'))throw Error('HUB did not stay running after first launch.');
  sim('io',device,'screenshot',resolve(folder,'native-first-launch.png'));
  await writeFile(resolve(folder,'launch-proof.json'),JSON.stringify({...source,runtime:selected.runtime,bundleId:info.CFBundleIdentifier,appProcessAlive:true,screenshot:'native-first-launch.png',freshSimulator:true,configuredServer:false,physicalAcceptance:false,signedIPhoneDelivery:false},null,2));
  console.log('Fresh native simulator launched HUB and captured its initial UI; no account/server/microphone was configured.');
}finally{
  if(device&&/^[A-F0-9-]{36}$/i.test(device)){
    try{sim('shutdown',device);}catch{}
    sim('delete',device); // Only this newly created isolated CI simulator.
  }
}
