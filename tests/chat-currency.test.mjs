import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {escapeCurrencyMarkdown} from '../scripts/harness/currency-markdown.mjs';
import {stagePatchedHarnessClientModule} from './support/harness-client-module.mjs';
test('live-price prose keeps currency, spacing and Markdown; explicit math and code keep their delimiters',()=>{
 assert.equal(escapeCurrencyMarkdown('Around **$82,700** right now; $80K–$83K support and $80k below.'),'Around **\\$82,700** right now; \\$80K–\\$83K support and \\$80k below.');
 assert.equal(escapeCurrencyMarkdown('It costs $5 and $10 tomorrow.'),'It costs \\$5 and \\$10 tomorrow.');
 for(const text of ['$2+2=4$','$2$','$2x + 3$','$$x=2$$','`$10`','```js\nconst cost="$10"\n```','already \\$20'])assert.equal(escapeCurrencyMarkdown(text),text);
});
test('the applied native chat renderer sends readable currency and unchanged math to Markdown',async()=>{
 const staged=await stagePatchedHarnessClientModule({projectRoot:resolve('.'),fixture:'vendor/deepseek-harness/packages/client/ui-chat/lib/client.js',packageName:'dsh-client-ui-chat',patches:['patches/deepseek-harness/chat-currency-markdown.patch']});
 try{
  const start=staged.source.indexOf('function escapeCurrencyMarkdown('),end=staged.source.indexOf('function ProcessReasoning(',start);
  const jsx=(type,props)=>({type,props}),native=new Function('react','react_jsx_runtime','_deepseek_ai_dsh_client_ui_primitives','markdownLabels','AssistantMarkdown_module_css_default',staged.source.slice(start,end)+';return AssistantMarkdown;')({memo:fn=>fn,useMemo:fn=>fn()},{jsx,jsxs:jsx},{MarkdownText:'MarkdownText'},()=>({}),{});
  for(const text of ['Around **$82,700** right now; $80K–$83K support.','$2+2=4$','`$10`']){
   const rendered=native({blocks:[{kind:'text',text}],streaming:false,t:s=>s}),markdown=rendered.props.children.props.children[0][0];
   assert.equal(markdown.type,'MarkdownText');assert.equal(markdown.props.text,escapeCurrencyMarkdown(text));
  }
 }finally{await staged.dispose();}
});
