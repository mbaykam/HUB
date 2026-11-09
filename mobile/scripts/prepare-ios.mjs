import {existsSync} from 'node:fs';
import {copyFile} from 'node:fs/promises';
import {join} from 'node:path';
import {buildWeb} from './build-web.mjs';
import {root,capacitor} from './common.mjs';

await buildWeb();
if(!existsSync(join(root,'ios/App/App.xcodeproj')))capacitor('add','ios','--packagemanager','SPM');
else capacitor('sync','ios');
await copyFile(join(root,'www/app-icon.png'),join(root,'ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png'));
console.log('iOS project prepared. Compilation requires macOS/Xcode. This command does not sign or upload an app.');
