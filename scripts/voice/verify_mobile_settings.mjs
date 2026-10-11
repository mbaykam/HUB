// Disposable native-shaped settings fixture. Complements, not replaces,
// the authenticated browser check against actual native SettingsRoot controls.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';

const { outputFiles } = await build({loader:{'.css':'text'},stdin:{contents:'export {installMobileSettings} from "./packages/harness-overlay/src/client/host/mobile-settings.ts"',resolveDir:process.cwd(),loader:'ts'},bundle:true,write:false,format:'esm',platform:'browser'});
const drawerStyles = await readFile('packages/harness-overlay/src/client/host/mobile-sidebar-drawer.css','utf8');
let updateId = 'builtin';
const server = createServer((req,res)=>{
  if(req.url==='/api/hub/ui/status'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({schema:1,id:updateId,label:'Fixture UI',compatibility:'a'.repeat(64)}));return;}
  if(req.url==='/settings.js'){res.writeHead(200,{'content-type':'text/javascript'});res.end(outputFiles[0].text);return;}
  res.writeHead(200,{'content-type':'text/html'});
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
  html,body{margin:0;width:100%;height:100%;font:16px system-ui}body{--dsw-alias-label-primary:#eef0fa}
  main{position:relative;overflow:hidden;width:100vw;height:100dvh}
  [role=presentation]{position:fixed;inset:0;display:flex;align-items:center;justify-content:center}
  [role=dialog]{display:flex;width:800px;height:700px;overflow:hidden;background:#222;color:#eee}
  nav{display:flex;flex-direction:column}nav>div:last-child{display:flex;flex-direction:column}
  nav button{display:flex}nav button svg{width:20px;height:20px}
  [data-slot="settings.general.item"]>div{display:flex;justify-content:space-between;border-bottom:1px solid #777}
  [data-slot="settings.general.item"]>div>div:last-child{display:flex;gap:8px}
  ${drawerStyles}</style><body data-ds-dark-theme><main data-minke-mobile-sidebar-frame data-sidebar-collapsed>
  <aside data-minke-mobile-sidebar><div data-slot="sidebar.settings"></div></aside></main>`);
});
server.listen(0,'127.0.0.1');await once(server,'listening');
const {chromium,webkit}=createRequire(import.meta.url)(process.argv[2]);let browser;
try{
  browser=process.argv.includes('--webkit')?await webkit.launch({headless:true}):await chromium.launch({channel:'chrome',headless:true});
  const page=await browser.newPage({viewport:{width:390,height:844}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.evaluate(async()=>{
    document.documentElement.setAttribute('data-minke-mobile-web','');
    const {installMobileSettings}=await import('/settings.js');globalThis.dispose=installMobileSettings();globalThis.writes=0;globalThis.nativeCloses=0;
    globalThis.openSettings=()=>{
      document.querySelector('main').setAttribute('data-minke-mobile-settings-open','');
      const slot=document.querySelector('[data-slot="sidebar.settings"]');
      slot.innerHTML='<div role="presentation"><div role="dialog" aria-labelledby="native-title"><nav><div id="native-title">Settings</div><div>'+['General','HUB','Models','Plugins','Agent presets'].map(name=>'<button><svg aria-hidden="true"></svg><span>'+name+'</span></button>').join('')+'</div></nav><div><div><div><button>Native action</button></div><button aria-label="Native close">×</button></div><div><div data-slot="settings.general.item"></div></div></div></div></div>';
      const buttons=slot.querySelectorAll('nav button');
      const render=name=>{
        const body=slot.querySelector('[data-slot="settings.general.item"]');
        body.innerHTML=name==='General'?'<div><span>Appearance</span><div>'+['Light','Dark','System'].map(label=>'<button aria-pressed="false">'+label+'</button>').join('')+'</div></div><div><label for="name">Name</label><input id="name"></div><div><span>Font size</span><span><span>14</span><span><button aria-label="Larger">+</button><button aria-label="Smaller">−</button></span></span></div>':'<p>'+name+' native controls</p>';
        body.querySelector('input')?.addEventListener('input',()=>globalThis.writes++);
      };
      for(const button of buttons)button.addEventListener('click',()=>{buttons.forEach(b=>b.setAttribute('aria-current',String(b===button)));render(button.textContent);});
      slot.querySelector('[aria-label="Native close"]').addEventListener('click',()=>{globalThis.nativeCloses++;slot.replaceChildren();document.querySelector('main').removeAttribute('data-minke-mobile-settings-open');});render('General');
    };openSettings();
  });
  const dialog=page.locator('[data-hub-mobile-settings]');await dialog.waitFor();
  assert.equal(await dialog.getAttribute('data-hub-settings-view'),'index');
  await page.getByRole('button',{name:'Check UI update',exact:true}).click();
  await page.getByText('PWA UI · Fixture UI · up to date',{exact:true}).waitFor();
  updateId='b'.repeat(64);
  await page.getByRole('button',{name:'Check again',exact:true}).click();
  await page.getByText('UI update ready · Fixture UI',{exact:true}).waitFor();
  const currentUrl=page.url();
  page.once('dialog',async prompt=>{assert.match(prompt.message(),/voice call/);await prompt.dismiss();});
  await page.getByRole('button',{name:'Reload to apply',exact:true}).click();
  assert.equal(page.url(),currentUrl);assert.equal(await dialog.getAttribute('data-hub-settings-view'),'index','Cancelling update reload preserves Settings');
  assert.equal(await dialog.evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(13, 17, 32)','Dark Settings is opaque');
  await page.evaluate(()=>document.body.removeAttribute('data-ds-dark-theme'));
  assert.equal(await dialog.evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(243, 245, 251)','Light Settings uses its light surface');
  await page.evaluate(()=>document.body.setAttribute('data-ds-dark-theme',''));
  await page.getByRole('button',{name:'Close settings',exact:true}).focus();await page.keyboard.press('Shift+Tab');
  assert.equal(await page.evaluate(()=>document.activeElement?.textContent),'Agent presets','Keyboard focus wraps inside Settings');
  assert.equal(await page.evaluate(async()=>{await new Promise(r=>setTimeout(r,100));let changes=0;const observer=new MutationObserver(records=>changes+=records.length);observer.observe(document.body,{childList:true,subtree:true,attributes:true});await new Promise(r=>setTimeout(r,150));observer.disconnect();return changes;}),0,'Settings observer settles without rerendering itself');
  for(const width of [320,390,430,768]){
    await page.setViewportSize({width,height:480});
    for(let i=0;i<5;i++){
      await dialog.locator('[data-hub-settings-category]').nth(i).click();
      await page.waitForFunction(()=>document.querySelector('[data-hub-settings-view="section"]'));
      const box=await dialog.boundingBox();assert.ok(Math.abs(box.x)<1&&Math.abs(box.y)<1&&box.width===width&&box.height===480);
      assert.equal(await dialog.locator('h2').textContent(),['General','HUB','Models','Plugins','Agent presets'][i]);
      await page.getByRole('button',{name:'Back to settings',exact:true}).click();
    }
  }
  await dialog.locator('[data-hub-settings-category]').first().click();await page.locator('[data-hub-settings-themes]').waitFor();
  const themes=await page.locator('[data-hub-settings-themes] button').evaluateAll(nodes=>nodes.map(node=>{const r=node.getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height};}));
  assert.equal(themes[0].y,themes[2].y);assert.ok(themes.every(r=>r.h>=44&&r.w>=44));
  await page.getByRole('textbox',{name:'Name',exact:true}).fill('Synthetic setting');assert.equal(await page.evaluate(()=>writes),1,'Native input listener remains attached');
  await page.keyboard.press('Escape');assert.equal(await dialog.getAttribute('data-hub-settings-view'),'index');
  await page.getByRole('button',{name:'Close settings',exact:true}).click();await dialog.waitFor({state:'detached'});assert.equal(await page.evaluate(()=>nativeCloses),1);
  await page.evaluate(()=>openSettings());await dialog.waitFor();assert.equal(await dialog.getAttribute('data-hub-settings-view'),'index');
  await page.setViewportSize({width:1280,height:900});await dialog.waitFor({state:'detached'});
  assert.equal(await page.locator('[role="dialog"]').getAttribute('aria-labelledby'),'native-title');assert.equal(await page.getByRole('button',{name:'Native close',exact:true}).isVisible(),true);
  await page.evaluate(()=>dispose());assert.equal(await page.locator('[data-hub-settings-header]').count(),0);assert.deepEqual(errors,[]);
  console.log('PASS: settings category navigation,viewport resize,no off-canvas focus scrolling,native input callback,Back/Close,reopen,desktop restoration and cleanup');
}finally{await browser?.close();server.close();}
