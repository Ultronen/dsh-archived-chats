import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyUnaccountedSessions,
  indexSessionHeaders,
  normalizeSessionId,
  resolveSubagentDescendants,
} from '../lib/session-graph.js';

const subagent = (id, parentSession, delegationDepth = 1) => ({
  id,
  createdAt: 1,
  cwd: '/project',
  parentSession,
  origin: 'subagent',
  delegationDepth,
});

const fork = (id, parentSession) => ({ id, createdAt: 1, cwd: '/project', parentSession });
const root = (id) => ({ id, createdAt: 1, cwd: '/project' });

test('normalizes both id dialects and rejects unusable identities', () => {
  assert.equal(normalizeSessionId('session-ABC-123'), 'abc-123');
  assert.equal(normalizeSessionId('ABC-123'), 'abc-123');
  assert.equal(normalizeSessionId('  abc-123  '), 'abc-123');
  assert.equal(normalizeSessionId('SESSION-abc'), 'abc');
  assert.equal(normalizeSessionId(''), null);
  assert.equal(normalizeSessionId('   '), null);
  assert.equal(normalizeSessionId(null), null);
  assert.equal(normalizeSessionId(undefined), null);
  assert.equal(normalizeSessionId(42), null);
  assert.equal(normalizeSessionId({}), null);
});

test('indexes usable headers by normalized id', () => {
  const byId = indexSessionHeaders([
    subagent('session-abc', 'session-parent'),
    null,
    'not-a-header',
    { createdAt: 1 },
    [],
  ]);
  assert.deepEqual([...byId.keys()], ['abc']);
  assert.equal(byId.get('abc').parentSession, 'parent');
  assert.equal(byId.get('abc').isSubagent, true);
});

test('indexing never mutates the supplied headers', () => {
  const header = subagent('session-abc', 'session-parent');
  const snapshot = JSON.stringify(header);
  indexSessionHeaders([header]);
  assert.equal(JSON.stringify(header), snapshot);
});

test('resolves prefixed and bare ids across the same edge', () => {
  // The stored dialect differs on both sides of every edge here: without
  // normalization each parent would look absent and this would resolve to none.
  const headers = [
    root('session-root'),
    subagent('child', 'session-root'),
    subagent('session-grandchild', 'child', 2),
    subagent('session-great', 'session-grandchild', 3),
  ];
  assert.deepEqual([...resolveSubagentDescendants(headers, ['session-root'])].sort(), [
    'child',
    'session-grandchild',
    'session-great',
  ]);
});

test('returns ids in the dialect the Host stores, never the normalized key', () => {
  // The result is fed straight back to locate/purge/detach, so a normalized id
  // would be an identity the Host does not recognise.
  const headers = [root('session-root'), subagent('session-Child', 'session-root')];
  const resolved = [...resolveSubagentDescendants(headers, ['root'])];
  assert.deepEqual(resolved, ['session-Child']);
  assert.equal(indexSessionHeaders(headers).get('child').rawId, 'session-Child');
  assert.equal(indexSessionHeaders(headers).get('child').id, 'child');
});

test('accepts roots in either dialect', () => {
  const headers = [root('root'), subagent('child', 'root')];
  assert.deepEqual([...resolveSubagentDescendants(headers, ['root'])], ['child']);
  assert.deepEqual([...resolveSubagentDescendants(headers, ['session-root'])], ['child']);
});

test('never returns a root as its own descendant', () => {
  const headers = [root('a'), subagent('b', 'a'), subagent('c', 'b', 2)];
  const resolved = resolveSubagentDescendants(headers, ['a', 'b']);
  assert.equal(resolved.has('a'), false);
  assert.equal(resolved.has('b'), false);
  assert.equal(resolved.has('c'), true);
});

test('a fork is neither a target nor a bridge to its own subagents', () => {
  // `fork` branched from `root` and is an independent chat. Its subagent
  // belongs to the fork, which survives the root, so deleting the root must
  // reach neither of them.
  const headers = [
    root('root'),
    fork('fork', 'session-root'),
    subagent('fork-agent', 'fork'),
    subagent('direct-agent', 'root'),
  ];
  assert.deepEqual([...resolveSubagentDescendants(headers, ['root'])], ['direct-agent']);
});

test('a dangling parent yields no descendants instead of throwing', () => {
  const headers = [subagent('child', 'session-already-deleted')];
  assert.deepEqual([...resolveSubagentDescendants(headers, ['session-already-deleted'])], []);
  assert.deepEqual([...resolveSubagentDescendants(headers, ['child'])], []);
});

test('unknown roots and unusable root values are ignored', () => {
  const headers = [root('a'), subagent('b', 'a')];
  assert.deepEqual([...resolveSubagentDescendants(headers, ['missing'])], []);
  assert.deepEqual([...resolveSubagentDescendants(headers, [null, '', 7, {}])], []);
  assert.deepEqual([...resolveSubagentDescendants(headers, [])], []);
  assert.deepEqual([...resolveSubagentDescendants(headers, undefined)], []);
  assert.deepEqual([...resolveSubagentDescendants(undefined, ['a'])], []);
});

