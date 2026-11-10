import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { VoiceScreenFrames, SCREEN_MAX_BYTES } from '../packages/harness-overlay/src/host/voice-screen.ts';
import { validateImageFile } from '../vendor/deepseek-harness/packages/attachment/attachment-local/src/store.ts';

const require = createRequire(new URL('../vendor/deepseek-harness/packages/attachment/attachment-local/package.json', import.meta.url));
const sharp = require('sharp');
const owner = { callId: randomUUID(), sessionId: 'hub-eval-screen' };
const jpeg = await sharp({ create: { width: 32, height: 20, channels: 3, background: '#5599aa' } }).jpeg().toBuffer();
const validate = bytes => validateImageFile({data:bytes,mediaType:'image/jpeg'}, {maxImageBytes:SCREEN_MAX_BYTES,maxImagePixels:3_000_000,maxImageDimension:1920,mediaTypes:['image/jpeg']}, {maxPixels:3_000_000,maxDimension:1920,maxBytes:SCREEN_MAX_BYTES});
const status = code => error => error.status === code;
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return {resolve,promise}; };

test('fresh screen frames use the real decoder, remain private, expire, and never resurrect closed consent', async () => {
  let now = 10000;
  const frames = new VoiceScreenFrames(validate, () => now), id = randomUUID();
  try {
    frames.start(owner,id);
    await frames.receive(owner,id,0,400,async()=>jpeg);
    assert.deepEqual(frames.frame(owner.sessionId).bytes,jpeg);
    const copy=frames.frame(owner.sessionId);copy.bytes.fill(0);
    assert.deepEqual(frames.frame(owner.sessionId).bytes,jpeg);
    assert.equal(frames.frame('other-session'),undefined);
    assert.equal(frames.status({...owner,callId:randomUUID()}).hasFrame,false);
    assert.deepEqual(frames.status(owner),{sharing:true,hasFrame:true,maxAgeMs:5000});
    assert.throws(()=>frames.start(owner,randomUUID()),status(409));
    await assert.rejects(frames.receive(owner,id,1,0,async()=>jpeg),status(429));
    now+=1000;await assert.rejects(frames.receive(owner,id,0,0,async()=>jpeg),status(409));
    now=14600;assert.equal(frames.frame(owner.sessionId),undefined);
    frames.stop(owner,id);assert.throws(()=>frames.start(owner,id),status(410));
    const delayed=randomUUID();frames.stop(owner,delayed);assert.throws(()=>frames.start(owner,delayed),status(410));
    const next=randomUUID();frames.start(owner,next);frames.stop(owner,id);
    assert.equal(frames.status(owner).sharing,true);
  } finally { frames.clear(); }
});

test('delayed upload read and decoding cannot extend the frame lifetime or survive a consent change',async()=>{
  let now=0;const entered=deferred(),gate=deferred();
  const frames=new VoiceScreenFrames(async()=>{entered.resolve();await gate.promise;},()=>now),id=randomUUID();
  try{
    frames.start(owner,id);const pending=frames.receive(owner,id,0,1000,async()=>jpeg);await entered.promise;
    now=4000;gate.resolve();await assert.rejects(pending,status(409));assert.equal(frames.frame(owner.sessionId),undefined);
    const readGate=deferred();const delayed=frames.receive(owner,id,1,0,()=>readGate.promise);
    frames.stop(owner,id);frames.start(owner,randomUUID());readGate.resolve(jpeg);
    await assert.rejects(delayed,status(410));assert.equal(frames.frame(owner.sessionId),undefined);
  }finally{gate.resolve();frames.clear();}
});

test('a killed client cannot hold sharing forever and its expired consent cannot revive',async()=>{
  let now=0;const frames=new VoiceScreenFrames(validate,()=>now),id=randomUUID();
  try{
    frames.start(owner,id);now=15000;assert.equal(frames.status(owner).sharing,false);
    frames.start(owner,randomUUID());assert.throws(()=>frames.start(owner,id),status(410));
    frames.stop(owner,id);assert.equal(frames.status(owner).sharing,true);
  }finally{frames.clear();}
});

test('full decoder rejects a fake JPEG header; size, dimensions, rate and sequence are bounded',async()=>{
  let now=0, decoded=0;const frames=new VoiceScreenFrames(async bytes=>{decoded++;await validate(bytes);},()=>now),id=randomUUID();
  const fake=Buffer.from([255,216,255,192,0,8,8,0,20,0,32,3,255,217]);
  try{
    frames.start(owner,id);
    await assert.rejects(frames.receive(owner,id,0,0,async()=>fake),status(400));assert.equal(decoded,1);
    now+=1000;const huge=Buffer.from(fake);huge.writeUInt16BE(1921,9);
    await assert.rejects(frames.receive(owner,id,0,0,async()=>huge),status(400));assert.equal(decoded,1);
    now+=1000;await assert.rejects(frames.receive(owner,id,0,0,async()=>Buffer.alloc(SCREEN_MAX_BYTES+1)),status(400));
    now+=1000;await frames.receive(owner,id,0,0,async()=>jpeg);
    assert.equal(decoded,2);
    for(const [seq,age] of [[-1,0],[1,5000],[1,-1],[Infinity,0]])await assert.rejects(frames.receive(owner,id,seq,age,async()=>jpeg),status(400));
  }finally{frames.clear();}
});

test('stop, close and owner loss during decoding cannot repopulate RAM; parallel decode is refused',async()=>{
  for(const action of ['stop','clear','owner-loss']){
    const entered=deferred(),gate=deferred();let owned=true;
    const frames=new VoiceScreenFrames(async()=>{entered.resolve();await gate.promise;}),id=randomUUID();
    try{
      frames.start(owner,id);const pending=frames.receive(owner,id,0,0,async()=>jpeg,()=>owned);await entered.promise;
      await assert.rejects(frames.receive(owner,id,1,0,async()=>{throw new Error('must not read a parallel upload');}),status(429));
      if(action==='stop')frames.stop(owner,id);else if(action==='clear')frames.clear();else owned=false;
      gate.resolve();await assert.rejects(pending,status(410));assert.equal(frames.frame(owner.sessionId),undefined);
    }finally{gate.resolve();frames.clear();}
  }
});
