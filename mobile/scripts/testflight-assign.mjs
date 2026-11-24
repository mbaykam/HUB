import { pathToFileURL } from 'node:url';
import { StatusError, validateConfig, createToken, createReadClient, readExactBuild } from './testflight-status.mjs';

const validId = value => typeof value === 'string' && /^[A-Za-z0-9-]{1,100}$/.test(value);
const invalid = () => new StatusError('Apple response could not establish safe assignment; no write attempted.');

export async function assignBuild(env, fetchImpl = fetch, now = new Date()) {
  const config = validateConfig(env);
  const groupId = env.EXISTING_GROUP_ID;
  if (!validId(groupId)) throw new StatusError('EXISTING_GROUP_ID is missing or invalid.');
  if (env.CONFIRMATION !== 'ADD_EXISTING_BUILD_TO_EXISTING_GROUP') {
    throw new StatusError('Exact existing-build/group assignment confirmation is required.');
  }
  const get = createReadClient(env, fetchImpl, now);
  const { build } = await readExactBuild(get, config);
  if (build.attributes.processingState !== 'VALID' || build.attributes.expired !== false) {
    throw new StatusError('Build must be VALID and not expired; no write attempted.');
  }
  const group = (await get(`/v1/betaGroups/${groupId}`, {
    include: 'app', 'fields[betaGroups]': 'name,isInternalGroup,publicLinkEnabled,app', 'fields[apps]': 'bundleId',
  })).data;
  if (group?.type !== 'betaGroups' || group.id !== groupId ||
      group.relationships?.app?.data?.type !== 'apps' || group.relationships.app.data.id !== config.appId) throw invalid();
  if (group.attributes?.isInternalGroup === false) {
    throw new StatusError('External beta group requires a different explicit decision; no write attempted.');
  }
  // Apple documents publicLinkEnabled:null for internal groups. Missing/other values fail closed.
  if (group.attributes?.isInternalGroup !== true ||
      ![false, null].includes(group.attributes.publicLinkEnabled)) {
    throw new StatusError('Group is not a confirmed private internal group; no write attempted.');
  }
  const relationshipPath = `/v1/betaGroups/${groupId}/relationships/builds`;
  async function assigned() {
    const body = await get(relationshipPath, { limit: '200' });
    if (!Array.isArray(body.data) || body.data.length > 200 ||
        body.data.some(item => item.type !== 'builds' || !validId(item.id))) {
      throw new StatusError('Group assignment readback is malformed; no automatic retry.');
    }
    if (body.data.some(item => item.id === build.id)) return true;
    if (body.links?.next || (body.data.length === 200 && body.meta?.paging?.total !== body.data.length) ||
        (Number.isInteger(body.meta?.paging?.total) && body.meta.paging.total > body.data.length)) {
      throw new StatusError('Group builds exceed bounded read; assignment cannot be confirmed. No automatic retry.');
    }
    return false;
  }
  const alreadyAssigned = await assigned();
  if (!alreadyAssigned) {
    const token = createToken(env, Math.floor(now.getTime() / 1000));
    let response;
    try {
      // Only mutation: https://developer.apple.com/documentation/appstoreconnectapi/post-v1-betagroups-_id_-relationships-builds
      response = await fetchImpl(new URL(`https://api.appstoreconnect.apple.com${relationshipPath}`), {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: [{ type: 'builds', id: build.id }] }),
      });
    } catch {
      throw new StatusError('Assignment request outcome is uncertain; no retry performed. Run read-only discovery before any manual retry.');
    }
    if (response.status === 403) throw new StatusError('Apple API: insufficient API role or app access (403); no permissions changed, no retry performed.');
    if (response.status === 401) throw new StatusError('Apple API authentication rejected (401); no retry performed.');
    if (response.status !== 204) {
      throw new StatusError('Assignment request did not return expected 204; outcome unconfirmed, no retry performed. Run read-only discovery before any manual retry.');
    }
  }
  // Even the idempotent path verifies again. A failed readback never repeats the POST.
  let confirmed;
  try { confirmed = await assigned(); } catch (error) {
    throw new StatusError(`${error instanceof StatusError ? error.message : 'Readback failed.'} Assignment unconfirmed; no mutation retry performed.`);
  }
  if (!confirmed) throw new StatusError('Assignment absent from readback; outcome unconfirmed, no mutation retry performed.');
  return {
    checkedAt: now.toISOString(), buildNumber: config.buildNumber, buildId: build.id, existingGroupId: groupId,
    isInternalGroup: true, publicLinkEnabled: group.attributes.publicLinkEnabled,
    alreadyAssigned, postPerformed: !alreadyAssigned, assignmentConfirmed: true,
    note: 'Existing build/group relationship confirmed; does not prove tester acceptance or installation.',
  };
}

export async function main(env = process.env, fetchImpl = fetch, output = console.log, errorOutput = console.error) {
  try {
    output(JSON.stringify(await assignBuild(env, fetchImpl), null, 2));
    return 0;
  } catch (error) {
    errorOutput(error instanceof StatusError ? error.message : 'Assignment failed; no private error details printed. No automatic retry.');
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
