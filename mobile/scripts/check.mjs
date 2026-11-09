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
const spm=await readFile(join(root,'ios/App/CapApp-SPM/Package.swift'),'utf8');
if(!spm.includes('platforms: [.iOS(.v15)]'))throw Error('Keep the app iOS15 baseline when syncing the newer voice widget.');
const identifiers=[...project.matchAll(/PRODUCT_BUNDLE_IDENTIFIER = ([^;]+);/g)].map(m=>m[1]);
if(!identifiers.length||identifiers.some(id=>id!==config.appId&&id!==config.appId+'.voice-widget')||!identifiers.includes(config.appId+'.voice-widget'))throw Error('Match the app and voice-widget identifiers in both Xcode build configurations.');
const icon=await sharp(join(root,'ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png')).metadata();
if(icon.width!==1024||icon.height!==1024||icon.hasAlpha)throw Error('Prepare the opaque 1024-pixel HUB app icon.');
console.log(JSON.stringify({bundleId:config.appId,platform:process.platform,foundationChecksPassed:true,appleTeamSelected:/DEVELOPMENT_TEAM = [A-Z0-9]{10};/.test(project),stage:'development-foundation'}));
