import {existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import sharp from 'sharp';
import {readJSON,root,validateConfig} from './common.mjs';

const config=await readJSON('capacitor.config.json'),manifest=await readJSON('package.json');
validateConfig(config);
for(const name of ['@capacitor/core','@capacitor/ios','@capacitor/cli']){
  const pinned=manifest.dependencies?.[name]??manifest.devDependencies?.[name];
  const installed=await readJSON('node_modules/'+name+'/package.json');
  if(installed.version!==pinned)throw Error(`Unexpected installed version of ${name}. Use the frozen lockfile.`);
}
if(!existsSync(join(root,'ios/App/App.xcodeproj/project.pbxproj')))throw Error('Missing iOS project. Run pnpm ios:prepare.');
if(!existsSync(join(root,'ios/App/App.xcodeproj/xcshareddata/xcschemes/App.xcscheme')))throw Error('Commit the shared App scheme for hosted builds.');
const project=await readFile(join(root,'ios/App/App.xcodeproj/project.pbxproj'),'utf8');
for(const environment of ['development','production'])if(!project.includes('HUB_PUSH_ENVIRONMENT = '+environment+';'))throw Error('Match Apple push environment to Debug/Release signing.');
const entitlements=await readFile(join(root,'ios/App/App/App.entitlements'),'utf8');
if(!/<key>aps-environment<\/key>\s*<string>\$\(HUB_PUSH_ENVIRONMENT\)<\/string>/.test(entitlements))throw Error('Missing signed push environment entitlement.');
const spm=await readFile(join(root,'ios/App/CapApp-SPM/Package.swift'),'utf8');
if(!spm.includes('platforms: [.iOS(.v15)]'))throw Error('Keep the app iOS15 baseline when syncing the newer voice widget.');
const identifiers=[...project.matchAll(/PRODUCT_BUNDLE_IDENTIFIER = ([^;]+);/g)].map(m=>m[1]);
if(!identifiers.length||identifiers.some(id=>id!==config.appId&&id!==config.appId+'.voice-widget'&&id!==config.appId+'.share')||!identifiers.includes(config.appId+'.voice-widget'))throw Error('Match the app and voice-widget identifiers in both Xcode build configurations.');
const icon=await sharp(join(root,'ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png')).metadata();
if(icon.width!==1024||icon.height!==1024||icon.hasAlpha)throw Error('Prepare the opaque 1024-pixel HUB app icon.');
console.log(JSON.stringify({bundleId:config.appId,platform:process.platform,foundationChecksPassed:true,appleTeamSelected:/DEVELOPMENT_TEAM = [A-Z0-9]{10};/.test(project),stage:'development-foundation'}));

const privacy=await readFile(join(root,'ios/App/App/PrivacyInfo.xcprivacy'),'utf8');
for(const reason of ['CA92.1','C617.1','3B52.1'])if(!privacy.includes('<string>'+reason+'</string>'))throw Error('Missing first-party privacy API reason '+reason);
if(!project.includes('path = PrivacyInfo.xcprivacy;')||!project.includes('A16000000000000000000001,'))throw Error('Bundle the app privacy manifest as an Xcode resource.');

const share=await readFile(join(root,'ios/App/HubShareExtension/Share.entitlements'),'utf8');
for(const value of [share,entitlements])if(!value.includes('<string>group.'+config.appId+'</string>'))throw Error('Keep app and Share extension in the same explicit App Group.');
if(!identifiers.includes(config.appId+'.share'))throw Error('Missing Share extension target.');
