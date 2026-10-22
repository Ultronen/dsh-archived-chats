import test from 'node:test';
import assert from 'node:assert/strict';
import { withScheduleBindings } from '../lib/session-filters.js';

test('schedule filter follows official active and inactive task bindings without exposing task prompts', async () => {
  const schedule = { async catalog() {
    assert.equal(this, schedule);
    return [{ sessionId: 'a', status: 'active', prompt: 'private' }, { sessionId: 'b', status: 'completed' }, { sessionId: 'a' }];
  } };
  const result = await withScheduleBindings(schedule, { sessions: [{ id: 'a' }, { id: 'b' }, { id: 'c', title: 'scheduled task' }] });
  assert.equal(result.scheduleStatus, 'ready');
  assert.deepEqual(result.sessions.map(row => row.hasSchedule), [true, true, false]);
  assert.equal(JSON.stringify(result).includes('private'), false);
});

test('deleted tasks stop matching on the next read and do not become a permanent session type', async () => {
  let catalog = [{ sessionId: 'a' }];
  const service = { catalog: async () => catalog };
  const state = { sessions: [{ id: 'a', origin: 'user' }] };
  assert.equal((await withScheduleBindings(service, state)).sessions[0].hasSchedule, true);
  catalog = [];
  assert.equal((await withScheduleBindings(service, state)).sessions[0].hasSchedule, false);
  assert.equal(state.sessions[0].hasSchedule, undefined);
});

test('unsupported or failed schedule catalog cannot masquerade as an empty successful filter', async () => {
  const state = { sessions: [{ id: 'a' }] };
  assert.equal((await withScheduleBindings(undefined, state)).scheduleStatus, 'unsupported');
  for (const service of [{ catalog: async () => { throw new Error('offline'); } }, { catalog: async () => null }, { catalog: async () => [{}] }]) {
    const result = await withScheduleBindings(service, state);
    assert.equal(result.scheduleStatus, 'unavailable');
    assert.equal(result.sessions[0].hasSchedule, null);
  }
});
