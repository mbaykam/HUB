// Browser gesture regression fixture. Actual installed UI is checked separately.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
const {outputFiles}=await build({loader:{'.css':'text'},stdin:{contents:'export {installMobileWidgetBack} from "./packages/harness-overlay/src/client/host/mobile-widget-back.ts"',resolveDir:process.cwd(),loader:'ts'},bundle:true,write:false,format:'esm',platform:'browser'});
const styles=await readFile('packages/harness-overlay/src/client/host/mobile-sidebar-drawer.css','utf8');
const server=createServer((req,res)=>{
  res.writeHead(200,{'content-type':req.url==='/back.js'?'text/javascript':'text/html'});
  res.end(req.url==='/back.js'?outputFiles[0].text:`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
  html,body{margin:0;height:100%;font:16px system-ui}main{height:100dvh;position:relative}button{min-height:44px}
  ${styles}
  #widget{position:fixed;inset:0;margin:0;padding:20px;box-sizing:border-box;overflow-y:auto;background:#131724;color:white;z-index:50}
  #widget header{display:flex;justify-content:space-between;gap:12px;align-items:center}#content{height:1200px}#canvas{height:220px;background:#334;touch-action:none;margin-top:20px}
  </style><html data-minke-mobile-web><body><main data-minke-mobile-sidebar-frame data-minke-mobile-right-drawer-open>
  <div data-minke-mobile-right-drawer><div data-minke-mobile-right-drawer-header><button>Settings</button><button>Close panel</button></div>
  <div data-minke-mobile-right-drawer-body><section data-minke-usage-meter data-expanded><button data-minke-usage-toggle>Usage</button><div data-minke-usage-content><div data-minke-usage-providers><article data-minke-usage-card style="height:440px">Codex</article><article data-minke-usage-card style="height:300px">OpenRouter</article></div></div></section><details open><summary>Memory</summary><div style="height:400px">Notes</div></details><details open><summary>Voice history</summary><div style="height:400px">Sessions</div></details></div></div></main>
  <div id="widget" role="dialog" hidden><header><h2>Widget</h2><button id="back">Back</button></header><div id="content"><input aria-label="Search"><div id="canvas">Interactive graph area</div></div></div>`);
});server.listen(0,'127.0.0.1');await once(server,'listening');
const {chromium,webkit}=createRequire(import.meta.url)(process.argv[2]);let browser;
try{
  browser=process.argv.includes('--webkit')?await webkit.launch({headless:true}):await chromium.launch({channel:'chrome',headless:true});
  const page=await browser.newPage({viewport:{width:390,height:480}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const panel=page.locator('[data-minke-mobile-right-drawer-body]'),header=page.locator('[data-minke-mobile-right-drawer-header]');
  for(const width of [320,390,430]){
    await page.setViewportSize({width,height:480});const y=(await header.boundingBox()).y;
    await panel.hover();await page.mouse.wheel(0,2000);await page.waitForTimeout(300);
    assert.ok(await panel.evaluate(el=>el.scrollTop)>500);assert.equal((await header.boundingBox()).y,y,'Panel header does not scroll');
    const last=panel.locator('details').last();await last.locator('summary').scrollIntoViewIfNeeded();assert.ok((await last.boundingBox()).y<480);
    assert.equal(await page.locator('[data-minke-mobile-right-drawer]').evaluate(el=>el.scrollTop),0,'Glass decoration never creates an outer scroller');
  }
  await page.setViewportSize({width:390,height:480});
  await page.evaluate(async()=>{document.documentElement.setAttribute('data-minke-mobile-web','');const surface=document.querySelector('#widget');surface.hidden=false;globalThis.backs=0;globalThis.pans=0;document.querySelector('#back').onclick=()=>backs++;document.querySelector('#canvas').onpointermove=()=>pans++;const{installMobileWidgetBack}=await import('/back.js');globalThis.disposeBack=installMobileWidgetBack(surface,surface.querySelector('header'),()=>document.querySelector('#back').click());});
  const widget=page.locator('#widget');
  async function drag(x,y,dx,dy,pause=150){await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+dx,y+dy,{steps:10});if(pause)await page.waitForTimeout(pause);await page.mouse.up();await page.waitForTimeout(220);}
  await drag(8,130,170,3);assert.equal(await page.evaluate(()=>backs),1,'Edge swipe invokes existing programmatic Back exactly once');
  await page.waitForTimeout(250);await drag(120,40,170,3);assert.equal(await page.evaluate(()=>backs),2,'Header swipe goes back');
  await drag(8,130,25,1);assert.equal(await page.evaluate(()=>backs),2,'Short slow swipe snaps back');
  await drag(8,130,5,160);assert.equal(await page.evaluate(()=>backs),2,'Vertical movement never goes back');
  await drag(90,240,160,2);assert.equal(await page.evaluate(()=>backs),2);assert.ok(await page.evaluate(()=>pans)>0,'Graph retains pointer gestures');
  await widget.evaluate(el=>el.scrollTop=500);await page.waitForTimeout(100);const e=await widget.locator('[data-hub-widget-back-edge]').boundingBox();assert.ok(Math.abs(e.y)<1,'Back strip stays at viewport edge after dialog scrolling');
  await drag(8,180,180,0);assert.equal(await page.evaluate(()=>backs),3);
  await page.mouse.move(8,180);await page.mouse.down();await page.mouse.move(180,180,{steps:10});await widget.dispatchEvent('pointercancel',{pointerId:1,isPrimary:true});await page.mouse.up();await page.waitForTimeout(220);assert.equal(await page.evaluate(()=>backs),3,'Pointer cancellation does not navigate');
  await page.setViewportSize({width:1280,height:800});await drag(8,180,180,0);assert.equal(await page.evaluate(()=>backs),3,'Desktop does not acquire swipe navigation');
  await page.setViewportSize({width:390,height:480});await page.emulateMedia({reducedMotion:'reduce'});await drag(8,180,180,0);assert.equal(await page.evaluate(()=>backs),4);
  await page.evaluate(()=>disposeBack());assert.equal(await widget.locator('[data-hub-widget-back-edge]').count(),0);assert.equal(await widget.getAttribute('data-hub-widget-back-active'),null);assert.deepEqual(errors,[]);
  console.log('PASS: scrollable right panel/fixed header,edge/header Back,short and vertical cancellation,graph pan,scrolled dialog,reduced motion,desktop exclusion,cleanup');
}finally{await browser?.close();server.close();}
