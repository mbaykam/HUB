import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {JSDOM} from '../vendor/deepseek-harness/node_modules/jsdom/lib/api.js';
import {installInstructionEditor} from '../packages/harness-overlay/src/client/preferences/InstructionSettings.tsx';

const settle = async () => {await setImmediate(); await setImmediate();};
function fixture({curatorAvailable = true} = {}) {
  const dom = new JSDOM('<main/>', {url: 'https://hub.test/'}), root = dom.window.document, calls = [];
  const source = (id, content = '') => ({id, name: id, path: 'private/' + id, content, hash: id + '-hash', editable: true});
  const characters = ['HUB', 'Mira'].map(name => ({id: name.toLowerCase(), name, role: name === 'HUB' ? 'Main' : 'Voice', route: {provider: 'openai-codex', model: 'gpt-6-luna'}, instructions: source('character:' + name.toLowerCase(), name + ' original instructions')}));
  const data = {shared: [source('SOUL.md'), source('USER.md'), {...source('native-agents', 'Workspace rules'), editable: false}], characters};
  const curator = {provider: 'openai-codex', model: 'gpt-6-luna', reasoningEffort: 'minimal', path: 'settings.json', instructions: 'Curator rules', hash: 'curator-hash', builtIn: '<script>this is literal text</script>'};
  dom.window.fetch = async (url, options) => {
    calls.push({url, options});
    const command = options.body && JSON.parse(options.body);
    if (url.includes('view=instructions') && !curatorAvailable) return {ok: false, status: 503, json: async () => ({})};
    if (command) {
      const target = command.action === 'instructions' ? curator : [...data.shared, ...characters.map(c => c.instructions)].find(s => s.id === command.id);
      if (command.hash !== target.hash) return {ok: false, status: 409, json: async () => ({detail: 'Instructions changed; reload before saving'})};
      if (command.action === 'instructions') target.instructions = command.instructions;
      else target.content = command.content;
      target.hash += '-saved';
    }
    return {ok: true, status: 200, json: async () => structuredClone(url.includes('view=instructions') ? curator : url.includes('/api/hub/memory') ? {} : data)};
  };
  const dispose = installInstructionEditor(root.querySelector('main'), root, () => undefined);
  const select = section => root.querySelector('[data-instruction-section="' + section + '"]').click();
  const edit = value => {root.querySelector('textarea').value = value; root.querySelector('textarea').dispatchEvent(new dom.window.Event('input'));};
  const pick = id => {root.querySelector('select').value = id; root.querySelector('select').dispatchEvent(new dom.window.Event('change'));};
  const click = name => [...root.querySelectorAll('button')].find(b => b.textContent === name).click();
  const posts = () => calls.filter(c => c.options.method === 'POST');
  return {dom, root, data, curator, calls, select, edit, pick, click, posts, close() {dispose(); dom.window.close();}};
}

test('optional empty fields explain their audience and examples without activating them', async () => {
  const f = fixture();
  try {
    await settle();
    const editor = f.root.querySelector('textarea');
    assert.equal(editor.value, '');
    assert.match(editor.placeholder, /Örnek:/);
    assert.equal(f.root.querySelector('label[for="' + editor.id + '"]').textContent, 'Asistanlar nasıl davranmalı?');
    assert.match(f.root.querySelector('#' + editor.getAttribute('aria-describedby')).textContent, /İsteğe bağlı/);
    assert.equal(f.root.querySelector('.instruction-advanced').open, false);
    assert.equal(f.root.querySelector('.instruction-character-picker').hidden, true);
    assert.equal(f.root.querySelector('[data-instruction-save]').disabled, true);
    f.select('user');
    assert.equal(editor.value, '');
    assert.match(editor.placeholder, /Türkçe ve İngilizce/);
    assert.match(f.root.querySelector('.instruction-description').textContent, /Knowledge/);
    assert.deepEqual(f.posts(), []);
    assert.equal(f.data.shared[0].content, '');
    assert.equal(f.root.querySelector('script'), null);
    assert.match(f.root.querySelector('.instruction-advanced').textContent, /<script>/);
  } finally {f.close();}
});