test('a self-parent edge terminates and is not a descendant edge', () => {
  const headers = [{ id: 'loop', createdAt: 1, cwd: '/p', parentSession: 'loop', origin: 'subagent', delegationDepth: 1 }];
  assert.deepEqual([...resolveSubagentDescendants(headers, ['loop'])], []);
});

test('a corrupt cycle terminates instead of hanging', () => {
  const headers = [
    subagent('a', 'c'),
    subagent('b', 'a', 2),
    subagent('c', 'b', 3),
  ];
  const resolved = resolveSubagentDescendants(headers, ['a']);
  assert.equal(resolved.has('b'), true);
  assert.equal(resolved.has('c'), true);
  assert.equal(resolved.has('a'), false);
});

test('a shared descendant is reported once', () => {
  const headers = [root('p1'), root('p2'), subagent('shared', 'p1')];
  assert.deepEqual([...resolveSubagentDescendants(headers, ['p1', 'p2'])], ['shared']);
});

test('enforces the descendant bound', () => {
  const headers = [root('r'), ...Array.from({ length: 5 }, (_, index) => subagent(`c${index}`, 'r'))];
  assert.equal(resolveSubagentDescendants(headers, ['r'], { maxNodes: 5 }).size, 5);
  assert.throws(
    () => resolveSubagentDescendants(headers, ['r'], { maxNodes: 4 }),
    (error) => error.code === 'session-graph-limit-exceeded',
  );
  assert.throws(() => resolveSubagentDescendants(headers, ['r'], { maxNodes: 0 }), TypeError);
});

test('classifies a subagent with a missing parent as an orphan', () => {
  const headers = [root('kept'), subagent('lost', 'deleted-parent')];
  const { orphans, topLevel } = classifyUnaccountedSessions(headers, []);
  assert.deepEqual(orphans.map((node) => node.rawId), ['lost']);
  assert.deepEqual(topLevel.map((node) => node.rawId), ['kept']);
});

test('a subagent whose parent exists is not an orphan, in either dialect', () => {
  // This is the failure that matters most: `parentSession` uses the other
  // dialect than the stored parent id, so a raw comparison reports a healthy
  // child as an orphan and the count inflates.
  const headers = [
    root('session-parent'),
    subagent('prefixed-child', 'session-parent'),
    subagent('bare-child', 'parent'),
    subagent('lost', 'genuinely-gone'),
  ];
  const { orphans } = classifyUnaccountedSessions(headers, []);
  assert.deepEqual(orphans.map((node) => node.rawId), ['lost']);
});

test('accounted sessions are never classified, in either dialect', () => {
  // The archive set stores `session-owned`; asking with the bare dialect must
  // still exclude it, and its subagent stays reachable through it.
  const headers = [root('session-owned'), root('session-free'), subagent('child-of-owned', 'session-owned')];
  const { orphans, topLevel } = classifyUnaccountedSessions(headers, ['owned']);
  assert.deepEqual(orphans.map((node) => node.rawId), []);
  assert.deepEqual(topLevel.map((node) => node.rawId), ['session-free']);
});

test('a fork is not an orphan of the chat it branched from', () => {
  // Even when the origin session is gone, the fork is an independent chat that
  // someone may still want, so it must never be offered as residue.
  const headers = [fork('forked', 'deleted-origin')];
  const { orphans, topLevel } = classifyUnaccountedSessions(headers, []);
  assert.deepEqual(orphans, []);
  assert.deepEqual(topLevel, []);
});

test('a self-parented subagent is an orphan rather than a phantom parent', () => {
  const headers = [{ id: 'loop', createdAt: 1, cwd: '/p', parentSession: 'loop', origin: 'subagent', delegationDepth: 1 }];
  const { orphans } = classifyUnaccountedSessions(headers, []);
  assert.deepEqual(orphans.map((node) => node.rawId), ['loop']);
});

test('classification is sorted oldest-first and tolerates bad input', () => {
  const headers = [
    { ...subagent('late', 'gone-a'), createdAt: 5 },
    subagent('early', 'gone-b'),
    { ...subagent('undated', 'gone-c'), createdAt: undefined },
    null,
    'nope',
  ];
  const { orphans } = classifyUnaccountedSessions(headers, []);
  assert.deepEqual(orphans.map((node) => node.rawId), ['early', 'late', 'undated']);
  assert.deepEqual(classifyUnaccountedSessions(undefined, undefined), { orphans: [], topLevel: [] });
  assert.deepEqual(classifyUnaccountedSessions(headers, null).orphans.length, 3);
});


test('ambiguous normalized identities cannot authorize orphan cleanup', () => {
  assert.throws(() => classifyUnaccountedSessions([
    { id: 'session-a', origin: 'subagent', parentSession: 'missing' },
    { id: 'a', parentSession: 'different' },
  ], []), { code: 'session-identity-ambiguous' });
});
