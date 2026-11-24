import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const feed=(items)=>`<?xml version="1.0"?><rss><channel>${items.map(([title,source,link,date])=>`<item><title>${title} - ${source}</title><link>${link}</link><pubDate>${date}</pubDate><source url="https://example.com">${source}</source></item>`).join('')}</channel></rss>`;

test('news feed parsing keeps order, strips the source suffix and drops repeats and unsafe links',async()=>{
  const {parseNewsFeed}=await import('../packages/harness-overlay/src/host/briefing.ts');
  const items=parseNewsFeed(feed([
    ['Yapay zek&#226; &amp; robotlar','Kaynak A','https://news.example/a','Mon, 23 Nov 2026 07:00:00 GMT'],
    ['Yapay zekâ & robotlar','Kaynak B','https://news.example/b','Mon, 23 Nov 2026 08:00:00 GMT'],
    ['Script link','Kaynak C','javascript:alert(1)','Mon, 23 Nov 2026 08:00:00 GMT'],
    ['Second story','Kaynak D','https://news.example/d','not a date'],
  ]));
  assert.deepEqual(items.map(i=>i.title),['Yapay zekâ & robotlar','Second story']);
  assert.equal(items[0].source,'Kaynak A');assert.equal(items[1].at,0);
});

test('briefing topics: user and assistant add, duplicates merge, refresh keeps old headlines when a feed fails',async()=>{
  const {BriefingService,BRIEFING_MAX_TOPICS}=await import('../packages/harness-overlay/src/host/briefing.ts');
  const root=await mkdtemp(join(tmpdir(),'hub-briefing-'));let fail=false,calls=0;
  try{
    const fetcher=async(url)=>{calls++;assert.match(url,/^https:\/\/news\.google\.com\/rss\/search\?q=/);if(fail)throw Error('offline');return new Response(feed([['Story for '+decodeURIComponent(url.split('q=')[1].split('&')[0]),'Src','https://news.example/x','Mon, 23 Nov 2026 07:00:00 GMT']]));};
    const service=new BriefingService(root,fetcher);
    assert.deepEqual((await service.view()).topics,[]);
    assert.equal((await service.view()).stale,false,'No topics means nothing to fetch');
    const first=await service.addTopic('Bitcoin','user');
    assert.equal((await service.addTopic('bitcoin','assistant')).id,first.id,'Same topic is not added twice');
    await service.addTopic('Yapay zekâ','assistant');
    assert.equal((await service.view()).stale,true);
    await service.refresh();
    let view=await service.view();
    assert.deepEqual(view.briefing.sections.map(s=>s.items.length),[1,1]);
    assert.deepEqual(view.topics.map(t=>t.by),['user','assistant']);
    fail=true;await service.refresh();view=await service.view();
    assert.ok(view.briefing.sections.every(s=>s.failed&&s.items.length===1),'A failed fetch keeps the last headlines');
    await service.removeTopic(first.id);view=await service.view();
    assert.deepEqual(view.topics.map(t=>t.title),['Yapay zekâ']);assert.equal(view.briefing.sections.length,1);
    const reopened=new BriefingService(root,fetcher);assert.deepEqual((await reopened.view()).topics.map(t=>t.title),['Yapay zekâ']);
    for(let i=1;i<BRIEFING_MAX_TOPICS;i++)await service.addTopic('Topic '+i,'user');
    await assert.rejects(service.addTopic('One too many','user'),/at most/);
    await assert.rejects(service.addTopic('x'.repeat(81),'user'),/1–80/);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('renaming the assistant renames the main character and moves a clashing hidden character aside',async()=>{
  const {CharacterStore:Store}=await import('../packages/harness-overlay/src/host/characters-store.ts');
  const root=await mkdtemp(join(tmpdir(),'hub-name-'));
  try{
    const {randomUUID}=await import('node:crypto');
    const mainId=randomUUID(),voiceId=randomUUID(),route={provider:'p',model:'m'};
    const speech={stt:{engine:'whisper',model:'base.en'},tts:{engine:'kokoro',model:'82m',voice:'af_heart'}};
    const base={avatar:'hub',description:'',tools:{mode:'inherit'},delegateTo:null};
    const store=new Store(root);
    await store.load(async()=>({revision:0,mainId,voiceId,bindings:{},characters:[
      {...base,id:mainId,name:'HUB',instructions:'You are HUB, the user\'s main personal assistant.',route,speech:null},
      {...base,id:voiceId,name:'Vera',avatar:'voice',instructions:'Be warm.',route,speech}]}));
    const state=await store.change({action:'name',revision:0,name:'Vera'},async()=>{});
    const main=state.characters.find(c=>c.id===mainId),voice=state.characters.find(c=>c.id===voiceId);
    assert.equal(main.name,'Vera');assert.match(main.instructions,/^You are Vera, the user/);
    assert.equal(voice.name,'Vera (voice)');
    await assert.rejects(store.change({action:'name',revision:state.revision,name:'  '},async()=>{}));
  }finally{await rm(root,{recursive:true,force:true});}
});
