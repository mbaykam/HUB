import test from 'node:test';
import assert from 'node:assert/strict';
import {currentTurnHasUserRequest} from '../packages/harness-overlay/src/host/task-turn.ts';
import {userAskedNow} from '../packages/harness-overlay/src/host/projects.ts';

const agent = events => ({session: {snapshotEvents: () => events}});
const user = rpcId => ({type: 'user/message', data: {source: {kind: 'user', rpcId}}});

for (const [name, check] of [['task authority', currentTurnHasUserRequest], ['project authority', userAskedNow]]) {
  test(`${name}: automatic subscription continuation is not fresh human approval`, () => {
    const events = [{type: 'turn/start'}, user('hub-quota-resume-checkpoint'), {type: 'assistant/message'}];
    assert.equal(check(agent(events)), false);
    assert.equal(check(agent([{type: 'turn/start'}, user('native-user-request')])), true);
    assert.equal(check(agent([{type: 'turn/start'}, user('hub-quota-resume-old'), user('native-user-followup')])), true);
    assert.equal(check(agent([user('native-user-request'), {type: 'turn/end'}])), false);
  });
}
