import test from 'node:test';
import assert from 'node:assert/strict';
import {validateRendererReceipt} from '../scripts/renderer-receipt.mjs';

const expected={nonce:'11111111-1111-4111-8111-111111111111',documentSHA256:'a'.repeat(64),manifestSHA256:'b'.repeat(64),documentBytes:10000};
function proof(){return{receiptNonce:expected.nonce,sourceSHA256:expected.documentSHA256,manifestSHA256:expected.manifestSHA256,sourceBytes:10000,realRendered:true,nativeBridge:false,nonPersistent:true,testOnlyCSP:true,renderer:{home:true,compact:true,composer:{visible:true,height:62},menu:{visible:true,right:44},voice:{visible:true,x:50,right:94},send:{visible:true,x:100}}};}
test('fresh app receipt requires exact artifact identity and actual geometry',()=>{
 assert.equal(validateRendererReceipt(proof(),expected).realRendered,true);
 for(const edit of [p=>p.receiptNonce='old',p=>p.sourceSHA256='c'.repeat(64),p=>p.manifestSHA256='c'.repeat(64),p=>p.realRendered=false,p=>p.renderer.home=false,p=>p.renderer.composer.height=116,p=>p.renderer.composer.height='62',p=>p.renderer.menu.visible=false,p=>p.renderer.voice.right=120,p=>p.nativeBridge=true,p=>p.error='failed']){
  const value=proof();edit(value);assert.throws(()=>validateRendererReceipt(value,expected));
 }
 assert.throws(()=>validateRendererReceipt(undefined,expected));
});
