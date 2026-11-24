import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { assignBuild, main } from './testflight-assign.mjs';

// Synthetic fixtures only; no Apple requests or real credentials.
const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const env = {
  BUILD_NUMBER: '33', IOS_ASC_APP_ID: '123456', IOS_ASC_KEY_ID: 'FIXTUREKEY',
  IOS_ASC_ISSUER_ID: 'fixture-issuer', IOS_ASC_PRIVATE_KEY_P8_BASE64: Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64'),
  EXISTING_GROUP_ID: 'group-1', CONFIRMATION: 'ADD_EXISTING_BUILD_TO_EXISTING_GROUP',
};
const now = new Date('2026-11-24T08:00:00Z');
function build() {
  return { data: [{ type: 'builds', id: 'build-33', attributes: {
    version: '33', processingState: 'VALID', expired: false, uploadedDate: '2026-11-24T07:00:00Z',
  }, relationships: { app: { data: { type: 'apps', id: env.IOS_ASC_APP_ID } },
    preReleaseVersion: { data: { type: 'preReleaseVersions', id: 'release-1' } },
    betaGroups: { data: [] },
  } }], included: [{ type: 'preReleaseVersions', id: 'release-1', attributes: { platform: 'IOS' } }] };
}
function group() {
  return { data: { type: 'betaGroups', id: 'group-1', attributes: {
    name: 'PRIVATE_NAME PRIVATE_EMAIL@example.com', isInternalGroup: true, publicLinkEnabled: null,
  }, relationships: { app: { data: { type: 'apps', id: env.IOS_ASC_APP_ID } } } } };
}
const links = (assigned = false) => ({ data: assigned ? [{ type: 'builds', id: 'build-33' }] : [] });
function fakeFetch(responses) {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, options });
    assert.equal(url.origin, 'https://api.appstoreconnect.apple.com');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal);
    const response = responses.shift();
    assert.notEqual(response, undefined, 'Unexpected request');
    if (response instanceof Error) throw response;
    if (response.status) return { status: response.status, ok: response.status < 300,
      async json() { throw new Error('PRIVATE_BODY'); } };
    return { status: 200, ok: true, async json() { return response; } };
  };
  return { fetch, calls };
}

test('exact one correct POST with existing build id, then independent GET readback', async () => {
  const { fetch, calls } = fakeFetch([build(), group(), links(), { status: 204 }, links(true)]);
  const report = await assignBuild(env, fetch, now);
  assert.equal(report.assignmentConfirmed, true);
  assert.equal(report.postPerformed, true);
  assert.equal(report.alreadyAssigned, false);
  assert.deepEqual(calls.map(c => c.options.method), ['GET', 'GET', 'GET', 'POST', 'GET']);
  assert.equal(calls[0].url.searchParams.get('filter[app]'), env.IOS_ASC_APP_ID);
  assert.equal(calls[0].url.searchParams.get('filter[version]'), '33');
  assert.equal(calls[0].url.searchParams.get('filter[preReleaseVersion.platform]'), 'IOS');
  assert.equal(calls[1].url.pathname, '/v1/betaGroups/group-1');
  assert.equal(calls[1].url.searchParams.get('include'), 'app');
  assert.equal(calls[3].url.pathname, '/v1/betaGroups/group-1/relationships/builds');
  assert.deepEqual(JSON.parse(calls[3].options.body), { data: [{ type: 'builds', id: 'build-33' }] });
  assert.equal(calls[4].url.pathname, calls[3].url.pathname);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE|Bearer|fixture-issuer|FIXTUREKEY/);
});

test('existing assignment skips POST and verifies assignment again', async () => {
  const g = group(); g.data.attributes.publicLinkEnabled = false;
  const { fetch, calls } = fakeFetch([build(), g, links(true), links(true)]);
  const report = await assignBuild(env, fetch, now);
  assert.equal(report.alreadyAssigned, true);
  assert.equal(report.postPerformed, false);
  assert.equal(report.assignmentConfirmed, true);
  assert.ok(calls.every(c => c.options.method === 'GET'));
});

test('invalid confirmation/group input fails before network access', async () => {
  for (const override of [{ CONFIRMATION: '' }, { CONFIRMATION: 'yes' }, { EXISTING_GROUP_ID: '../bad' }, { EXISTING_GROUP_ID: 'group\n1' }]) {
    const { fetch, calls } = fakeFetch([]);
    await assert.rejects(assignBuild({ ...env, ...override }, fetch, now));
    assert.equal(calls.length, 0);
  }
});

test('mismatched app, version, platform, ambiguous, invalid or expired build prevents write', async () => {
  for (const mutate of [
    b => { b.data[0].relationships.app.data.id = '999'; },
    b => { b.data[0].attributes.version = '34'; },
    b => { b.included[0].attributes.platform = 'MAC_OS'; },
    b => { b.data[0].attributes.processingState = 'PROCESSING'; },
    b => { b.data[0].attributes.expired = true; },
    b => { b.data.push(b.data[0]); },
    b => { b.links = { next: 'https://private.invalid' }; },
  ]) {
    const b = build(); mutate(b);
    const { fetch, calls } = fakeFetch([b]);
    await assert.rejects(assignBuild(env, fetch, now));
    assert.ok(calls.every(c => c.options.method === 'GET'));
  }
});

