import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {escapeCurrencyMarkdown} from '../scripts/harness/currency-markdown.mjs';
test('live-price prose keeps currency, spacing and Markdown; explicit math and code keep their delimiters',()=>{
 assert.equal(escapeCurrencyMarkdown('Around **$82,700** right now; $80K–$83K support and $80k below.'),'Around **\\$82,700** right now; \\$80K–\\$83K support and \\$80k below.');
 assert.equal(escapeCurrencyMarkdown('It costs $5 and $10 tomorrow.'),'It costs \\$5 and \\$10 tomorrow.');
 for(const text of ['$2+2=4$','$2$','$2x + 3$','$$x=2$$','`$10`','```js\nconst cost="$10"\n```','already \\$20'])assert.equal(escapeCurrencyMarkdown(text),text);
});
test('the deployed native chat patch embeds the exact tested function',async()=>{
 const patch=await readFile(new URL('../patches/deepseek-harness/chat-currency-markdown.patch',import.meta.url),'utf8');
 const added=patch.split('\n').filter(s=>s.startsWith('+')&&!s.startsWith('+++')).map(s=>s.slice(1)).join('\n');assert.ok(added.includes(escapeCurrencyMarkdown.toString()));assert.match(added,/text: escapeCurrencyMarkdown\(block.text\)/);
});
