'use strict';
// Chromium geometry/input simulation using the real upstream InputBar. No host,
// providers, session writes or voice connection are used.
const assert=require('node:assert/strict');
const {app,BrowserWindow}=require('electron');
const {build}=require('esbuild');
const {mkdir,writeFile}=require('node:fs/promises');
const {readFileSync}=require('node:fs');
const {resolve,join}=require('node:path');
const root=resolve(__dirname,'..'),out=join(root,'.tmp','composer-layout-runtime');
(async()=>{await app.whenReady();await mkdir(out,{recursive:true});
 const built=await build({absWorkingDir:root,entryPoints:['tests/fixtures/real-composer.jsx'],bundle:true,write:false,outdir:out,loader:{'.module.css':'local-css','.css':'css','.ttf':'dataurl','.woff':'dataurl','.woff2':'dataurl'},plugins:[{name:'overlay-style-text',setup(b){b.onLoad({filter:/harness-overlay.*\.css$/},a=>({contents:readFileSync(a.path,'utf8'),loader:'text'}));}}],alias:{react:join(root,'node_modules/react'),'react-dom':join(root,'node_modules/react-dom')},jsx:'automatic',define:{'process.env.NODE_ENV':'"development"'},logLevel:'silent'});
 for(const file of built.outputFiles)await writeFile(file.path,file.contents);
 await writeFile(join(out,'index.html'),'<!doctype html><html data-minke-mobile-web><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="real-composer.css"><style>body{margin:0;padding:80px 0 0;--dsh-composer-side-clearance:16px}[data-hub-composer-stack]{width:100%}</style></head><body><div id="root"></div><script src="real-composer.js"></script></body></html>');
 const win=new BrowserWindow({show:false,width:390,height:800,webPreferences:{contextIsolation:true,nodeIntegration:false}});
 try{for(const width of [320,390,430])for(const mode of ['','chat','chat&child']){
  win.setContentSize(width,800);await win.loadFile(join(out,'index.html'),{search:mode?'?'+mode:''});
  const deadline=Date.now()+5000;while(!await win.webContents.executeJavaScript('window.fixtureReady===true')){if(Date.now()>deadline)throw Error('fixture timeout');await new Promise(r=>setTimeout(r,20));}
  const geometry=await win.webContents.executeJavaScript(`(()=>{const d=document,rect=e=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}},menu=d.querySelector('[data-hub-composer-menu]'),voice=d.querySelector('[data-voice-start]'),primary=d.querySelector('[data-hub-composer-send]'),stop=d.querySelector('[data-hub-composer-stop]');return{controls:[menu,voice,primary,...stop?[stop]:[]].map(rect),stop:rect(stop??primary),focus:window.fixtureFocusCalls,stops:window.fixtureStops};})()`);
  for(const a of geometry.controls){assert.ok(a.width>=42&&a.height>=42,`${width}/${mode} minimum hit size`);for(const b of geometry.controls)if(a!==b)assert.ok(Math.min(a.right,b.right)-Math.max(a.x,b.x)<=0||Math.min(a.bottom,b.bottom)-Math.max(a.y,b.y)<=0,`${width}/${mode} overlapping actions`);}
  const ys=geometry.controls.map(r=>r.y);assert.ok(Math.max(...ys)-Math.min(...ys)<1,`${width}/${mode} action baseline`);
  if(mode.includes('chat')){
   await win.webContents.executeJavaScript('document.activeElement?.blur()');
   const {x,y,width:w,height:h}=geometry.stop;
   const hit=await win.webContents.executeJavaScript(`document.elementFromPoint(${x+w/2},${y+h/2})?.closest('button')?.getAttribute('aria-label')`);assert.equal(hit,'Stop',`${mode} actual Stop hit target`);
   win.webContents.sendInputEvent({type:'mouseDown',x:Math.round(x+w/2),y:Math.round(y+h/2),button:'left',clickCount:1});win.webContents.sendInputEvent({type:'mouseUp',x:Math.round(x+w/2),y:Math.round(y+h/2),button:'left',clickCount:1});
   await new Promise(r=>setTimeout(r,30));const after=await win.webContents.executeJavaScript('({focus:window.fixtureFocusCalls,stops:window.fixtureStops,editor:document.activeElement?.hasAttribute("data-composer-input")})');assert.equal(after.stops,geometry.stops+1);assert.equal(after.focus,geometry.focus);assert.equal(after.editor,false);
  }
  console.log(`PASS ${width}px ${mode||'Home'}: disjoint aligned action hit boxes${mode?' + original Stop click, no editor focus':''}`);
 }}finally{win.destroy();}
 app.quit();
})().catch(error=>{console.error(error);app.exit(1);});
