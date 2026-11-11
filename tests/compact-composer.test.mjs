import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from '../vendor/deepseek-harness/node_modules/jsdom/lib/api.js';
import {compactComposer} from '../packages/harness-overlay/src/client/host/compact-composer.ts';
test('compact layout retains draft, file and send handlers across repeated reconciliation',()=>{
 const {document}=new JSDOM('<div data-composer-card><div data-input-scroll><div contenteditable="true" aria-label="Ask anything…">Keep my draft</div><div data-composer-placeholder>Ask anything… / commands</div></div><div><div><span><button aria-label="More actions">+</button></span><span><button aria-label="Attach photos or files"></button></span></div><div><button aria-label="Send"></button></div></div></div>').window;
 const card=document.querySelector('[data-composer-card]'),send=card.querySelector('[aria-label="Send"]'),file=card.querySelector('[aria-label="Attach photos or files"]');let sends=0,files=0;send.onclick=()=>sends++;file.onclick=()=>files++;
 compactComposer(card);compactComposer(card);send.click();file.click();
 assert.equal(card.querySelector('[contenteditable]').textContent,'Keep my draft');assert.equal(card.querySelector('[data-composer-placeholder]').textContent,'Chat…');assert.equal(card.querySelectorAll('[data-hub-composer-send]').length,1);assert.equal(card.querySelector('[data-hub-composer-send]'),send);assert.equal(sends,1);assert.equal(files,1);
});
