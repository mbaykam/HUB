import { createPrivateKey, sign } from 'node:crypto';
import { pathToFileURL } from 'node:url';

// Apple API reference: https://developer.apple.com/documentation/appstoreconnectapi/get-v1-builds
// Related beta detail and beta tester relationship endpoints are GET-only too.
export class StatusError extends Error {}
const malformed = () => new StatusError('Malformed Apple response; status cannot be confirmed.');
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const resourceId = value => typeof value === 'string' && /^[A-Za-z0-9-]{1,100}$/.test(value);
const state = value => value == null ? 'UNKNOWN' :
  typeof value === 'string' && /^[A-Z_]{1,80}$/.test(value) ? value : (() => { throw malformed(); })();

export function validateConfig(env) {
  if (!/^[1-9]\d{0,3}$/.test(env.BUILD_NUMBER ?? '')) {
    throw new StatusError('BUILD_NUMBER must be an integer from 1 to 9999.');
  }
  if (!/^\d{1,30}$/.test(env.IOS_ASC_APP_ID ?? '')) throw new StatusError('IOS_ASC_APP_ID is missing or invalid.');
  for (const name of ['IOS_ASC_KEY_ID', 'IOS_ASC_ISSUER_ID', 'IOS_ASC_PRIVATE_KEY_P8_BASE64']) {
    if (typeof env[name] !== 'string' || !env[name]) throw new StatusError(`Missing ${name}.`);
  }
  return { buildNumber: env.BUILD_NUMBER, appId: env.IOS_ASC_APP_ID };
}

export function createToken(env, now = Math.floor(Date.now() / 1000)) {
  try {
    const key = createPrivateKey(Buffer.from(env.IOS_ASC_PRIVATE_KEY_P8_BASE64, 'base64'));
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error();
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const input = `${encode({ alg: 'ES256', kid: env.IOS_ASC_KEY_ID, typ: 'JWT' })}.${encode({
      iss: env.IOS_ASC_ISSUER_ID, iat: now, exp: now + 300, aud: 'appstoreconnect-v1',
    })}`;
    return `${input}.${sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
  } catch {
    throw new StatusError('Unable to create Apple API authentication token; check existing signing key configuration.');
  }
}

function httpError(status) {
  const reasons = {
    401: 'authentication rejected (401); existing key may be invalid or expired',
    403: 'insufficient API role or app access (403); no permissions were changed',
    404: 'resource unavailable (404)',
    429: 'rate limited (429); retry later',
  };
  return new StatusError(`Apple API: ${reasons[status] ?? 'request failed; status cannot be confirmed'}.`);
}

export function createReadClient(env, fetchImpl = fetch, now = new Date()) {
  const token = createToken(env, Math.floor(now.getTime() / 1000));
  return async function get(path, params = {}) {
    // Construct every URL locally; never follow API links or HTTP redirects with the bearer token.
    const url = new URL(`https://api.appstoreconnect.apple.com${path}`);
    url.search = new URLSearchParams(params).toString();
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      });
    } catch { throw new StatusError('Apple API network request failed; status cannot be confirmed.'); }
    if (!response.ok) throw httpError(response.status);
    let body;
    try { body = await response.json(); } catch { throw malformed(); }
    if (!isObject(body)) throw malformed();
    return body;
  };
}

