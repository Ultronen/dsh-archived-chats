import test from 'node:test';
import assert from 'node:assert/strict';
import { LineageError, projectLineage } from '../lib/lineage.js';

test('lineage projects parentSession edges and preserves ancestors for missing parents', () => {
  const graph = projectLineage({
    headers: [
      { id: 'root', createdAt: 1 },
      { id: 'fork', createdAt: 2, parentSession: 'root', seedLength: 4 },
      { id: 'agent', createdAt: 3, parentSession: 'fork', origin: 'subagent', delegationDepth: 1 },
      { id: 'orphan', createdAt: 4, parentSession: 'missing' },
    ],
    archivedIds: ['fork'],
    trashRecords: new Map([['agent', { sessionId: 'agent' }]]),
    workspaces: [],
    titles: new Map([['root', 'Root']]),
  });

  assert.deepEqual(graph.roots.map((node) => node.id), ['root', 'missing']);
  assert.equal(graph.roots[0].children[0].id, 'fork');
  assert.equal(graph.roots[0].children[0].status, 'archived');
  assert.equal(graph.roots[0].children[0].children[0].status, 'trash');
  assert.equal(graph.roots[1].status, 'missing');
  assert.deepEqual(graph.roots[1].children.map((node) => node.id), ['orphan']);
  assert.deepEqual(graph.diagnostics, [
    { code: 'missing-parent', sessionId: 'orphan', relatedId: 'missing' },
  ]);
  assert.equal(graph.nodeCount, 4);
});

test('lineage reports self links, cycles, and subagent depth mismatches without looping', () => {
  const graph = projectLineage({
    headers: [
      { id: 'self', createdAt: 1, parentSession: 'self' },
      { id: 'cycle-a', createdAt: 2, parentSession: 'cycle-b' },
      { id: 'cycle-b', createdAt: 3, parentSession: 'cycle-a' },
      { id: 'parent', createdAt: 4, delegationDepth: 1 },
      { id: 'child', createdAt: 5, parentSession: 'parent', origin: 'subagent', delegationDepth: 1 },
    ],
    archivedIds: [],
    trashRecords: new Map(),
    workspaces: [],
    titles: new Map(),
  });

  assert.deepEqual(graph.roots.map((node) => node.id), ['self', 'cycle-a', 'cycle-b', 'parent']);
  assert.equal(graph.roots.find((node) => node.id === 'parent').children[0].id, 'child');
  assert.deepEqual(graph.diagnostics, [
    { code: 'self-parent', sessionId: 'self', relatedId: 'self' },
    { code: 'cycle', sessionId: 'cycle-a', relatedId: 'cycle-b' },
    { code: 'cycle', sessionId: 'cycle-b', relatedId: 'cycle-a' },
    { code: 'delegation-depth-mismatch', sessionId: 'child', relatedId: 'parent' },
  ]);
});

test('lineage applies trash then archive status and strips private fields', () => {
  const graph = projectLineage({
    headers: [
      { id: 'a', createdAt: 1, cwd: '/secret', events: ['private'], note: 'private' },
      { id: 'b', createdAt: 2, parentSession: 'a', origin: 'subagent', delegationDepth: 1 },
    ],
    archivedIds: ['a', 'b'],
    trashRecords: new Map([['b', { sessionId: 'b', note: 'secret' }]]),
    workspaces: [{ id: 'w', title: 'Work', path: '/secret/work', sessionIds: new Set(['a', 'b']) }],
    titles: new Map([['a', 'Alpha'], ['b', 'Beta']]),
  });
  assert.equal(graph.roots[0].status, 'archived');
  assert.equal(graph.roots[0].children[0].status, 'trash');
  assert.deepEqual(graph.roots[0].workspace, { id: 'w', title: 'Work' });
  const text = JSON.stringify(graph);
  for (const field of ['cwd', 'path', 'events', 'note', 'tags', 'attachments']) {
    assert.equal(text.includes(`"${field}"`), false);
  }
});

