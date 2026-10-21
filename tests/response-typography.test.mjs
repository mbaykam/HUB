import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from '../vendor/deepseek-harness/node_modules/jsdom/lib/api.js';
import {installResponseTypography} from '@minke/harness-overlay/client/host/response-typography.ts';
const settle=()=>new Promise(resolve=>setTimeout(resolve,35));

test('readability styles target public assistant Markdown and preserve messages, code, math and native table owners',async()=>{
 const dom=new JSDOM('<main><div data-chat-flow-kind="user"><div class="_markdown_native">User original</div></div><div data-chat-flow-kind="tool-call"><div class="_markdown_native">Tool output</div></div><div data-chat-flow-kind="assistant-step"><div data-turn-process-inline><div class="_markdown_native">Reasoning</div></div><div class="_markdown_native" id="reply"><h2>Bilgi / information</h2><p>Exact source with $20 and a <a href="https://example.com">source</a>.</p><div class="md-code-block"><pre><code>const x =  2;\n  next(x);</code></pre></div><span class="katex">x²</span><div class="md-table-wide" tabindex="0"><table><thead><tr><th>Model</th><th>Context</th></tr></thead><tbody><tr><td>Fixture</td><td>32K</td></tr></tbody></table></div></div></div></main>',{pretendToBeVisual:true});
 const doc=dom.window.document,reply=doc.querySelector('#reply'),original=reply.textContent,table=reply.querySelector('table'),owner=table.parentElement,code=reply.querySelector('code'),math=reply.querySelector('.katex');
 const off=installResponseTypography(doc);
 try{
  assert.equal(doc.querySelectorAll('[data-hub-response-markdown]').length,1);assert.equal(reply.textContent,original);assert.equal(reply.querySelector('code'),code);assert.equal(reply.querySelector('.katex'),math);assert.equal(table.parentElement,owner);assert.equal(owner.getAttribute('aria-label'),'Scrollable table');assert.equal(owner.getAttribute('tabindex'),'0');
  const streamed=doc.createElement('p');streamed.textContent='Yeni bilgi / new information';reply.append(streamed);await settle();assert.equal(streamed.textContent,'Yeni bilgi / new information');assert.equal(reply.querySelectorAll('[data-hub-response-table]').length,1);
  off();assert.equal(doc.querySelector('[data-hub-response-markdown]'),null);assert.equal(owner.hasAttribute('aria-label'),false);assert.equal(owner.hasAttribute('role'),false);assert.equal(owner.getAttribute('tabindex'),'0');assert.equal(table.parentElement,owner);
 }finally{dom.window.close();}
});

test('new streamed Markdown is styled once; disposal removes only owned attributes',async()=>{
 const dom=new JSDOM('<div data-chat-flow-kind="assistant-step"></div>',{pretendToBeVisual:true}),doc=dom.window.document,off=installResponseTypography(doc);
 try{const row=doc.querySelector('div'),reply=doc.createElement('div');reply.className='Native_markdown';reply.innerHTML='<p>Reply</p><div role="group" aria-label="Existing label" tabindex="-1"><table><tr><td>Value</td></tr></table></div>';row.append(reply);await settle();const wrap=reply.querySelector('table').parentElement;assert.equal(reply.hasAttribute('data-hub-response-markdown'),true);assert.equal(wrap.getAttribute('role'),'group');assert.equal(wrap.getAttribute('aria-label'),'Existing label');assert.equal(wrap.getAttribute('tabindex'),'-1');off();assert.equal(wrap.getAttribute('role'),'group');assert.equal(wrap.hasAttribute('data-hub-response-table'),false);}finally{dom.window.close();}
});
