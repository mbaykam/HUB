import assert from 'node:assert/strict';import {build} from 'esbuild';import {createServer} from 'node:http';import {once} from 'node:events';import {createRequire} from 'node:module';import {mkdir,writeFile} from 'node:fs/promises';
const output=process.argv[2];await mkdir(output,{recursive:true});
const bundle=await build({stdin:{contents:'export {openKnowledgeWorkspace} from "./packages/harness-overlay/src/client/memory/knowledge-workspace.ts";import styles from "./packages/harness-overlay/src/client/memory/graph-browser.css";export {styles};',resolveDir:process.cwd(),loader:'ts'},loader:{'.css':'text'},bundle:true,write:false,platform:'browser',format:'esm'});
const nodes=[],edges=[],similarities=[];for(const topic of ['HUB','Travel','Learning','Music'])for(let i=0;i<7;i++){const id=topic.toLowerCase()+'-'+i;nodes.push({id,title:topic+' '+['Overview','Ideas','Plans','Notes','Resources','Decisions','Progress'][i],permalink:'Notes/'+id,hash:'a'.repeat(64),modifiedAt:Date.now()});if(i)edges.push({source:topic.toLowerCase()+'-0',target:id,label:''});for(let j=0;j<i;j++)similarities.push({source:topic.toLowerCase()+'-'+j,target:id,score:.82});}
edges.push({source:'hub-0',target:'learning-0',label:''});const graph={secondBrain:true,nodes,edges,similarities,page:1,hasMore:false,partial:false,omittedRelations:0,hiddenNodes:0};
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aUkcAAAAASUVORK5CYII=','base64');
const asset={id:'b'.repeat(64),name:'Diagram.png',path:'Attachments/Diagram.png',mediaType:'image/png',bytes:png.length};let uploaded=false;
const note={...nodes[0],content:'Useful information in English. Türkçe bilgiler de aynı notta kalabilir.\n\n![Architecture](../Attachments/Diagram.png)\n\nRead https://example.com/ and [[Notes/learning-0|Learning]].',backlinks:[],links:[nodes[14]],sources:[]};
const server=createServer(async(req,res)=>{const url=new URL(req.url,'http://fixture.invalid');
 if(url.pathname==='/ui.js'){res.writeHead(200,{'content-type':'text/javascript'});res.end(bundle.outputFiles[0].text);return;}
 if(url.pathname==='/api/hub/memory'){
  const json=value=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(value));};
  if(url.searchParams.get('view')==='asset'){res.writeHead(200,{'content-type':'image/png'});res.end(png);return;}
  if(url.searchParams.get('view')==='assets'){json({assets:[asset]});return;}
  if(url.searchParams.get('view')==='note'){json({...note,id:url.searchParams.get('id'),title:nodes.find(n=>n.id===url.searchParams.get('id')).title});return;}
  if(url.searchParams.get('view')==='graph'){json(graph);return;}
  if(url.searchParams.get('action')==='upload-asset'){let bytes=0;for await(const chunk of req)bytes+=chunk.length;assert.ok(bytes>0);assert.equal(req.headers['x-hub-memory'],'1');uploaded=true;json({asset,extracted:false});return;}
  json({vault:'C:/test/vault'});return;
 }
 res.end('<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><body data-ds-dark-theme>');
});server.listen(0,'127.0.0.1');await once(server,'listening');
const {chromium}=createRequire(import.meta.url)(process.env.HUB_UI_QA_PLAYWRIGHT??'playwright');let browser;
try{browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(`http://127.0.0.1:${server.address().port}/`);
 await page.evaluate(async graph=>{const module=await import('/ui.js'),style=document.createElement('style');style.textContent=module.styles;document.head.append(style);module.openKnowledgeWorkspace(document.body,document,graph,()=>{});},graph);
 const cloud=page.locator('[data-knowledge-cloud]');await cloud.waitFor();const box=await cloud.boundingBox();assert.ok(box.height>250&&box.width>250);assert.equal(await cloud.getAttribute('data-topic-count'),'4');await page.screenshot({path:output+'/cloud-3d.png'});
 await cloud.evaluate(canvas=>{window.beforePixels=canvas.toDataURL();});await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2+45,box.y+box.height/2+18,{steps:8});await page.mouse.up();await page.waitForFunction(()=>window.beforePixels!==document.querySelector('[data-knowledge-cloud]').toDataURL());
 await page.getByRole('button',{name:'Notes',exact:true}).click();await page.locator('[data-note-id="hub-0"]').click();const image=page.locator('[data-graph-note] .knowledge-media-card img');await image.waitFor();await page.waitForFunction(()=>document.querySelector('.knowledge-media-card img')?.naturalWidth>0);assert.equal(await image.getAttribute('alt'),'Architecture');assert.equal(await page.locator('[data-graph-note] a[href="https://example.com/"]').count(),1);assert.equal(await page.locator('.knowledge-inline-link').count(),1);await page.screenshot({path:output+'/note-media.png'});
 await page.getByRole('button',{name:'Attachments',exact:true}).click();await page.locator('[data-knowledge-assets] img').waitFor();await page.getByLabel('Add knowledge files').setInputFiles({name:'Fixture.png',mimeType:'image/png',buffer:png});await page.waitForFunction(()=>document.querySelector('[role=status]').textContent.includes('Original files saved'));assert.equal(uploaded,true);await page.screenshot({path:output+'/attachments.png'});
 for(const width of [320,768]){await page.setViewportSize({width,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));}
 assert.deepEqual(errors,[]);const result={nodes:nodes.length,topicClouds:4,realEdges:edges.length,rotation:true,imageLoaded:true,externalLink:true,internalLink:true,upload:true,errors};await writeFile(output+'/result.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
