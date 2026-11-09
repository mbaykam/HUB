import test from 'node:test';
import assert from 'node:assert/strict';
import {validateConfig,readJSON} from '../scripts/common.mjs';

test('native bridge stays restricted to bundled content; remote and cleartext configurations fail closed',async()=>{
  const base=await readJSON('capacitor.config.json');assert.doesNotThrow(()=>validateConfig(base));
  for(const server of [{cleartext:true},{cleartext:false,url:'https://example.com'},{cleartext:false,allowNavigation:['*']}])assert.throws(()=>validateConfig({...base,server}),/native bridge/);
  assert.throws(()=>validateConfig({...base,webDir:'../'}),/bundled/);
  assert.throws(()=>validateConfig({...base,appId:'invalid'}),/bundle identifier/);
});