test('lineage focus excludes unrelated active descendants but keeps paths between managed sessions', () => {
  const graph = projectLineage({
    headers: [
      { id: 'ancestor', createdAt: 1 },
      { id: 'archived', createdAt: 2, parentSession: 'ancestor' },
      { id: 'active-child', createdAt: 3, parentSession: 'archived', origin: 'subagent', delegationDepth: 1 },
      { id: 'active-bridge', createdAt: 4, parentSession: 'archived', origin: 'subagent', delegationDepth: 1 },
      { id: 'archived-grandchild', createdAt: 5, parentSession: 'active-bridge', origin: 'subagent', delegationDepth: 2 },
      { id: 'unrelated-sibling', createdAt: 6, parentSession: 'ancestor' },
      { id: 'unrelated-root', createdAt: 7 },
    ],
    archivedIds: ['archived', 'archived-grandchild'],
    trashRecords: new Map(),
    workspaces: [],
    titles: new Map(),
    focusIds: ['archived', 'archived-grandchild'],
  });

  assert.deepEqual(graph.roots.map((node) => node.id), ['ancestor']);
  assert.deepEqual(graph.roots[0].children.map((node) => node.id), ['archived']);
  assert.deepEqual(graph.roots[0].children[0].children.map((node) => node.id), ['active-bridge']);
  assert.deepEqual(graph.roots[0].children[0].children[0].children.map((node) => node.id), ['archived-grandchild']);
  assert.equal(JSON.stringify(graph).includes('active-child'), false);
  assert.equal(JSON.stringify(graph).includes('unrelated-sibling'), false);
  assert.equal(JSON.stringify(graph).includes('unrelated-root'), false);
  assert.equal(graph.nodeCount, 4);
});

test('lineage focus is empty without archived or recycled sessions', () => {
  const graph = projectLineage({
    headers: [{ id: 'active-only', createdAt: 1 }],
    archivedIds: [],
    trashRecords: new Map(),
    workspaces: [],
    titles: new Map(),
    focusIds: [],
  });

  assert.deepEqual(graph, { roots: [], diagnostics: [], nodeCount: 0 });
});

test('lineage focus still represents a recycled session whose original header is gone', () => {
  const graph = projectLineage({
    headers: [{ id: 'active-only', createdAt: 1 }],
    archivedIds: [],
    trashRecords: new Map([['recycled', {
      sessionId: 'recycled',
      title: 'Recovered from snapshot',
      createdAt: 2,
      origin: 'host-private-origin',
      workspace: { id: 'workspace-a', title: 'Workspace A', path: '/private' },
    }]]),
    workspaces: [],
    titles: new Map(),
    focusIds: ['recycled'],
  });

  assert.deepEqual(graph.roots.map((node) => ({ id: node.id, title: node.title, status: node.status })), [
    { id: 'recycled', title: 'Recovered from snapshot', status: 'trash' },
  ]);
  assert.deepEqual(graph.roots[0].workspace, { id: 'workspace-a', title: 'Workspace A' });
  assert.equal(graph.roots[0].origin, null);
  assert.equal(JSON.stringify(graph).includes('/private'), false);
  assert.equal(JSON.stringify(graph).includes('host-private-origin'), false);
  assert.equal(graph.nodeCount, 1);
});

test('lineage rejects more than five thousand real headers without a partial graph', () => {
  const headers = Array.from({ length: 5001 }, (_, index) => ({ id: `s-${index}`, createdAt: index }));
  assert.throws(
    () => projectLineage({ headers, archivedIds: [], trashRecords: new Map(), workspaces: [], titles: new Map() }),
    (error) => error instanceof LineageError && error.code === 'lineage-limit-exceeded' && error.status === 413,
  );
});

test('lineage projects a valid five-thousand-node chain without recursion overflow', () => {
  const headers = Array.from({ length: 5000 }, (_, index) => ({
    id: `s-${index}`,
    createdAt: index,
    ...(index === 0 ? {} : { parentSession: `s-${index - 1}`, seedLength: index }),
  }));
  const graph = projectLineage({ headers, archivedIds: [], trashRecords: new Map(), workspaces: [], titles: new Map() });
  assert.equal(graph.nodeCount, 5000);
  let node = graph.roots[0];
  for (let index = 1; index < 5000; index += 1) node = node.children[0];
  assert.equal(node.id, 's-4999');
});

/**
 * Headers are the Host's data. This projection used to reject the entire graph
 * for any header it did not anticipate, which made a Host-side change — a new
 * `origin` value, say — able to break the panel with no plugin change at all.
 * It is the only surface that failed whole-graph on one unrecognized row.
 */