test('wrong app/group, public/external and missing privacy state prevent write', async () => {
  for (const mutate of [
    g => { g.data.relationships.app.data.id = '999'; },
    g => { g.data.id = 'other-group'; },
    g => { g.data.attributes.isInternalGroup = false; },
    g => { g.data.attributes.publicLinkEnabled = true; },
    g => { delete g.data.attributes.publicLinkEnabled; },
    g => { delete g.data.attributes.isInternalGroup; },
    g => { delete g.data.relationships; },
  ]) {
    const g = group(); mutate(g);
    const { fetch, calls } = fakeFetch([build(), g]);
    await assert.rejects(assignBuild(env, fetch, now));
    assert.equal(calls.length, 2);
    assert.ok(calls.every(c => c.options.method === 'GET'));
  }
});

test('truncated relationship read cannot silently conclude absent or mutate', async () => {
  const { fetch, calls } = fakeFetch([build(), group(), { data: [], links: { next: 'https://private.invalid' } }]);
  await assert.rejects(assignBuild(env, fetch, now), /bounded/);
  assert.ok(calls.every(c => c.options.method === 'GET'));
});

test('uncertain POST, unexpected HTTP, role error and readback failures never retry mutation', async () => {
  for (const [response, readback] of [
    [new Error('PRIVATE_NETWORK'), []], [{ status: 500 }, []], [{ status: 403 }, []],
    [{ status: 401 }, []], [{ status: 429 }, []], [{ status: 200 }, []],
    [{ status: 204 }, [links()]], [{ status: 204 }, [new Error('PRIVATE_READBACK')]],
  ]) {
    const { fetch, calls } = fakeFetch([build(), group(), links(), response, ...readback]);
    const errors = [];
    assert.equal(await main(env, fetch, assert.fail, message => errors.push(message)), 1);
    assert.equal(calls.filter(c => c.options.method === 'POST').length, 1);
    assert.match(errors.join(), /no .*retry|no retry/i);
    assert.doesNotMatch(errors.join(), /PRIVATE|Bearer|BEGIN|fixture-issuer|FIXTUREKEY/);
    if (response.status === 403) assert.match(errors.join(), /insufficient API role/);
  }
});

test('GET HTTP, malformed JSON, key errors sanitized without mutation', async () => {
  for (const response of [{ status: 403 }, new Error('PRIVATE_NETWORK'), { data: {} }]) {
    const { fetch, calls } = fakeFetch([response]);
    const errors = [];
    assert.equal(await main(env, fetch, assert.fail, message => errors.push(message)), 1);
    assert.ok(calls.every(c => c.options.method === 'GET'));
    assert.doesNotMatch(errors.join(), /PRIVATE|Bearer|BEGIN/);
  }
  const { fetch, calls } = fakeFetch([]);
  const errors = [];
  assert.equal(await main({ ...env, IOS_ASC_PRIVATE_KEY_P8_BASE64: 'PRIVATE_BAD_KEY' }, fetch, assert.fail, text => errors.push(text)), 1);
  assert.equal(calls.length, 0);
  assert.doesNotMatch(errors.join(), /PRIVATE_BAD_KEY/);
});

test('malformed JSON and unexpected implementation errors never expose private details', async () => {
  for (const fetch of [
    async () => ({ ok: true, async json() { throw new Error('PRIVATE_JSON'); } }),
    async () => ({ get ok() { throw new Error('PRIVATE_UNEXPECTED'); } }),
  ]) {
    const errors = [];
    assert.equal(await main(env, fetch, assert.fail, text => errors.push(text)), 1);
    assert.doesNotMatch(errors.join(), /PRIVATE_JSON|PRIVATE_UNEXPECTED|Bearer/);
  }
});

test('workflow protected manual main-only, exact confirmation, no artifacts or secret interpolation in shell', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/ios-testflight-assign.yml', import.meta.url), 'utf8');
  assert.match(workflow, /environment: ios-signing/);
  assert.match(workflow, /github\.repository == 'mbaykam\/HUB'.*github\.ref == 'refs\/heads\/main'.*github\.event_name == 'workflow_dispatch'.*inputs\.confirmation == 'ADD_EXISTING_BUILD_TO_EXISTING_GROUP'/);
  assert.match(workflow, /permissions:\n  contents: read\n/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /run: node --test mobile\/scripts\/testflight-status.test.mjs mobile\/scripts\/testflight-assign.test.mjs/);
  assert.doesNotMatch(workflow, /pull_request:|push:|upload-artifact|pnpm install|GITHUB_TOKEN:|contents: write|run:.*\$\{\{/);
});
