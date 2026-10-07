/**
 * Session-graph helpers shared by cascade deletion and orphan management.
 *
 * Two facts about stored session headers drive every decision in this module:
 *
 * 1. Session ids exist in two dialects. Some headers store a bare UUID and
 *    others the same UUID behind a `session-` prefix, and `parentSession` mixes
 *    both across a single edge. Comparing raw strings therefore fails to match
 *    a parent that is present, which would report a healthy child as an orphan
 *    and make a cascade miss real descendants. Every identity comparison here
 *    normalizes first.
 *
 * 2. `parentSession` does not imply "owned by". A branched chat (a fork) keeps
 *    a pointer to the chat it branched from but is an independent conversation.
 *    Only `origin === 'subagent'` marks a session as an artifact of its parent,
 *    so only those edges are traversed. A fork is never a cascade target and is
 *    never treated as an orphan of the chat it branched from.
 *
 * The graph is derived from the Host's header list and is deliberately
 * read-only: it never mutates headers and never assumes the list is complete.
 * A missing parent is a normal, expected input, not an error.
 */

const SESSION_PREFIX = /^session-/i;

/**
 * Reduce either id dialect to one comparable form.
 * Returns null for anything that is not a usable identity, so callers can drop
 * the value instead of accidentally comparing `undefined` to `undefined`.
 */
export function normalizeSessionId(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  return trimmed.replace(SESSION_PREFIX, '').toLowerCase();
}

/**
 * Index headers by normalized id. The first header for an id wins, matching the
 * lineage projection's duplicate handling; a header without a usable identity is
 * skipped rather than failing the whole graph. Each entry is a shallow copy so
 * callers can rely on the normalized fields without mutating Host data.
 *
 * `id` is the normalized comparison key and `rawId` is the id exactly as the
 * Host stores it. Callers that talk back to the Host — locate, purge, detach —
 * must use `rawId`, because a normalized id is not a valid session identity.
 */
export function indexSessionHeaders(headers) {
  const byId = new Map();
  for (const header of Array.isArray(headers) ? headers : []) {
    if (header === null || typeof header !== 'object' || Array.isArray(header)) continue;
    const id = normalizeSessionId(header.id);
    if (id === null || byId.has(id)) continue;
    byId.set(id, {
      ...header,
      rawId: header.id,
      id,
      parentSession: normalizeSessionId(header.parentSession),
      isSubagent: header.origin === 'subagent',
    });
  }
  return byId;
}

/**
 * Build the child index for subagent edges only.
 *
 * A self-parent edge and an edge to an id that is not present are both dropped:
 * the first cannot be a real containment edge, and the second has no node to
 * expand. Neither is an error — a parent that has already been deleted is the
 * normal reason a child looks dangling.
 */
function buildSubagentChildIndex(byId) {
  const childrenOf = new Map();
  for (const node of byId.values()) {
    const parent = node.parentSession;
    if (parent === null || parent === node.id) continue;
    if (!node.isSubagent || !byId.has(parent)) continue;
    const siblings = childrenOf.get(parent);
    if (siblings === undefined) childrenOf.set(parent, [node.id]);
    else siblings.push(node.id);
  }
  return childrenOf;
}

/**
 * Resolve every subagent descendant of `rootIds`, transitively.
 *
 * Returns a Set of ids in the dialect the Host stores them in, so the caller can
 * hand them straight back to `locate`, `purge` or `detachSession`. Roots are
 * accepted in either dialect and are never part of the result. Traversal expands
 * each node at most once, which makes a corrupt cycle terminate instead of
 * hanging, and `maxNodes` bounds the work on a pathological store.
 *
 * A fork in the chain stops the walk: a subagent of a fork belongs to that fork,
 * which outlives the chat it branched from, so it is not a descendant of the
 * root for deletion purposes.
 */
export function resolveSubagentDescendants(headers, rootIds, { maxNodes = 100000 } = {}) {
  if (!Number.isSafeInteger(maxNodes) || maxNodes < 1) {
    throw new TypeError('maxNodes must be a positive safe integer');
  }
  const byId = indexSessionHeaders(headers);
  const childrenOf = buildSubagentChildIndex(byId);

  const roots = new Set();
  const expanded = new Set();
  const collected = new Set();
  const queue = [];
  for (const raw of Array.isArray(rootIds) ? rootIds : []) {
    const id = normalizeSessionId(raw);
    if (id === null) continue;
    roots.add(id);
    queue.push(id);
  }

  const descendants = new Set();
  while (queue.length > 0) {
    const id = queue.shift();
    if (expanded.has(id)) continue;
    expanded.add(id);
    for (const child of childrenOf.get(id) ?? []) {
      if (collected.has(child)) continue;
      collected.add(child);
      // A caller that passes a whole subtree still gets only the part below it:
      // a root is a starting point, never a result. Its own children are still
      // expanded, because they descend from the root set as a whole.
      if (!roots.has(child)) {
        descendants.add(byId.get(child).rawId);
        if (descendants.size > maxNodes) {
          throw Object.assign(new Error('session graph exceeds the descendant limit'), {
            code: 'session-graph-limit-exceeded',
          });
        }
      }
      queue.push(child);
    }
  }
  return descendants;
}
