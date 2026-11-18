/** The Apps page: an app drawer for the web apps HUB made, served at /apps. */
export const APPS_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#05060a"><meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"><meta name="apple-mobile-web-app-title" content="Apps">
<link rel="manifest" href="/apps/manifest.webmanifest">
<title>HUB Apps</title>
<style>
:root{--bg:#05060a;--card:rgba(255,255,255,.07);--line:rgba(255,255,255,.14);--text:#f4f5f8;--muted:#9aa0b2;--accent:#a3b1ff}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--text);font:16px/1.4 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
body{min-height:100vh;background:radial-gradient(520px 420px at 0% -10%,rgba(92,110,255,.22),transparent 70%),radial-gradient(460px 400px at 110% 30%,rgba(60,200,255,.12),transparent 70%),radial-gradient(520px 420px at 20% 110%,rgba(180,90,255,.12),transparent 70%),var(--bg)}
main{max-width:860px;margin:0 auto;padding:calc(env(safe-area-inset-top) + 18px) 18px 40px}
header{display:flex;align-items:center;gap:12px;margin-bottom:16px}
h1{font-size:30px;margin:0;letter-spacing:-.02em}.count{color:var(--muted);font-weight:600}
.glass{background:rgba(255,255,255,.08);backdrop-filter:blur(20px) saturate(1.6);-webkit-backdrop-filter:blur(20px) saturate(1.6);border:.6px solid var(--line);box-shadow:inset 0 1px 0 rgba(255,255,255,.18)}
.search{display:flex;align-items:center;gap:8px;border-radius:14px;padding:0 12px;height:44px;margin-bottom:22px}
.search input{flex:1;background:none;border:0;color:var(--text);font:inherit;outline:none}.search svg{opacity:.6}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(88px,1fr));gap:22px 14px}
.app{display:flex;flex-direction:column;align-items:center;gap:8px;text-decoration:none;color:var(--text);position:relative;-webkit-tap-highlight-color:transparent}
.icon{width:68px;height:68px;border-radius:19px;display:grid;place-items:center;font-size:30px;font-weight:800;color:#fff;box-shadow:0 8px 20px rgba(0,0,0,.35),inset 0 1px 0 rgba(255,255,255,.35);border:.6px solid rgba(255,255,255,.25);transition:transform .15s}
.app:active .icon{transform:scale(.92)}
.name{font-size:12.5px;font-weight:600;text-align:center;line-height:1.2;max-width:96px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.shared{position:absolute;top:-4px;right:6px;width:20px;height:20px;border-radius:50%;background:#66ebad;color:#04210f;font-size:11px;display:grid;place-items:center;font-weight:900;border:2px solid var(--bg)}
.more{position:absolute;top:-6px;left:4px;width:26px;height:26px;border-radius:50%;border:0;color:var(--text);display:none;cursor:pointer}
.app:hover .more{display:grid;place-items:center}
.empty{text-align:center;color:var(--muted);padding:60px 20px}.empty b{display:block;color:var(--text);font-size:18px;margin-bottom:6px}
dialog{border:0;padding:0;background:transparent;color:var(--text);max-width:440px;width:calc(100% - 28px)}
dialog::backdrop{background:rgba(0,0,0,.55);backdrop-filter:blur(4px)}
.sheet{border-radius:26px;padding:20px;background:rgba(22,24,32,.92)}
.sheet h2{margin:0 0 4px;font-size:20px}.sheet p{margin:0 0 14px;color:var(--muted);font-size:14px}
.row{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0}
button.pill{border:0;border-radius:999px;padding:10px 16px;font:600 15px inherit;font-family:inherit;color:var(--text);background:rgba(255,255,255,.1);cursor:pointer}
button.pill.primary{background:var(--accent);color:#0a0d1f}button.pill.danger{color:#ff8a80}
.link{display:flex;gap:8px;align-items:center;border-radius:14px;padding:10px 12px;margin:8px 0;background:rgba(255,255,255,.06);font-size:14px;word-break:break-all}
.link small{color:var(--muted);display:block}
.foot{margin-top:34px;color:var(--muted);font-size:13px;text-align:center}.foot button{background:none;border:0;color:var(--accent);font:inherit;cursor:pointer}
input.text{width:100%;height:44px;border-radius:12px;border:.6px solid var(--line);background:rgba(255,255,255,.06);color:var(--text);padding:0 12px;font:inherit}
.toast{position:fixed;left:50%;bottom:calc(env(safe-area-inset-bottom) + 24px);transform:translateX(-50%);padding:10px 16px;border-radius:999px;font-weight:600;font-size:14px;opacity:0;transition:opacity .2s;pointer-events:none}
.toast.on{opacity:1}
button:focus:not(:focus-visible){outline:none}
</style></head><body><main>
<header><h1>Apps</h1><span class="count" id="count"></span></header>
<label class="search glass"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><input id="q" placeholder="Search apps" autocomplete="off"></label>
<section class="grid" id="grid"></section>
<div class="empty" id="empty" hidden><b>No apps yet</b>Ask HUB to build something — a tracker, a calculator, a game. It appears here.</div>
<div class="foot" id="foot"></div>
</main>
<dialog id="dlg"><div class="sheet glass" id="sheet"></div></dialog>
<div class="toast glass" id="toast"></div>
<script>
const api=(body)=>fetch('/api/hub/apps',{method:body?'POST':'GET',credentials:'same-origin',headers:Object.assign({'x-hub-apps':'1'},body?{'content-type':'application/json'}:{}),body:body?JSON.stringify(body):undefined}).then(async r=>{const v=await r.json().catch(()=>({}));if(!r.ok)throw new Error(v.detail||'Something went wrong');return v;});
let state={apps:[],sharing:{accountKey:false}};
const $=id=>document.getElementById(id),esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function toast(t){const e=$('toast');e.textContent=t;e.classList.add('on');clearTimeout(toast.t);toast.t=setTimeout(()=>e.classList.remove('on'),2200);}
function render(){
  const q=$('q').value.trim().toLowerCase(),apps=state.apps.filter(a=>!q||(a.title+' '+a.description).toLowerCase().includes(q));
  $('count').textContent=state.apps.length?state.apps.length:'';
  $('empty').hidden=state.apps.length>0;
  $('grid').innerHTML=apps.map(a=>'<a class="app" href="'+a.url+'" data-id="'+a.id+'"><span class="icon" style="background:linear-gradient(140deg,'+a.color+','+a.color+'99)">'+esc(a.icon)+'</span>'+(a.shares.length?'<span class="shared" title="Shared">↗</span>':'')+'<span class="name">'+esc(a.title)+'</span><button class="more glass" aria-label="Options for '+esc(a.title)+'">⋯</button></a>').join('');
  $('foot').innerHTML='Sharing uses here.now. '+(state.sharing.accountKey?'Your account key is set, so you choose how long links last. <button id="key">Change key</button>':'Without an account key, shared links last 24 hours. <button id="key">Add here.now key</button>');
  $('key').onclick=keySheet;
}
function load(){return api().then(v=>{state=v;render();}).catch(e=>{$('empty').hidden=false;$('empty').innerHTML='<b>Could not load apps</b>'+esc(e.message);});}
function sheet(html){$('sheet').innerHTML=html;$('dlg').showModal();}
function close(){$('dlg').close();}
function hours(h){return h<24?h+' hour'+(h>1?'s':''):h/24+' day'+(h>24?'s':'');}
function appSheet(app){
  const links=app.shares.map(s=>'<div class="link"><div style="flex:1">'+esc(s.url)+'<small>'+(s.expiresAt?'Expires '+new Date(s.expiresAt).toLocaleString():'No expiry')+'</small></div><button class="pill" data-copy="'+esc(s.url)+'">Copy</button></div>').join('');
  sheet('<h2>'+esc(app.title)+'</h2><p>'+esc(app.description||'')+'</p>'+
    '<div class="row"><button class="pill primary" data-open>Open</button><button class="pill" data-rename>Rename</button><button class="pill danger" data-remove>Remove</button></div>'+
    '<h2 style="font-size:16px;margin-top:16px">Share a link</h2><p>Anyone with the link can open this app until it expires.</p>'+
    '<div class="row">'+[1,24,168,720].map(h=>'<button class="pill" data-share="'+h+'">'+hours(h)+'</button>').join('')+'</div>'+links+
    (app.shares.length?'<div class="row"><button class="pill danger" data-unshare>Stop sharing</button></div>':'')+
    '<div class="row" style="justify-content:flex-end"><button class="pill" data-close>Done</button></div>');
  const s=$('sheet');
  s.querySelector('[data-open]').onclick=()=>location.href=app.url;
  s.querySelector('[data-close]').onclick=close;
  s.querySelector('[data-rename]').onclick=()=>{const t=prompt('Rename app',app.title);if(t)api({action:'rename',id:app.id,title:t}).then(v=>{state=v;render();close();}).catch(e=>toast(e.message));};
  s.querySelector('[data-remove]').onclick=()=>{if(confirm('Remove '+app.title+'? Its share links stop working when they expire.'))api({action:'remove',id:app.id}).then(v=>{state=v;render();close();toast('Removed');}).catch(e=>toast(e.message));};
  s.querySelectorAll('[data-share]').forEach(b=>b.onclick=()=>{b.textContent='Publishing…';api({action:'share',id:app.id,hours:Number(b.dataset.share)}).then(v=>{state=v;render();const fresh=state.apps.find(a=>a.id===app.id);if(fresh)appSheet(fresh);if(v.result&&v.result.note)toast(v.result.note);else toast('Link ready');}).catch(e=>{toast(e.message);b.textContent=hours(Number(b.dataset.share));});});
  s.querySelectorAll('[data-copy]').forEach(b=>b.onclick=()=>navigator.clipboard.writeText(b.dataset.copy).then(()=>toast('Copied'),()=>toast('Copy failed')));
  const un=s.querySelector('[data-unshare]');if(un)un.onclick=()=>api({action:'unshare',id:app.id}).then(v=>{state=v;render();const fresh=state.apps.find(a=>a.id===app.id);if(fresh)appSheet(fresh);toast(v.result&&v.result.note?v.result.note:'Links removed');}).catch(e=>toast(e.message));
}
function keySheet(){
  sheet('<h2>here.now account key</h2><p>Links made with your key last as long as you choose and can be taken down early. Create one at here.now, then paste it. It stays on your HUB.</p><input class="text" id="k" type="password" placeholder="API key" autocomplete="off"><div class="row" style="justify-content:flex-end"><button class="pill" data-close>Cancel</button>'+(state.sharing.accountKey?'<button class="pill danger" data-clear>Remove key</button>':'')+'<button class="pill primary" data-save>Save</button></div>');
  const s=$('sheet');s.querySelector('[data-close]').onclick=close;
  s.querySelector('[data-save]').onclick=()=>api({action:'key',apiKey:$('k').value}).then(v=>{state=v;render();close();toast('Key saved');}).catch(e=>toast(e.message));
  const c=s.querySelector('[data-clear]');if(c)c.onclick=()=>api({action:'key',apiKey:''}).then(v=>{state=v;render();close();toast('Key removed');}).catch(e=>toast(e.message));
}
$('grid').addEventListener('click',e=>{const more=e.target.closest('.more');if(!more)return;e.preventDefault();const id=more.closest('.app').dataset.id;const app=state.apps.find(a=>a.id===id);if(app)appSheet(app);});
let press;$('grid').addEventListener('pointerdown',e=>{const el=e.target.closest('.app');if(!el)return;press=setTimeout(()=>{press='done';const app=state.apps.find(a=>a.id===el.dataset.id);if(app)appSheet(app);},450);});
['pointerup','pointercancel','pointerleave'].forEach(t=>$('grid').addEventListener(t,()=>{if(press!=='done')clearTimeout(press);}));
$('grid').addEventListener('click',e=>{if(press==='done'){e.preventDefault();press=undefined;}},true);
$('q').addEventListener('input',render);
load();
</script></body></html>`;
