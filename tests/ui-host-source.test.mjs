import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {canonicalHostSource} from '../scripts/harness/ui-host-source.mjs';
const digest=bytes=>createHash('sha256').update(canonicalHostSource(bytes)).digest('hex');
test('host compatibility survives Windows checkout but changes for actual source or escaped text',()=>{
 const unix=Buffer.from('first\nTürkçe\n'),windows=Buffer.from('first\r\nTürkçe\r\n');
 assert.equal(digest(unix),digest(windows));assert.notEqual(digest(unix),digest(Buffer.from('second\nTürkçe\n')));
 assert.notEqual(digest(Buffer.from('"\\r\\n"')),digest(Buffer.from('"\\n"')));
 assert.throws(()=>canonicalHostSource(Buffer.from([255])),/encoded data/);
});
