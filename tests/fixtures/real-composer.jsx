// Layout simulation: actual upstream InputBar/CSS and HUB action menu. Machine
// state and other slot entries are inert; no session, provider or file RPCs run.
// Slot wrappers follow ui-renderer/src/client/scoped-slots.tsx:SlotOutlet.
import React from 'react';
import {createRoot} from 'react-dom/client';
import {InputBar} from '../../vendor/deepseek-harness/packages/client/ui-conversation/src/client/skeleton/InputBar.tsx';
import {compactComposer} from '../../packages/harness-overlay/src/client/host/compact-composer.ts';
import {installComposerResearch} from '../../packages/harness-overlay/src/client/host/composer-research.tsx';
import mobileStyles from '../../packages/harness-overlay/src/client/host/mobile-hubs.css';
const style=document.createElement('style');style.textContent=mobileStyles;document.head.append(style);
import '../../packages/harness-overlay/src/client/host/composer-controls.css';
let More;
const removeResearch=installComposerResearch({slots:{register(_o,c){More=c;return()=>{}}},sessions:{}},{},document);
const snapshot={draft:'',imageIds:[],queue:[],phase:'idle'};
const t=key=>({'input.send':'Send','input.stop':'Stop','input.commands':'Commands','placeholder.default':'Ask anything…'}[key]??key);
const renderSlot=(name)=> <div data-slot={name} style={{display:'contents'}}>{name==='conversation.input.left'?<><More sessionId="simulation"/><span><button aria-label="Choose character">Character</button></span><span><button aria-label="Attach photos or files">File</button></span></>:null}</div>;
const session=location.search.includes('child')?{running:true,subagent:{address:{mode:'continuable'},parentAvailable:true}}:{};
const props={useInput:s=>s(snapshot),useSession:s=>s(session),useNotices:s=>s({}),useMenuLauncher:s=>s(null),useProjection:()=>undefined,useLexicon:()=>{},inputActions:{submit(){}},keyboard:{editor:null},t,renderSlot,variant:'hero',sessionId:'simulation',placeholder:'Ask anything…',toggleCommandMenu(){},stop(){}};
const reactRoot=createRoot(document.getElementById('root'));reactRoot.render(<div data-hub-home><div data-hub-composer-stack><div data-hub-text-heading><button>Chat options</button></div><div data-hub-voice-hub data-idle-bar><button data-voice-start aria-label="Start voice"><strong>Talk</strong><span data-voice-glyph>{[1,2,3,4,5].map(i=><i key={i}/>)}</span></button></div><InputBar {...props}/></div></div>);
const observer=new MutationObserver(()=>{if(!location.search.includes('before')){const c=document.querySelector('[data-composer-card]');if(c)compactComposer(c);}});observer.observe(document.getElementById('root'),{childList:true,subtree:true});
window.fixtureDispose=()=>{observer.disconnect();reactRoot.unmount();removeResearch();};
setTimeout(()=>{const card=document.querySelector('[data-composer-card]');if(location.search.includes('before')){const more=card.querySelector('[aria-label="More actions"]');if(more){card.setAttribute('data-hub-compact-composer','');more.setAttribute('data-hub-composer-menu','');const tools=more.parentElement.parentElement,row=tools.parentElement;tools.setAttribute('data-hub-composer-tools','');row.setAttribute('data-hub-composer-row','');const trailing=row.lastElementChild;trailing.setAttribute('data-hub-composer-trailing','');const b=trailing.querySelectorAll('button');b[b.length-1]?.setAttribute('data-hub-composer-send','');}}else compactComposer(card);window.fixtureReady=true;},300);