export async function readExactBuild(get, { buildNumber, appId }) {
  const result = await get('/v1/builds', {
    'filter[app]': appId, 'filter[version]': buildNumber, 'filter[preReleaseVersion.platform]': 'IOS',
    limit: '2', include: 'app,preReleaseVersion,betaGroups', 'limit[betaGroups]': '50',
    'fields[builds]': 'version,processingState,expired,uploadedDate,app,preReleaseVersion,betaGroups',
    'fields[apps]': 'bundleId', 'fields[preReleaseVersions]': 'platform',
    'fields[betaGroups]': 'name,isInternalGroup,publicLinkEnabled',
  });
  if (!Array.isArray(result.data)) throw malformed();
  if (result.data.length === 0) throw new StatusError('No matching iOS build found for the configured app and build number.');
  if (result.data.length !== 1 || result.links?.next) {
    throw new StatusError('Multiple matching builds; build number is ambiguous across release versions.');
  }
  const build = result.data[0];
  const attrs = build.attributes;
  const prerelease = build.relationships?.preReleaseVersion?.data;
  if (!resourceId(build.id) || build.type !== 'builds' || !isObject(attrs) || attrs.version !== buildNumber ||
      build.relationships?.app?.data?.id !== appId || build.relationships?.app?.data?.type !== 'apps' ||
      prerelease?.type !== 'preReleaseVersions' || !resourceId(prerelease?.id) || !Array.isArray(result.included) ||
      !result.included.some(item => item.type === 'preReleaseVersions' && item.id === prerelease?.id && item.attributes?.platform === 'IOS') ||
      typeof attrs.expired !== 'boolean' || typeof attrs.uploadedDate !== 'string' || !Number.isFinite(Date.parse(attrs.uploadedDate))) {
    throw malformed();
  }
  return { result, build };
}

