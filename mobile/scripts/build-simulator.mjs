import {existsSync} from 'node:fs';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {root,run,readJSON,validateConfig} from './common.mjs';

validateConfig(await readJSON('capacitor.config.json'));
if(process.platform!=='darwin')throw Error('Use the manual iOS simulator workflow, or run this command on a Mac with Xcode.');
if(!existsSync(join(root,'ios/App/App.xcodeproj')))throw Error('Run pnpm ios:prepare first.');
run('xcodebuild',['-version']);
await mkdir(join(root,'build'),{recursive:true});
const action=process.env.HUB_NATIVE_WORKSPACE_UI_TEST==='1'?'build-for-testing':'build';
run('xcodebuild',['-project','ios/App/App.xcodeproj','-scheme','App','-configuration','Debug','-destination','generic/platform=iOS Simulator','-derivedDataPath','build/DerivedData','CODE_SIGNING_ALLOWED=NO',action]);
const app='build/DerivedData/Build/Products/Debug-iphonesimulator/App.app';
if(!existsSync(join(root,app)))throw Error('Xcode did not produce the expected simulator app.');
run('ditto',['-c','-k','--keepParent',app,'build/HUB-ios-simulator.zip']);
console.log('Created build/HUB-ios-simulator.zip. This unsigned simulator build cannot be installed on an iPhone.');