test('one unrecognized header degrades its own node instead of the whole graph', () => {
  const base = (id, patch = {}) => ({ id, createdAt: 1000, ...patch });
  const cases = [
    ['an origin value added by a later Host', base('s-2', { origin: 'schedule' }), { origin: null }],
    ['no createdAt at all', { id: 's-2' }, { createdAt: null }],
    ['createdAt as an ISO string', base('s-2', { createdAt: '2026-08-19T10:00:00.000Z' }), { createdAt: null }],
    ['createdAt negative', base('s-2', { createdAt: -1 }), { createdAt: null }],
    ['delegationDepth null', base('s-2', { origin: 'subagent', delegationDepth: null }), { delegationDepth: 0 }],
    ['seedLength as a float', base('s-2', { seedLength: 1.5 }), { seedLength: null }],
    ['parentSession as an empty string', base('s-2', { parentSession: '' }), { parentSession: null }],
  ];
  for (const [label, header, expected] of cases) {
    const graph = projectLineage({
      headers: [base('s-1'), header],
      archivedIds: ['s-1', 's-2'],
      trashRecords: new Map(),
      workspaces: [],
      titles: new Map(),
    });
    assert.equal(graph.nodeCount, 2, `${label}: both sessions still project`);
    const node = graph.roots.find((item) => item.id === 's-2');
    assert.ok(node !== undefined, `${label}: the unrecognized session still appears`);
    for (const [field, value] of Object.entries(expected)) {
      assert.deepEqual(node[field], value, `${label}: ${field} degrades to a documented value`);
    }
  }
});

test('an unusable identity is dropped and a repeated id keeps the first header', () => {
  const graph = projectLineage({
    headers: [
      { id: 's-1', createdAt: 1000, title: 'first' },
      { id: 's-1', createdAt: 2000, title: 'duplicate' },
      { id: '', createdAt: 3000 },
      null,
      [],
      { createdAt: 4000 },
    ],
    archivedIds: ['s-1'],
    trashRecords: new Map(),
    workspaces: [],
    titles: new Map(),
  });
  assert.equal(graph.nodeCount, 1);
  assert.equal(graph.roots.length, 1);
  assert.equal(graph.roots[0].id, 's-1');
  assert.equal(graph.roots[0].title, 'first');
  assert.equal(graph.roots[0].createdAt, 1000);
});

test('a malformed workspace or recycle record never fails the graph', () => {
  const graph = projectLineage({
    headers: [{ id: 's-1', createdAt: 1000 }],
    archivedIds: ['s-1'],
    trashRecords: new Map([
      ['s-2', { sessionId: 's-2', title: 'recycled', createdAt: 2000 }],
      ['s-3', { sessionId: 'does-not-match', title: 'bogus' }],
      ['s-4', null],
    ]),
    workspaces: [null, 'not-an-object', { id: 'ws-1', title: 'Project', sessionIds: ['s-1'] }],
    titles: new Map(),
  });
  assert.deepEqual(graph.roots.map((node) => node.id).sort(), ['s-1', 's-2']);
  assert.deepEqual(graph.roots.find((node) => node.id === 's-1').workspace, { id: 'ws-1', title: 'Project' });
});

/**
 * The limit bounds the graph that is RETURNED. `focusIds` narrows the output to
 * the archived and recycled chats plus their explaining context, so the size of
 * the Host's store is not what decides whether the panel works.
 */
test('the node limit counts the projected graph, not how many sessions the Host stores', () => {
  const headers = Array.from({ length: 20000 }, (_, index) => ({ id: `s-${index}`, createdAt: 1000 + index }));
  const focus = ['s-0', 's-1', 's-2'];
  const graph = projectLineage({
    headers, archivedIds: focus, trashRecords: new Map(), workspaces: [], titles: new Map(), focusIds: focus,
  });
  assert.equal(graph.nodeCount, 3);
  assert.deepEqual(graph.roots.map((node) => node.id), focus);

  // A focus set whose own ancestry exceeds the limit is still refused.
  const chain = Array.from({ length: 5001 }, (_, index) => ({
    id: `c-${index}`,
    createdAt: 1000 + index,
    ...(index === 0 ? {} : { parentSession: `c-${index - 1}` }),
  }));
  assert.throws(
    () => projectLineage({
      headers: chain, archivedIds: ['c-5000'], trashRecords: new Map(), workspaces: [], titles: new Map(), focusIds: ['c-5000'],
    }),
    (error) => error instanceof LineageError && error.code === 'lineage-limit-exceeded' && error.status === 413,
  );
});
