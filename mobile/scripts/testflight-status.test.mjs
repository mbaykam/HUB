import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { checkStatus, createToken, main, validateConfig } from './testflight-status.mjs';

// Synthetic keys and fixtures only: tests never contact Apple or read real credentials.
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const env = {
  BUILD_NUMBER: '33', IOS_ASC_APP_ID: '123456', IOS_ASC_KEY_ID: 'FIXTUREKEY',
  IOS_ASC_ISSUER_ID: 'fixture-issuer', IOS_ASC_PRIVATE_KEY_P8_BASE64: Buffer.from(pem).toString('base64'),
};
const now = new Date('2026-11-24T08:00:00Z');
function fixture() {
  return {
    data: [{ type: 'builds', id: 'build-33', attributes: {
      version: '33', processingState: 'VALID', expired: false, uploadedDate: '2026-11-24T07:00:00Z',
    }, relationships: {
      app: { data: { type: 'apps', id: env.IOS_ASC_APP_ID } },
      preReleaseVersion: { data: { type: 'preReleaseVersions', id: 'release-1' } },
      betaGroups: { data: [{ type: 'betaGroups', id: 'group-1' }], meta: { paging: { total: 1 } } },
    } }],
    included: [
      { type: 'preReleaseVersions', id: 'release-1', attributes: { platform: 'IOS' } },
      { type: 'betaGroups', id: 'group-1', attributes: { name: 'HUB Internal', isInternalGroup: true } },
    ],
  };
}
const detail = (internal = 'IN_BETA_TESTING', external = 'READY_FOR_BETA_SUBMISSION') => ({
  data: { type: 'buildBetaDetails', attributes: { internalBuildState: internal, externalBuildState: external } },
});
const testers = { data: [{ type: 'betaTesters', id: 'private-tester-id', attributes: {
  firstName: 'PRIVATE_NAME', email: 'PRIVATE_EMAIL@example.com',
} }], meta: { paging: { total: 4 } } };
function fakeFetch(responses = [fixture(), detail(), testers]) {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, options });
    assert.equal(url.origin, 'https://api.appstoreconnect.apple.com');
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal);
    const item = responses.length === 0 && url.pathname === `/v1/apps/${env.IOS_ASC_APP_ID}/betaGroups`
      ? { data: [] } : responses.shift();
    assert.notEqual(item, undefined, 'Unexpected API request');
    if (item instanceof Error) throw item;
    return item?.status ? { ok: false, status: item.status, json() { throw new Error('PRIVATE_BODY'); } } :
      { ok: true, async json() { return item; } };
  };
  return { fetch, calls };
}

