import {execFileSync} from 'node:child_process';
import {copyFile,mkdir,readFile,writeFile,lstat,realpath} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
import {selectSimulatorSeed} from './simulator-source.mjs';

if(process.platform!=='darwin')throw Error('Native simulator launch requires macOS/Xcode.');
const run=(command,args,timeout=60000)=>execFileSync(command,args,{encoding:'utf8',timeout,killSignal:'SIGKILL',maxBuffer:10_000_000,stdio:['ignore','pipe','pipe']}).trim();
const sim=(...args)=>run('xcrun',['simctl',...args]);
const nativeDevelopment=process.env.HUB_NATIVE_WORKSPACE_SIMULATOR==='1';
let source;
if(nativeDevelopment){
  const {GITHUB_REPOSITORY:repository,GITHUB_REF:ref,GITHUB_SHA:sha,GITHUB_RUN_ID:runId}=process.env;
  if(repository!=='mbaykam/HUB'||ref!=='refs/heads/codex/ios-native-workspace'||!/^[a-f0-9]{40}$/.test(sha??'')||
      !/^\d{1,15}$/.test(runId??'')||run('git',['rev-parse','HEAD'])!==sha)throw Error('Unexpected development build source.');
  source={repository,sha,runId,source:'same-run unsigned development build'};
  await mkdir('mobile/build/simulator-download',{recursive:true});
  await copyFile('mobile/build/HUB-ios-simulator.zip','mobile/build/simulator-download/HUB-ios-simulator.zip');
}else{
  source=JSON.parse(await readFile('mobile/build/simulator-launch/source-run.json','utf8'));
  if(source.repository!=='mbaykam/HUB'||source.sha!==process.env.SOURCE_SHA||source.runId!==process.env.SOURCE_RUN_ID)throw Error('Simulator source proof does not match the requested build.');
}
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
const selected=selectSimulatorSeed(available);
const baselineMode=nativeDevelopment?'fresh-isolated-device':'cloned-runner-seed';
let device,stage='create-device',displayMode='headless';
try{
  const name='HUB isolated launch '+process.env.GITHUB_RUN_ID;
  if(nativeDevelopment){
    // Clones of the hosted seed have repeatedly stalled in Data Migration.
    const seed=available[selected.runtime].find(device=>device.udid===selected.seed);
    const type=seed.deviceTypeIdentifier??JSON.parse(sim('list','devicetypes','-j')).devicetypes.find(type=>type.name===seed.name)?.identifier;
    if(!/^com\.apple\.CoreSimulator\.SimDeviceType\.iPhone-[A-Za-z0-9-]+$/.test(type??''))throw Error('No device type for the isolated iPhone.');
    console.log('Creating an isolated '+type+' for '+selected.runtime);
    device=sim('create',name,type,selected.runtime);
  }else{
    console.log('Cloning an isolated simulator without modifying its runner seed: '+JSON.stringify(selected));
    device=sim('clone',selected.seed,name);
  }
  if(!/^[A-F0-9-]{36}$/i.test(device))throw Error('Invalid new simulator identity.');
  stage='boot';console.log('Booting '+device);sim('boot',device);
  // Hosted Xcode installations may not register Simulator with Launch Services.
  // Use the Simulator belonging to the selected toolchain, not an app-name lookup.
  const simulatorApp=resolve(run('/usr/bin/xcode-select',['-p']),'Applications/Simulator.app');
  // Some hosted toolchains ship CoreSimulator without Simulator.app. simctl
  // can still install, launch and capture the isolated device headlessly.
  if((await lstat(simulatorApp).catch(error=>{if(error.code==='ENOENT')return undefined;throw error;}))?.isDirectory()){
    run('/usr/bin/open',['-a',simulatorApp,'--args','-CurrentDeviceUDID',device]);
    displayMode='simulator-app';
  }
  stage='bootstatus';console.log('Waiting for native simulator startup');
  run('xcrun',['simctl','bootstatus',device,'-b'],480000);
  stage='install';console.log('Installing the verified existing bundle');
  try{sim('uninstall',device,'com.mbaykam.hub');}catch{} // Only the new isolated clone, never its seed.
  sim('install',device,app);
  const testInstalledUI=process.env.TEST_INSTALLED_UI==='1';
  const launchArguments = [];
  if(testInstalledUI){
    const manifest=JSON.parse(await readFile(resolve(app,'public/installed-ui/manifest.json'),'utf8'));
    if(manifest.schema!==1||manifest.profile!=='hub-installed-web-v1')throw Error('The simulator app has no installed renderer.');
    // The simulator process reads this through its UserDefaults argument domain.
    // Writing the preferences plist on the host can race the simulator's cfprefsd.
    launchArguments.push('-hub.ios.server-origin.v1', 'https://installed-ui-simulator.invalid/');
  }
  if(nativeDevelopment)launchArguments.push('--hub-native-home-fixture');
  stage='launch';console.log('Launching HUB');
  const launch=sim('launch',device,'com.mbaykam.hub',...launchArguments),pid=Number(launch.match(/:\s*(\d+)$/)?.[1]);
  if(!pid)throw Error('The app did not report a process ID.');
  // A process can exist before SwiftUI replaces the launch screen.
  await new Promise(resolve=>setTimeout(resolve,4000));
  stage='process';const processName=run('/bin/ps',['-ww','-p',String(pid),'-o','comm=']);
  if(processName!=='App'&&!processName.endsWith('/App.app/App'))throw Error('HUB did not stay running after first launch.');
  // Newer iPhone runtime seeds can expose multiple displays. Capture the
  // primary phone display explicitly rather than relying on simctl's default.
  stage='screenshot';
  const screenshot=resolve(folder,'native-first-launch.png');
  if(nativeDevelopment){
    const candidate=resolve(folder,'native-launch-candidate.png');
    const checker=resolve('mobile/scripts/check-native-home-image.mjs');
    let visible=false;
    for(let attempt=0;attempt<6&&!visible;attempt++){
      if(attempt>0)await new Promise(resolve=>setTimeout(resolve,3500));
      for(const display of ['default','1','0']){
        try{
          const displayArgs=display==='default'?[]:['--display='+display];
          sim('io',device,'screenshot',...displayArgs,candidate);
          run(process.execPath,[checker,candidate]);
          await copyFile(candidate,screenshot);
          visible=true;
          break;
        }catch(error){
          console.warn('Native Home not visible on display '+display+': '+String(error.stderr??error.message).trim().slice(-400));
        }
      }
    }
    if(!visible){
      let logs='';
      try{logs=run('xcrun',['simctl','spawn',device,'log','show','--last','2m','--info','--predicate','process == "App" OR subsystem == "com.mbaykam.hub"'],20_000).slice(-20_000);}
      catch(error){logs=String(error.message).slice(0,1000);}
      await writeFile(resolve(folder,'native-launch-diagnostics.json'),JSON.stringify({logs},null,2));
      throw Error('Native workspace did not appear on a simulator display.');
    }
  }else{
    sim('io',device,'screenshot','--display=1',screenshot);
  }
  await writeFile(resolve(folder,'launch-proof.json'),JSON.stringify({...source,runtime:selected.runtime,baselineMode,displayMode,hostArchitecture:process.arch,bundleId:info.CFBundleIdentifier,appProcessAlive:true,screenshot:'native-first-launch.png',isolatedSimulator:true,freshOS:nativeDevelopment,serverSetupAttempted:testInstalledUI,syntheticOfflineOrigin:testInstalledUI,nativeHomeFixture:nativeDevelopment,physicalAcceptance:false,signedIPhoneDelivery:false},null,2));
  console.log('Isolated native simulator launched HUB and captured its initial UI; no account/server/microphone setup was attempted.');
}catch(error){
  await writeFile(resolve(folder,'launch-failure.json'),JSON.stringify({...source,stage,runtime:selected.runtime,baselineMode,code:error.code??null,signal:error.signal??null,message:String(error.message).slice(0,4000),stdout:String(error.stdout??'').slice(-12000),stderr:String(error.stderr??'').slice(-12000)},null,2));
  throw error;
}finally{
  if(device&&/^[A-F0-9-]{36}$/i.test(device)){
    for(const action of ['shutdown','delete']){
      try{run('xcrun',['simctl',action,device],20000);}catch(error){console.warn('Isolated simulator cleanup '+action+' failed: '+(error.code??error.message));}
    } // Never mask the original launch failure; runner disposal is the final boundary.
  }
}
