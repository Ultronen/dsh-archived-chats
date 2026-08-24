export class LineageError extends Error {
  constructor(code, message, status = 500) {
    super(message);
    this.name = 'LineageError';
    this.code = code;
    this.status = status;
  }
}

const invalid = () => new LineageError('lineage-input-invalid', 'lineage input is invalid', 503);

function sessionIds(workspace) {
  if (Array.isArray(workspace?.sessionIds)) return workspace.sessionIds.map(String);
  if (workspace?.sessionIds instanceof Set) return [...workspace.sessionIds].map(String);
  return [];
}

function sortNodes(left, right) {
  const leftTime = Number.isSafeInteger(left.createdAt) ? left.createdAt : Number.MAX_SAFE_INTEGER;
  const rightTime = Number.isSafeInteger(right.createdAt) ? right.createdAt : Number.MAX_SAFE_INTEGER;
  return leftTime - rightTime || left.id.localeCompare(right.id);
}

function cloneNode(node) {
  return {
    id: node.id,
    parentSession: node.parentSession,
    seedLength: node.seedLength,
    origin: node.origin,
    delegationDepth: node.delegationDepth,
    title: node.title,
    createdAt: node.createdAt,
    workspace: { ...node.workspace },
    status: node.status,
    children: [],
  };
}

function cloneForest(roots) {
  const sources = [...roots].sort(sortNodes);
  const output = sources.map(cloneNode);
  const stack = sources.map((source, index) => ({ source, target: output[index] }));
  while (stack.length > 0) {
    const { source, target } = stack.pop();
    const children = [...source.children].sort(sortNodes);
    target.children = children.map(cloneNode);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({ source: children[index], target: target.children[index] });
    }
  }
  return output;
}

export function projectLineage({
  headers,
  archivedIds = [],
  trashRecords = new Map(),
  workspaces = [],
  titles = new Map(),
  maxNodes = 5000,
}) {
  if (!Array.isArray(headers) || !Number.isSafeInteger(maxNodes) || maxNodes < 1
    || !(trashRecords instanceof Map) || !(titles instanceof Map) || !Array.isArray(workspaces)) throw invalid();
  if (headers.length > maxNodes) throw new LineageError('lineage-limit-exceeded', 'lineage exceeds the node limit', 413);

  const archived = new Set((Array.isArray(archivedIds) ? archivedIds : []).map(String));
  const trashed = new Set([...trashRecords.keys()].map(String));
  const workspaceBySession = new Map();
  for (const workspace of workspaces) {
    if (workspace === null || typeof workspace !== 'object') throw invalid();
    const safe = {
      id: typeof workspace.id === 'string' ? workspace.id : null,
      title: typeof workspace.title === 'string' ? workspace.title : null,
    };
    for (const id of sessionIds(workspace)) if (!workspaceBySession.has(id)) workspaceBySession.set(id, safe);
  }

  const nodes = new Map();
  const order = [];
  for (const header of headers) {
    if (header === null || typeof header !== 'object' || Array.isArray(header)
      || typeof header.id !== 'string' || header.id === '' || nodes.has(header.id)
      || !Number.isSafeInteger(header.createdAt) || header.createdAt < 0
      || (header.parentSession !== undefined && (typeof header.parentSession !== 'string' || header.parentSession === ''))
      || (header.seedLength !== undefined && (!Number.isSafeInteger(header.seedLength) || header.seedLength < 0))
      || (header.origin !== undefined && header.origin !== 'subagent')
      || (header.delegationDepth !== undefined && (!Number.isSafeInteger(header.delegationDepth) || header.delegationDepth < 0))) {
      throw invalid();
    }
    const id = header.id;
    const cachedTitle = titles.get(id);
    const node = {
      id,
      parentSession: header.parentSession ?? null,
      seedLength: header.seedLength ?? null,
      origin: header.origin ?? null,
      delegationDepth: header.delegationDepth ?? 0,
      title: typeof cachedTitle === 'string' ? cachedTitle : (typeof header.title === 'string' ? header.title : null),
      createdAt: header.createdAt,
      workspace: { ...(workspaceBySession.get(id) ?? { id: null, title: null }) },
      status: trashed.has(id) ? 'trash' : archived.has(id) ? 'archived' : 'active',
      children: [],
    };
    nodes.set(id, node);
    order.push(id);
  }

  const diagnostics = [];
  const detached = new Set();
  for (const id of order) {
    const node = nodes.get(id);
    if (node.parentSession === id) {
      detached.add(id);
      diagnostics.push({ code: 'self-parent', sessionId: id, relatedId: id });
    }
  }

  const state = new Map();
  const stack = [];
  const stackIndex = new Map();
  const cycleNodes = new Set();
  const visit = (id) => {
    if ((state.get(id) ?? 0) !== 0) return;
    state.set(id, 1);
    stackIndex.set(id, stack.length);
    stack.push(id);
    const parent = nodes.get(id).parentSession;
    if (parent !== null && parent !== id && nodes.has(parent)) {
      const parentState = state.get(parent) ?? 0;
      if (parentState === 0) visit(parent);
      else if (parentState === 1) {
        const start = stackIndex.get(parent);
        for (const member of stack.slice(start)) cycleNodes.add(member);
      }
    }
    stack.pop();
    stackIndex.delete(id);
    state.set(id, 2);
  };
  for (const id of order) visit(id);
  for (const id of order) {
    if (!cycleNodes.has(id)) continue;
    detached.add(id);
    diagnostics.push({ code: 'cycle', sessionId: id, relatedId: nodes.get(id).parentSession });
  }

  const missingNodes = new Map();
  for (const id of order) {
    const node = nodes.get(id);
    const parent = node.parentSession;
    if (parent === null || detached.has(id) || nodes.has(parent)) continue;
    if (!missingNodes.has(parent)) {
      missingNodes.set(parent, {
        id: parent,
        parentSession: null,
        seedLength: null,
        origin: null,
        delegationDepth: 0,
        title: null,
        createdAt: null,
        workspace: { id: null, title: null },
        status: 'missing',
        children: [],
      });
    }
    diagnostics.push({ code: 'missing-parent', sessionId: id, relatedId: parent });
  }

  for (const id of order) {
    const node = nodes.get(id);
    const parent = node.parentSession;
    if (node.origin !== 'subagent' || parent === null || detached.has(id) || !nodes.has(parent)) continue;
    if (node.delegationDepth !== nodes.get(parent).delegationDepth + 1) {
      diagnostics.push({ code: 'delegation-depth-mismatch', sessionId: id, relatedId: parent });
    }
  }

  const roots = [];
  for (const id of order) {
    const node = nodes.get(id);
    const parent = node.parentSession;
    if (parent === null || detached.has(id)) roots.push(node);
    else if (nodes.has(parent)) nodes.get(parent).children.push(node);
    else missingNodes.get(parent).children.push(node);
  }
  roots.push(...missingNodes.values());

  return {
    roots: cloneForest(roots),
    diagnostics: diagnostics.map((item) => ({ ...item })),
    nodeCount: nodes.size,
  };
}