test('JWT is ES256 P1363 with five-minute expiry and verifies using synthetic key', () => {
  const token = createToken(env, 1000);
  const [header, payload, signature] = token.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'ES256', kid: 'FIXTUREKEY', typ: 'JWT' });
  assert.deepEqual(JSON.parse(Buffer.from(payload, 'base64url')), {
    iss: 'fixture-issuer', iat: 1000, exp: 1300, aud: 'appstoreconnect-v1',
  });
  assert.equal(Buffer.from(signature, 'base64url').length, 64);
  assert.ok(verify('sha256', Buffer.from(`${header}.${payload}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')));
});

test('strict build input range, missing config and invalid keys fail safely', async () => {
  for (const value of ['', '0', '10000', '033', '-1', '3.3', '33\n', '33;echo bad']) {
    assert.throws(() => validateConfig({ ...env, BUILD_NUMBER: value }), /1 to 9999/);
  }
  for (const value of ['1', '9999']) assert.equal(validateConfig({ ...env, BUILD_NUMBER: value }).buildNumber, value);
  assert.throws(() => validateConfig({ ...env, IOS_ASC_APP_ID: '123&other' }), /APP_ID/);
  assert.throws(() => validateConfig({ ...env, IOS_ASC_KEY_ID: '' }), /Missing/);
  assert.throws(() => createToken({ ...env, IOS_ASC_PRIVATE_KEY_P8_BASE64: 'PRIVATE_BAD_KEY' }), /Unable to create/);
  const { fetch, calls } = fakeFetch([]);
  assert.equal(await main({ ...env, BUILD_NUMBER: '0' }, fetch, () => {}, () => {}), 1);
  assert.equal(calls.length, 0);
});

test('scopes to app, build and iOS; GET-only metadata; no testers or secrets in report', async () => {
  const { fetch, calls } = fakeFetch();
  const report = await checkStatus(env, fetch, now);
  const query = calls[0].url.searchParams;
  assert.equal(query.get('filter[app]'), env.IOS_ASC_APP_ID);
  assert.equal(query.get('filter[version]'), '33');
  assert.equal(query.get('filter[preReleaseVersion.platform]'), 'IOS');
  assert.equal(query.get('limit'), '2');
  assert.equal(query.get('limit[betaGroups]'), '50');
  assert.equal(calls[1].url.pathname, '/v1/builds/build-33/buildBetaDetail');
  assert.equal(calls[2].url.pathname, '/v1/betaGroups/group-1/relationships/betaTesters');
  assert.equal(calls[2].url.searchParams.get('limit'), '1');
  assert.equal(report.betaGroups[0].testerCount, 4);
  assert.equal(report.betaGroupCount, 1);
  assert.equal(report.processedValid, true);
  assert.equal(report.internalReadyAndGroupAssigned, true);
  assert.equal(report.externalReadyAndGroupAssigned, false);
  const output = JSON.stringify(report);
  for (const secret of [pem, env.IOS_ASC_PRIVATE_KEY_P8_BASE64, env.IOS_ASC_KEY_ID, env.IOS_ASC_ISSUER_ID,
    'PRIVATE_NAME', 'PRIVATE_EMAIL', 'private-tester-id', calls[0].options.headers.Authorization]) {
    assert.ok(!output.includes(secret));
  }
});

test('VALID alone is not ready; approval, readiness, expiry and assignment are separate', async () => {
  for (const [processing, expired, internal, external, assigned, expected] of [
    ['VALID', false, 'PROCESSING', 'BETA_APPROVED', true, [true, false, true]],
    ['VALID', false, 'READY_FOR_BETA_TESTING', 'IN_BETA_TESTING', false, [true, false, false]],
    ['VALID', true, 'IN_BETA_TESTING', 'BETA_APPROVED', true, [true, false, false]],
    ['PROCESSING', false, 'IN_BETA_TESTING', 'IN_BETA_TESTING', true, [false, false, false]],
  ]) {
    const builds = fixture();
    builds.data[0].attributes.processingState = processing;
    builds.data[0].attributes.expired = expired;
    builds.included[1].attributes.isInternalGroup = false;
    if (!assigned) builds.data[0].relationships.betaGroups.data = [];
    const report = await checkStatus(env, fakeFetch([builds, detail(internal, external), ...(assigned ? [testers] : [])]).fetch, now);
    assert.deepEqual([report.processedValid, report.internalReadyAndGroupAssigned, report.externalApprovedAndGroupAssigned], expected);
  }
});

test('mandatory HTTP failures never print Apple private error bodies', async () => {
  for (const [status, reason] of [[401, /authentication rejected/], [403, /insufficient API role/], [404, /resource unavailable/], [429, /rate limited/], [500, /request failed/]]) {
    const errors = [];
    const code = await main(env, fakeFetch([{ status }]).fetch, () => assert.fail('Unexpected output'), text => errors.push(text));
    assert.equal(code, 1);
    assert.match(errors.join(), reason);
    assert.doesNotMatch(errors.join(), /PRIVATE|Bearer|BEGIN/);
  }
});

test('optional 403/404 preserves processing while exposing unknown details and counts', async () => {
  const report = await checkStatus(env, fakeFetch([fixture(), { status: 403 }, { status: 404 }]).fetch, now);
  assert.equal(report.processedValid, true);
  assert.equal(report.internalBuildState, 'UNKNOWN');
  assert.equal(report.internalReadyOrTesting, false);
  assert.equal(report.betaGroups[0].testerCount, null);
  assert.equal(report.limitations.length, 2);
  assert.match(report.limitations[0], /insufficient API role/);
});

test('missing, ambiguous, mismatched app/platform and malformed builds fail closed', async () => {
  const invalid = [null, {}, { data: [] }, { data: [{}, {}] }];
  for (const mutate of [
    b => { b.data[0].relationships.app.data.id = '999'; },
    b => { b.included[0].attributes.platform = 'MAC_OS'; },
    b => { b.data[0].attributes.expired = 'false'; },
    b => { b.data[0].attributes.uploadedDate = 'bad'; },
    b => { b.data[0].id = '../escape'; },
    b => { b.data[0].attributes.version = '34'; },
  ]) { const b = fixture(); mutate(b); invalid.push(b); }
  for (const item of invalid) await assert.rejects(checkStatus(env, fakeFetch([item]).fetch, now));
});

test('malformed optional data and network/JSON errors produce safe limitations/errors', async () => {
  const report = await checkStatus(env, fakeFetch([fixture(), { data: {} }, { data: [], meta: {} }]).fetch, now);
  assert.equal(report.limitations.length, 2);
  assert.equal(report.betaGroups[0].testerCount, null);
  await assert.rejects(checkStatus(env, async () => { throw new Error('PRIVATE_URL_AND_KEY'); }, now), /network request failed/);
  await assert.rejects(checkStatus(env, async () => ({ ok: true, json() { throw new Error('PRIVATE_JSON'); } }), now), /Malformed Apple/);
});

test('output is inert JSON, redacts email-like group names and marks bounded group counts', async () => {
  const b = fixture();
  b.included[1].attributes.name = '\n::warning::PRIVATE_EMAIL@example.com\nHUB Internal';
  b.data[0].relationships.betaGroups.meta.paging.total = 51;
  const lines = [];
  assert.equal(await main(env, fakeFetch([b, detail(), testers]).fetch, text => lines.push(text), assert.fail), 0);
  const report = JSON.parse(lines[0]);
  assert.equal(report.betaGroupCountIsExact, false);
  assert.doesNotMatch(lines[0], /PRIVATE_EMAIL/);
  assert.ok(lines[0].split('\n').every(line => !line.startsWith('::')));
});

test('existing app group discovery is distinct, bounded, GET-only and excludes tester identities', async () => {
  const b = fixture();
  b.data[0].relationships.betaGroups.data = [];
  const inventory = { data: [{ type: 'betaGroups', id: 'existing-private', attributes: {
    name: 'Private\nPRIVATE_EMAIL@example.com', isInternalGroup: true, publicLinkEnabled: null,
  } }], links: { next: 'https://untrusted.invalid/next' }, meta: { paging: { total: 51 } } };
  const { fetch, calls } = fakeFetch([b, detail(), inventory, testers]);
  const report = await checkStatus(env, fetch, now);
  assert.deepEqual(report.betaGroups, []);
  assert.equal(report.betaGroupCount, 0);
  assert.equal(report.existingAppGroupCount, 1);
  assert.equal(report.existingAppGroupCountIsExact, false);
  assert.deepEqual(report.existingAppGroups, [{ id: 'existing-private', name: 'Private [redacted]',
    isInternalGroup: true, publicLinkEnabled: null, testerCount: 4 }]);
  assert.equal(calls[2].url.pathname, '/v1/apps/123456/betaGroups');
  assert.equal(calls[2].url.searchParams.get('limit'), '50');
  assert.equal(calls.length, 4);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_EMAIL|PRIVATE_NAME|private-tester-id/);
});

test('discovery permission failure preserves build status but reports unknown inventory', async () => {
  const report = await checkStatus(env, fakeFetch([fixture(), detail(), testers, { status: 403 }]).fetch, now);
  assert.equal(report.processedValid, true);
  assert.equal(report.existingAppGroups, null);
  assert.equal(report.existingAppGroupCount, null);
  assert.match(report.limitations.join(), /Existing app groups:.*insufficient API role/);
});

test('workflow is protected, manual main-only, minimum permission and no deployment actions', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/ios-testflight-status.yml', import.meta.url), 'utf8');
  assert.match(workflow, /environment: ios-signing/);
  assert.match(workflow, /github\.repository == 'mbaykam\/HUB'.*github\.ref == 'refs\/heads\/main'.*github\.event_name == 'workflow_dispatch'/);
  assert.match(workflow, /permissions:\n  contents: read\n/);
  assert.doesNotMatch(workflow, /pull_request:|push:|upload-artifact|signing_runner|pnpm install|GITHUB_TOKEN:|write/);
  assert.match(workflow, /default: '33'/);
});