test('shared, character and Knowledge edits save only to their own store', async () => {
  const f = fixture();
  try {
    await settle();
    for (const [section, id, text, expectedHash] of [
      ['shared', 'SOUL.md', 'Shared rules', 'SOUL.md-hash'],
      ['user', 'USER.md', 'Bilingual user', 'USER.md-hash'],
      ['characters', 'character:mira', 'New Mira instructions', 'character:mira-hash'],
      ['curator', 'curator', 'New curator rules', 'curator-hash'],
    ]) {
      f.select(section);
      if (section === 'characters') {
        f.pick(id);
        assert.equal(f.root.querySelector('.instruction-character-picker').hidden, false);
        assert.equal(f.root.querySelector('label[for="' + f.root.querySelector('textarea').id + '"]').textContent, 'Mira nasıl davranmalı?');
      }
      f.edit(text);
      f.click('Kaydet');
      await settle();
      const saved = f.posts().at(-1);
      assert.deepEqual(JSON.parse(saved.options.body), id === 'curator' ? {action: 'instructions', hash: expectedHash, instructions: text} : {id, hash: expectedHash, content: text});
      assert.equal(saved.url, id === 'curator' ? '/api/hub/memory' : '/api/hub/instructions');
      assert.equal(saved.options.headers[id === 'curator' ? 'x-hub-memory' : 'x-hub-instructions'], '1');
      assert.equal(f.root.querySelector('[data-instruction-save]').disabled, true);
      assert.match(f.root.querySelector('[role="status"]').textContent, /kaydedildi/);
    }
    assert.equal(f.posts().length, 4);
    assert.equal(f.data.characters[0].instructions.content, 'HUB original instructions');
    assert.equal(f.data.shared[2].content, 'Workspace rules');
  } finally {f.close();}
});

test('drafts survive section, character and refresh changes; stale saves preserve the edit', async () => {
  const f = fixture();
  try {
    await settle();
    f.edit('Shared draft');
    f.select('characters');
    f.pick('character:mira');
    f.edit('Mira draft');
    f.pick('character:hub');
    assert.equal(f.root.querySelector('textarea').value, 'HUB original instructions');
    f.pick('character:mira');
    assert.equal(f.root.querySelector('textarea').value, 'Mira draft');
    f.select('shared');
    assert.equal(f.root.querySelector('textarea').value, 'Shared draft');
    f.data.shared[0].content = 'External edit';
    f.data.shared[0].hash = 'external-hash';
    f.click('Yenile');
    await settle();
    assert.equal(f.root.querySelector('textarea').value, 'Shared draft');
    f.click('Kaydet');
    await settle();
    assert.equal(JSON.parse(f.posts().at(-1).options.body).hash, 'SOUL.md-hash');
    assert.equal(f.data.shared[0].content, 'External edit');
    assert.equal(f.root.querySelector('textarea').value, 'Shared draft');
    assert.match(f.root.querySelector('[role="status"]').textContent, /başka bir yerde değişmiş/);
    f.click('Değişikliği geri al');
    assert.equal(f.root.querySelector('textarea').value, 'External edit');
    f.select('characters');
    f.pick('character:mira');
    assert.equal(f.root.querySelector('textarea').value, 'Mira draft');
    f.click('Kaydet');
    await settle();
    assert.equal(f.data.characters[1].instructions.content, 'Mira draft');
  } finally {f.close();}
});

test('an unavailable curator does not block shared instructions or silently replace its rules', async () => {
  const f = fixture({curatorAvailable: false});
  try {
    await settle();
    assert.equal(f.root.querySelector('[data-instruction-section="curator"]').disabled, true);
    assert.equal(f.root.querySelector('textarea').disabled, false);
    assert.match(f.root.querySelector('[role="status"]').textContent, /şu anda yüklenemedi/);
    f.edit('Shared edit');
    f.click('Kaydet');
    await settle();
    assert.equal(f.data.shared[0].content, 'Shared edit');
    assert.equal(f.curator.instructions, 'Curator rules');
    assert.equal(f.posts().length, 1);
  } finally {f.close();}
});