export async function checkStatus(env, fetchImpl = fetch, now = new Date()) {
  const config = validateConfig(env);
  const get = createReadClient(env, fetchImpl, now);
  const { result, build } = await readExactBuild(get, config);
  const attrs = build.attributes;
  const report = {
    checkedAt: now.toISOString(), version: attrs.version, platform: 'IOS',
    processingState: state(attrs.processingState), expired: attrs.expired, uploadedDate: new Date(attrs.uploadedDate).toISOString(),
    internalBuildState: 'UNKNOWN', externalBuildState: 'UNKNOWN', betaGroups: [], limitations: [],
  };
  // A missing optional permission must not conceal the processing result already obtained.
  async function optional(label, read) {
    try { return await read(); } catch (error) {
      if (!(error instanceof StatusError)) throw error;
      report.limitations.push(`${label}: ${error.message}`);
      return null;
    }
  }
  await optional('Beta details', async () => {
    const detail = await get(`/v1/builds/${build.id}/buildBetaDetail`, {
      'fields[buildBetaDetails]': 'internalBuildState,externalBuildState',
    });
    if (detail.data?.type !== 'buildBetaDetails' || !isObject(detail.data.attributes)) throw malformed();
    const internal = state(detail.data.attributes.internalBuildState);
    const external = state(detail.data.attributes.externalBuildState);
    report.internalBuildState = internal;
    report.externalBuildState = external;
  });
  const groups = build.relationships?.betaGroups;
  if (!Array.isArray(groups?.data) || groups.data.length > 50) throw malformed();
  report.betaGroupCount = groups.data.length;
  report.betaGroupCountIsExact = !groups.links?.next && (groups.data.length < 50 ||
    groups.meta?.paging?.total === groups.data.length) &&
    !(Number.isInteger(groups.meta?.paging?.total) && groups.meta.paging.total > groups.data.length);
  if (!report.betaGroupCountIsExact) report.limitations.push('Beta groups truncated at 50; count is a lower bound.');
  for (const ref of groups.data) {
    const group = result.included.find(item => item.type === 'betaGroups' && item.id === ref.id);
    if (!resourceId(ref.id) || ref.type !== 'betaGroups' || !isObject(group?.attributes) ||
        typeof group.attributes.name !== 'string' || typeof group.attributes.isInternalGroup !== 'boolean') throw malformed();
    const entry = {
      // JSON output escapes newlines; additionally exclude control characters and email-like strings.
      id: ref.id, publicLinkEnabled: typeof group.attributes.publicLinkEnabled === 'boolean' ? group.attributes.publicLinkEnabled : null,
      name: group.attributes.name.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\S+@\S+/g, '[redacted]').slice(0, 120),
      isInternalGroup: group.attributes.isInternalGroup, testerCount: null,
    };
    const count = await optional('Group tester count', async () => {
      const testers = await get(`/v1/betaGroups/${ref.id}/relationships/betaTesters`, { limit: '1' });
      const total = testers.meta?.paging?.total;
      if (!Array.isArray(testers.data) || !Number.isSafeInteger(total) || total < 0) throw malformed();
      return total; // Relationship identifiers are deliberately neither retained nor printed.
    });
    entry.testerCount = count;
    report.betaGroups.push(entry);
  }
  // Assigned build groups above are not the app's inventory of existing groups.
  report.existingAppGroups = null;
  report.existingAppGroupCount = null;
  report.existingAppGroupCountIsExact = false;
  await optional('Existing app groups', async () => {
    // Apple: GET /v1/apps/{id}/betaGroups. Bounded; never follow response links.
    const inventory = await get(`/v1/apps/${config.appId}/betaGroups`, {
      limit: '50', 'fields[betaGroups]': 'name,isInternalGroup,publicLinkEnabled',
    });
    if (!Array.isArray(inventory.data) || inventory.data.length > 50) throw malformed();
    const entries = [];
    for (const group of inventory.data) {
      const a = group.attributes;
      if (group.type !== 'betaGroups' || !resourceId(group.id) || !isObject(a) ||
          typeof a.name !== 'string' || typeof a.isInternalGroup !== 'boolean' ||
          (a.publicLinkEnabled != null && typeof a.publicLinkEnabled !== 'boolean')) throw malformed();
      const entry = {
        id: group.id, name: a.name.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\S+@\S+/g, '[redacted]').slice(0, 120),
        isInternalGroup: a.isInternalGroup, publicLinkEnabled: a.publicLinkEnabled ?? null, testerCount: null,
      };
      entry.testerCount = await optional('Existing group tester count', async () => {
        const testers = await get(`/v1/betaGroups/${group.id}/relationships/betaTesters`, { limit: '1' });
        const total = testers.meta?.paging?.total;
        if (!Array.isArray(testers.data) || !Number.isSafeInteger(total) || total < 0) throw malformed();
        return total;
      });
      entries.push(entry);
    }
    report.existingAppGroups = entries;
    report.existingAppGroupCount = entries.length;
    report.existingAppGroupCountIsExact = !inventory.links?.next && (entries.length < 50 ||
      inventory.meta?.paging?.total === entries.length) &&
      !(Number.isInteger(inventory.meta?.paging?.total) && inventory.meta.paging.total > entries.length);
    if (!report.existingAppGroupCountIsExact) report.limitations.push('Existing app groups truncated at 50; count is a lower bound.');
  });
  const usable = report.processingState === 'VALID' && !report.expired;
  const ready = value => ['READY_FOR_BETA_TESTING', 'IN_BETA_TESTING'].includes(value);
  report.processedValid = report.processingState === 'VALID';
  report.internalReadyOrTesting = usable && ready(report.internalBuildState);
  report.externalReadyOrTesting = usable && ready(report.externalBuildState);
  report.internalReadyAndGroupAssigned = report.internalReadyOrTesting && report.betaGroups.some(group => group.isInternalGroup);
  report.externalReadyAndGroupAssigned = report.externalReadyOrTesting && report.betaGroups.some(group => !group.isInternalGroup);
  report.externalBetaApproved = report.externalBuildState === 'BETA_APPROVED';
  report.externalApprovedAndGroupAssigned = usable && report.externalBetaApproved && report.betaGroups.some(group => !group.isInternalGroup);
  report.note = 'betaGroups lists groups assigned to this build; existingAppGroups lists existing groups for the app, not assignment. VALID means processed, not TestFlight availability. Readiness and group assignment are separate; neither proves tester acceptance or installation.';
  return report;
}

export async function main(env = process.env, fetchImpl = fetch, output = console.log, errorOutput = console.error) {
  try {
    output(JSON.stringify(await checkStatus(env, fetchImpl), null, 2));
    return 0;
  } catch (error) {
    errorOutput(error instanceof StatusError ? error.message : 'Status check failed; no private error details printed.');
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
