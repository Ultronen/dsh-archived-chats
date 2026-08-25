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
