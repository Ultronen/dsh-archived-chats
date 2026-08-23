# Native-Style Archived Conversation Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the generic archived-message cards with a read-only Harness-native conversation preview, retain the left turn rail, and securely display stored images.

**Architecture:** Keep persistence inspection, archive authorization, pagination, and cache ownership on the Host. Extend the bounded projection with structured tool and image fields, add an authorized image-byte route backed by `ctx.attachments.readImage()`, and adapt those records in `lib/client.js` to public Harness presentation primitives with safe local fallbacks. Never mount the private live `ChatView` or synthesize a live session.

**Tech Stack:** Node.js ESM Host code, Cordis services, DeepSeek Harness session and attachment contracts, browser React 18 module-loader bundle, Harness client UI primitives, Node test runner, existing hand-written smoke harness.

**Spec:** `docs/superpowers/specs/2026-08-23-native-archive-preview-design.md`

**Status:** Implemented and release-verified. The automated suite, package
contents, and whitespace checks pass, and the final preview was exercised and
captured in DeepSeek Harness `0.1.1-rc.2`. The unchecked steps below are kept
as the original execution runbook rather than a live progress tracker.

## Global Constraints

- Keep package version `0.10.0`; this work completes the unreleased feature rather than opening another release.
- The supported real-host target is DeepSeek Harness `0.1.1-rc.2`; preserve the existing rc.7-compatible fallback behavior where public primitives or attachment service access are absent.
- Preview remains read-only: no send, steer, retry, fork, edit, resume, or unarchive side effects.
- Keep the left turn rail on desktop and convert it to a horizontal strip on narrow layouts.
- User messages render on the right; assistant messages render on the left.
- Never mount or copy private `@deepseek-ai/dsh-client-ui-conversation` components.
- Read image bytes only through `ctx.attachments.readImage(ref, signal)` after proving the reference belongs to the requested visible archived session.
- Never accept filesystem paths, caller-supplied media types, raw HTML, raw persistence events, or permanent attachment URLs.
- Preserve the existing 64 KiB preview request cap, preview page size limits, segment code-point limit, four-way search concurrency, 30-second TTL, 64-session LRU, and 2 Mi-code-point cache ceiling.
- Primitive, message, tool, and image failures must degrade locally without disabling archive listing or unrelated preview content.
- Use TDD for every production change and keep the full suite green at every commit boundary.

## File Map

- `lib/search.js` — pure append-origin projection, bounded structured segments, image-reference lookup, search corpus, pagination, and projection cache.
- `lib/index.js` — visible-archive authorization, `/preview` JSON, `/preview/image` verified bytes, request abort propagation, and stable error responses.
- `lib/client.js` — optional public-primitive adapter, native role layout, tool/result correlation, retained active turn rail, image fetching, Blob URL lifecycle, localization, and CSS.
- `lib/types/index.d.ts` — Host route documentation including the image endpoint and attachment capability behavior.
- `lib/types/client/index.d.ts` — native read-only preview and rail behavior documentation.
- `test/search.test.mjs` — pure projection, bounds, attachment lookup, and search-regression tests.
- `test/smoke.test.mjs` — Host route authorization/bytes and browser component/interaction tests.
- `README.md`, `README.en.md` — user-facing native preview, image behavior, and compatibility notes.
- `docs/ARCHITECTURE.md`, `docs/ARCHITECTURE.en.md` — projection, public primitive, image authorization, and failure-boundary documentation.
- `assets/screenshots/8-conversation-preview.png` — real-host screenshot captured only after the final visual pass.

---

### Task 1: Preserve Native Tool and Image Data in the Bounded Projection

**Files:**
- Modify: `lib/search.js:34-145`
- Modify: `lib/types/index.d.ts:1-12`
- Test: `test/search.test.mjs:1-65`

**Interfaces:**
- Consumes: Harness append-origin events through `deriveEventMessage(event)`.
- Produces: `projectArchivedMessages(events)`, whose public segment shapes remain backward-compatible while adding `callId`, `name`, `argumentsText`, `toolCallId`, and `attachment`.
- Produces: `findProjectedImage(messages, attachmentId)`, returning the exact normalized image reference or `null`.
- Preserves: `paginateProjectedMessages(messages, options)` strips `normalized` and `searchable` but retains bounded public segment fields.

- [ ] **Step 1: Add failing structured-projection tests**

Add the following helper and test to `test/search.test.mjs`:

```js
const imageRef = Object.freeze({
  attachmentId: 'attachment-a',
  mediaType: 'image/png',
  bytes: 4,
  width: 2,
  height: 2,
  name: 'diagram.png',
});

test('preview projection preserves tool correlation and verified image descriptors', () => {
  const messages = projectArchivedMessages([
    {
      seq: 1,
      time: 1001,
      type: 'user/message',
      surfaceOp: 'append',
      data: {
        id: 'user-1',
        role: 'user',
        source: { kind: 'user' },
        content: [
          { type: 'text', text: 'inspect this' },
          { type: 'image', attachment: imageRef },
        ],
      },
    },
    {
      seq: 2,
      time: 1002,
      type: 'assistant/message',
      surfaceOp: 'append',
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 'assistant-1',
          role: 'assistant',
          source: { kind: 'model' },
          content: [{ type: 'tool-call', id: 'call-1', name: 'read_file', arguments: '{"path":"README.md"}' }],
        },
      },
    },
    {
      seq: 3,
      time: 1003,
      type: 'tool/result',
      surfaceOp: 'append',
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 'tool-1',
          role: 'user',
          source: { kind: 'tool', callId: 'call-1' },
          content: [{ type: 'tool-result', toolCallId: 'call-1', isError: false, content: [{ type: 'text', text: 'done' }] }],
        },
      },
    },
  ]);

  assert.deepEqual(messages[0].segments[1].attachment, imageRef);
  assert.deepEqual(messages[1].segments[0], {
    kind: 'tool-call',
    label: 'read_file',
    text: '{"path":"README.md"}',
    isError: false,
    callId: 'call-1',
    name: 'read_file',
    argumentsText: '{"path":"README.md"}',
  });
  assert.equal(messages[2].segments[0].toolCallId, 'call-1');
  assert.equal(searchModule.findProjectedImage(messages, 'attachment-a')?.mediaType, 'image/png');
  assert.equal(searchModule.findProjectedImage(messages, 'missing'), null);

  const page = paginateProjectedMessages(messages, { offset: 0, limit: 3 });
  assert.equal(page.messages[0].segments[1].attachment.attachmentId, 'attachment-a');
  assert.equal('normalized' in page.messages[0], false);
  assert.equal('searchable' in page.messages[0], false);
});
```

- [ ] **Step 2: Run the focused test and observe the missing structured fields**

Run:

```bash
node --test test/search.test.mjs
```

Expected: FAIL because image segments have no `attachment`, tool calls have no `callId`, and `findProjectedImage` is not exported.

- [ ] **Step 3: Add bounded reference normalization and structured fields**

In `lib/search.js`, add a normalizer beside `imageText`:

```js
function imageAttachment(block) {
  const ref = block?.attachment;
  if (ref === null || typeof ref !== 'object') return null;
  if (typeof ref.attachmentId !== 'string' || ref.attachmentId === '') return null;
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(ref.mediaType)) return null;
  if (!Number.isInteger(ref.bytes) || ref.bytes < 0) return null;
  if (!Number.isInteger(ref.width) || ref.width <= 0) return null;
  if (!Number.isInteger(ref.height) || ref.height <= 0) return null;
  const displayName = typeof ref.name === 'string'
    ? boundedText(ref.name.replace(/^.*[\\/]/u, ''), 512)
    : '';
  return {
    attachmentId: ref.attachmentId,
    mediaType: ref.mediaType,
    bytes: ref.bytes,
    width: ref.width,
    height: ref.height,
    ...(displayName !== '' ? { name: displayName } : {}),
    ...(Number.isInteger(ref?.originalDimensions?.width)
      && Number.isInteger(ref?.originalDimensions?.height)
      && ref.originalDimensions.width > 0
      && ref.originalDimensions.height > 0
      ? { originalDimensions: { width: ref.originalDimensions.width, height: ref.originalDimensions.height } }
      : {}),
  };
}
```

Update the three structured cases in `projectBlock` without removing the old `label`, `text`, and `isError` fields used by the current preview:

```js
case 'image': {
  const attachment = imageAttachment(block);
  return {
    kind: 'image',
    label: attachment?.name ?? null,
    text: boundedText(imageText(block)),
    isError: attachment === null,
    attachment,
  };
}
case 'tool-call': {
  const name = typeof block.name === 'string' && block.name !== '' ? block.name : 'unknown';
  const argumentsText = boundedText(typeof block.arguments === 'string' ? block.arguments : jsonText(block.arguments));
  return {
    kind: 'tool-call',
    label: name,
    text: argumentsText,
    isError: false,
    callId: typeof block.id === 'string' && block.id !== '' ? block.id : null,
    name,
    argumentsText,
  };
}
case 'tool-result': {
  const text = boundedText(nestedText(block.content));
  return {
    kind: 'tool-result',
    label: typeof block.toolCallId === 'string' ? block.toolCallId : null,
    text,
    isError: block.isError === true,
    toolCallId: typeof block.toolCallId === 'string' && block.toolCallId !== '' ? block.toolCallId : null,
  };
}
```

Export the lookup used by the Host route:

```js
export function findProjectedImage(messages, attachmentId) {
  if (typeof attachmentId !== 'string' || attachmentId === '') return null;
  for (const message of Array.isArray(messages) ? messages : []) {
    for (const segment of Array.isArray(message?.segments) ? message.segments : []) {
      if (segment?.kind === 'image' && segment?.attachment?.attachmentId === attachmentId) {
        return segment.attachment;
      }
    }
  }
  return null;
}
```

- [ ] **Step 4: Document the extended Host contract**

Update `lib/types/index.d.ts` so its route list names `/preview/image` and its prose states that `/preview` returns bounded structured tool/image descriptors while image bytes remain behind a separately authorized route.

- [ ] **Step 5: Run focused and full tests**

Run:

```bash
node --test test/search.test.mjs
npm test
```

Expected: both commands exit 0; the legacy client smoke checks remain green because the old fields were retained.

- [ ] **Step 6: Commit the projection contract**

```bash
git add lib/search.js lib/types/index.d.ts test/search.test.mjs
git commit -m "feat: preserve native archive preview data"
```

---

### Task 2: Serve Authorized Archived Image Bytes

**Files:**
- Modify: `lib/index.js:8-15,78-86,314-335,682-751`
- Modify: `test/smoke.test.mjs:115-285,288-380`

**Interfaces:**
- Consumes: `findProjectedImage(messages, attachmentId)` from Task 1.
- Consumes: optional `ctx.get('attachments')` with `readImage(ref, signal): Promise<{ ref, data }>`.
- Produces: guarded `POST /plugins/dsh-archived-chats/preview/image` with JSON `{ sessionId, attachmentId }` and verified image bytes.
- Produces stable errors: `session-not-archived` (404), `preview-image-not-found` (404), `preview-image-unsupported` (503), and `preview-image-failed` (500).

- [ ] **Step 1: Extend the Host fixture with one durable image**

Add to the `session-a` user message in `test/smoke.test.mjs`:

```js
const archivedImageRef = {
  attachmentId: 'attachment-session-a',
  mediaType: 'image/png',
  bytes: 4,
  width: 2,
  height: 2,
  name: 'archive.png',
};
const archivedImageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
```

Append `{ type: 'image', attachment: archivedImageRef }` to that message's `content`, and add the service before `apply(ctx)`:

```js
let attachmentReads = 0;
services.attachments = {
  readImage: async (ref, signal) => {
    attachmentReads += 1;
    assert(signal instanceof AbortSignal, 'image read receives an abort signal');
    assert(ref.attachmentId === archivedImageRef.attachmentId, 'image read receives the projected reference');
    return { ref: archivedImageRef, data: archivedImageBytes };
  },
};
```

- [ ] **Step 2: Add failing route registration and authorization checks**

Change the expected route count to 13, add `preview/image` to the expected route list, and extend section `[1a]`:

```js
const imageGet = await jsonReq('preview/image', {
  sessionId: 'session-a',
  attachmentId: archivedImageRef.attachmentId,
}, {}, 'GET');
assert(imageGet.status === 405, `preview image rejects non-POST methods (got ${imageGet.status})`);

const imageNoGuard = await jsonReq('preview/image', {
  sessionId: 'session-a',
  attachmentId: archivedImageRef.attachmentId,
}, {});
assert(imageNoGuard.status === 403, `preview image rejects missing guard header (got ${imageNoGuard.status})`);

const oversizedImageRequest = await jsonReq('preview/image', {
  sessionId: 'session-a',
  attachmentId: archivedImageRef.attachmentId,
  padding: 'x'.repeat(64 * 1024),
});
assert(oversizedImageRequest.status === 413, 'preview image rejects bodies over 64 KiB');

const malformedImageRequest = await call(
  routes,
  '/plugins/dsh-archived-chats/preview/image',
  mockReq('POST', { 'content-type': 'application/json', 'x-dsh-archived-chats': '1' }, '{broken'),
);
assert(malformedImageRequest.status === 400, 'preview image rejects malformed JSON');

const crossSession = await jsonReq('preview/image', {
  sessionId: 'session-b',
  attachmentId: archivedImageRef.attachmentId,
});
assert(crossSession.status === 404, 'preview image denies a reference from another archived session');

const activeImage = await jsonReq('preview/image', {
  sessionId: 'session-live',
  attachmentId: archivedImageRef.attachmentId,
});
assert(activeImage.status === 404, 'preview image denies a non-archived session');

const image = await jsonReq('preview/image', {
  sessionId: 'session-a',
  attachmentId: archivedImageRef.attachmentId,
});
assert(image.status === 200, `preview image answers 200 (got ${image.status})`);
assert(image.headers['content-type'] === 'image/png', 'preview image uses the verified media type');
assert(image.headers['cache-control'] === 'no-store', 'preview image disables response caching');
assert(image.bytes().equals(archivedImageBytes), 'preview image returns the verified bytes');
assert(attachmentReads === 1, 'only the authorized request reaches the attachment service');

const savedAttachments = services.attachments;
delete services.attachments;
const unsupportedImage = await jsonReq('preview/image', {
  sessionId: 'session-a',
  attachmentId: archivedImageRef.attachmentId,
});
assert(unsupportedImage.status === 503, 'preview image reports an unavailable attachment service');
services.attachments = savedAttachments;

services.attachments = { readImage: async () => {
  throw Object.assign(new Error('/private/path/must-not-leak'), { code: 'attachment-corrupt' });
} };
const corruptImage = await jsonReq('preview/image', {
  sessionId: 'session-a',
  attachmentId: archivedImageRef.attachmentId,
});
assert(corruptImage.status === 500 && corruptImage.json().error === 'preview-image-failed', 'preview image isolates a corrupt stored image');
assert(!corruptImage.body.includes('/private/path'), 'preview image never returns attachment diagnostics');
services.attachments = savedAttachments;
```

After section `[5]` parks `session-live` for deferred deletion, add this assertion before restoring the fixture. It proves the pending-deletion filter is applied by the image route rather than merely testing an ordinary non-archived ID:

```js
const pendingImage = await call(
  routes,
  '/plugins/dsh-archived-chats/preview/image',
  mockReq('POST', {
    'content-type': 'application/json',
    'x-dsh-archived-chats': '1',
  }, JSON.stringify({ sessionId: 'session-live', attachmentId: archivedImageRef.attachmentId })),
);
assert(pendingImage.status === 404, 'preview image denies a pending-deletion session');
```

Test real abort propagation without the `call()` helper, because an aborted HTTP response is intentionally not completed:

```js
let markImageReadStarted;
const imageReadStarted = new Promise((resolve) => { markImageReadStarted = resolve; });
let imageAbortObserved = false;
services.attachments = { readImage: (_ref, signal) => new Promise((_resolve, reject) => {
  markImageReadStarted();
  signal.addEventListener('abort', () => {
    imageAbortObserved = true;
    reject(signal.reason);
  }, { once: true });
}) };
const abortedReq = mockReq('POST', {
  'content-type': 'application/json',
  'x-dsh-archived-chats': '1',
}, JSON.stringify({ sessionId: 'session-a', attachmentId: archivedImageRef.attachmentId }));
const abortedRes = mockRes();
const abortedHandler = routes.get('/plugins/dsh-archived-chats/preview/image');
const abortedPending = abortedHandler(abortedReq, abortedRes);
await imageReadStarted;
abortedReq.emit('aborted');
await abortedPending;
assert(imageAbortObserved, 'preview image aborts the attachment read with its request');
abortedRes.destroy();
services.attachments = savedAttachments;
```

- [ ] **Step 3: Run the Host smoke test and observe the missing route**

Run:

```bash
node --test test/smoke.test.mjs
```

Expected: FAIL at the route-count and `preview/image` registration assertions.

- [ ] **Step 4: Add the binary response and request-signal helpers**

In `lib/index.js`, import `findProjectedImage` and add these wire helpers beside `send`:

```js
function sendImage(res, stored) {
  const bytes = Buffer.from(stored.data);
  res.writeHead(200, {
    'content-type': stored.ref.mediaType,
    'content-length': String(bytes.length),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(bytes);
}

function requestAbort(req) {
  const controller = new AbortController();
  const abort = () => controller.abort(Object.assign(new Error('request aborted'), { code: 'request-aborted' }));
  req.once('aborted', abort);
  return {
    signal: controller.signal,
    dispose: () => req.off('aborted', abort),
  };
}
```

- [ ] **Step 5: Register the guarded image route**

Register this exact route immediately after `/preview` so the two read surfaces stay adjacent:

```js
ctx.effect(() => webServer.register({
  kind: 'exact',
  path: `${ROUTE_PREFIX}/preview/image`,
  handler: async (req, res) => {
    if (!guard(req, res)) return;
    const request = requestAbort(req);
    try {
      const body = await readBody(req, 64 * 1024);
      if (typeof body.sessionId !== 'string' || body.sessionId === ''
        || typeof body.attachmentId !== 'string' || body.attachmentId === '') {
        send(res, 400, { error: 'preview-image-invalid' });
        return;
      }
      const state = await listArchived(ctx, registry, persistence, titleCache, metadataStore, pendingStore);
      if (!state.sessions.some((row) => row.id === body.sessionId)) {
        send(res, 404, { error: 'session-not-archived' });
        return;
      }
      const ref = findProjectedImage(await projectedMessages.get(body.sessionId), body.attachmentId);
      if (ref === null) {
        send(res, 404, { error: 'preview-image-not-found' });
        return;
      }
      const attachments = ctx.get('attachments');
      if (typeof attachments?.readImage !== 'function') {
        send(res, 503, { error: 'preview-image-unsupported' });
        return;
      }
      try {
        sendImage(res, await attachments.readImage(ref, request.signal));
      } catch (error) {
        if (request.signal.aborted) return;
        ctx.logger.warn(`archived-chats: preview image read failed for ${body.sessionId}: ${String(error?.code ?? error?.name ?? 'read-failed')}`);
        send(res, 500, { error: 'preview-image-failed' });
      }
    } catch (error) {
      if (request.signal.aborted) return;
      const status = error?.status ?? 500;
      send(res, status, { error: status === 413 ? 'request-too-large' : status === 400 ? 'preview-image-invalid' : 'preview-image-failed' });
    } finally {
      request.dispose();
    }
  },
}), 'archived-chats: preview image route');
```

Do not add `attachments` to the services required before route registration. Text preview must remain available when that optional service is absent.

- [ ] **Step 6: Run focused and full tests**

Run:

```bash
node --test test/smoke.test.mjs
npm test
```

Expected: both commands exit 0; success bytes and all four denial/degradation cases pass.

- [ ] **Step 7: Commit the authorized image route**

```bash
git add lib/index.js test/smoke.test.mjs
git commit -m "feat: serve authorized archived images"
```

---

### Task 3: Replace Generic Cards with the Native Role Layout

**Files:**
- Modify: `lib/client.js:18-24,77-95,513-531,1077-1165,2090-2100`
- Modify: `test/smoke.test.mjs:1160-1215,2140-2260`

**Interfaces:**
- Consumes: public module-loader exports `MarkdownText`, `DisclosureRow`, `JsonBlock`, and optional icons from `@deepseek-ai/dsh-client-ui-primitives`.
- Produces: `resolvePreviewPrimitives(requireFn)` returning a frozen public-primitive face with `null` for unavailable entries.
- Produces: `PreviewMessage`, `PreviewSegment`, and role-specific CSS; no private conversation component import.
- Preserves: existing `PreviewDialog` props and the left rail while changing transcript presentation.

- [ ] **Step 1: Add primitive stubs and failing native-layout assertions**

Extend `moduleTable` in `test/smoke.test.mjs`:

```js
function MarkdownTextStub(props) { return { type: 'markdown-stub', props }; }
function DisclosureRowStub(props) { return { type: 'disclosure-stub', props }; }
function JsonBlockStub(props) { return { type: 'json-stub', props }; }

moduleTable['@deepseek-ai/dsh-client-ui-primitives'] = {
  MarkdownText: MarkdownTextStub,
  DisclosureRow: DisclosureRowStub,
  JsonBlock: JsonBlockStub,
};
```

Change the `[11d]` preview payload to include user text plus assistant text and reasoning. After rendering `PreviewDialog`, add:

```js
const userRow = previewElements.find((element) => element.props?.['data-preview-role'] === 'user');
const assistantRow = previewElements.find((element) => element.props?.['data-preview-role'] === 'assistant');
assert(userRow?.props.className.includes('dac-preview-user'), 'preview aligns the user row with the native bubble treatment');
assert(assistantRow?.props.className.includes('dac-preview-assistant'), 'preview aligns the assistant row without a generic card');
assert(collectElements(userRow).some((element) => element.props?.className === 'dac-preview-user-bubble'), 'user text is wrapped by the native-style bubble');
assert(collectElements(assistantRow).some((element) => element.type === MarkdownTextStub), 'assistant text uses the host Markdown primitive');
assert(previewElements.some((element) => element.type === DisclosureRowStub), 'reasoning uses the host disclosure primitive');
assert(!previewElements.some((element) => element.props?.className === 'dac-preview-message'), 'generic preview cards are removed');
```

- [ ] **Step 2: Run the smoke test and observe generic-card output**

Run:

```bash
node --test test/smoke.test.mjs
```

Expected: FAIL because current rows all use `dac-preview-message` and text renders as plain `<p>`.

- [ ] **Step 3: Feature-detect only the public primitives**

Inside the client module factory, add:

```js
function resolvePreviewPrimitives(requireFn) {
  let source = null;
  try { source = requireFn('@deepseek-ai/dsh-client-ui-primitives'); } catch { source = null; }
  return Object.freeze({
    MarkdownText: typeof source?.MarkdownText === 'function' ? source.MarkdownText : null,
    DisclosureRow: typeof source?.DisclosureRow === 'function' ? source.DisclosureRow : null,
    JsonBlock: typeof source?.JsonBlock === 'function' ? source.JsonBlock : null,
    IconThink: typeof source?.IconThinkOutline14 === 'function' ? source.IconThinkOutline14 : null,
  });
}

const previewPrimitives = resolvePreviewPrimitives(require);
```

Do not require `@deepseek-ai/dsh-client-ui-conversation/client` and do not copy its hashed CSS class names.

- [ ] **Step 4: Implement role-specific segment components**

Add these stable boundaries before `PreviewDialog`:

```js
function PreviewMarkdown({ text, t, primitives = previewPrimitives }) {
  const MarkdownText = primitives.MarkdownText;
  if (MarkdownText === null) return (0, jsx.jsx)('p', { className: 'dac-preview-plain', children: text });
  return (0, jsx.jsx)(MarkdownText, {
    text,
    streaming: false,
    codeLabels: { copyLabel: t('preview.copy'), copiedLabel: t('preview.copied') },
  });
}

function PreviewReasoning({ text, t, primitives = previewPrimitives }) {
  const DisclosureRow = primitives.DisclosureRow;
  const [open, setOpen] = _react.useState(false);
  if (DisclosureRow === null) return (0, jsx.jsxs)('details', {
    className: 'dac-preview-disclosure',
    children: [(0, jsx.jsx)('summary', { children: t('preview.reasoning') }), (0, jsx.jsx)('div', { className: 'dac-preview-reasoning-body', children: text })],
  });
  return (0, jsx.jsx)(DisclosureRow, {
    title: t('preview.reasoning'),
    open,
    expandable: true,
    expandOnRowClick: true,
    onToggle: () => setOpen((value) => !value),
    children: (0, jsx.jsx)('div', { className: 'dac-preview-reasoning-body', children: text }),
  });
}
```

Implement `PreviewJson`, `PreviewSegment`, and `PreviewMessage` with these exact boundaries:

```js
function PreviewJson({ label, text }) {
  const JsonBlock = previewPrimitives.JsonBlock;
  let payload = text;
  try { payload = JSON.parse(text); } catch { /* escaped text fallback stays a string */ }
  if (JsonBlock !== null) return (0, jsx.jsx)(JsonBlock, { label: label || 'JSON', payload });
  return (0, jsx.jsx)('pre', { className: 'dac-preview-code', children: text });
}

function PreviewSegment({ segment, role, t }) {
  if (segment?.kind === 'text') {
    return role === 'assistant'
      ? (0, jsx.jsx)(PreviewMarkdown, { text: segment.text, t })
      : (0, jsx.jsx)('span', { className: 'dac-preview-plain', children: segment.text });
  }
  if (segment?.kind === 'reasoning') return (0, jsx.jsx)(PreviewReasoning, { text: segment.text, t });
  if (segment?.kind === 'json') return (0, jsx.jsx)(PreviewJson, { label: segment.label, text: segment.text });
  if (segment?.kind === 'image') return (0, jsx.jsx)('span', { className: 'dac-preview-image-placeholder', children: segment.text });
  return (0, jsx.jsxs)('details', { className: `dac-preview-disclosure${segment?.isError ? ' dac-error' : ''}`, children: [
    (0, jsx.jsx)('summary', { children: segment?.label || segment?.kind || 'unknown' }),
    (0, jsx.jsx)('pre', { className: 'dac-preview-code', children: segment?.text || '' }),
  ] });
}

function PreviewMessage({ node, t, bindNode }) {
  const role = ['user', 'assistant', 'tool'].includes(node?.role) ? node.role : 'system';
  const segments = (Array.isArray(node?.segments) ? node.segments : []).map((segment, index) => (0, jsx.jsx)(PreviewSegment, { segment, role, t }, `${node.key}:${index}`));
  return (0, jsx.jsxs)('article', {
    ref: bindNode,
    id: `dac-preview-node-${node.key}`,
    'data-preview-key': node.key,
    'data-preview-role': role,
    'aria-label': previewRoleLabel(t, role),
    tabIndex: -1,
    className: `dac-preview-node dac-preview-${role}`,
    children: [
      role === 'user' ? (0, jsx.jsx)('div', { className: 'dac-preview-user-bubble', children: segments }) : segments,
      (0, jsx.jsx)('div', { className: 'dac-preview-meta', children: formatDate(t, node.time) }),
    ],
  });
}
```

Replace the current message loop with `buildPreviewNodes(messages)` only after Task 4 adds that helper; during this task, map messages to `{ ...message, key: String(message.seq) }` and render `PreviewMessage`. Only user content receives `dac-preview-user-bubble`.

- [ ] **Step 5: Replace the generic-card CSS with native tokens**

Replace `.dac-preview-message*` rules with explicit selectors:

```css
.dac-preview-dialog{width:min(1120px,calc(100vw - 32px));height:min(820px,calc(100vh - 32px));padding:0;gap:0;overflow:hidden}
.dac-preview-column{width:100%;max-width:var(--dsh-chat-content-width,760px);margin:0 auto;display:flex;flex-direction:column;gap:16px}
.dac-preview-node{min-width:0;display:flex;flex-direction:column;gap:8px}
.dac-preview-user{align-items:flex-end}
.dac-preview-user-bubble{max-width:min(525px,82%);border-radius:22px;background:var(--dsw-specific-bubble);color:var(--dsw-alias-label-primary);padding:10px 16px;font-size:16px;line-height:24px;white-space:pre-wrap;overflow-wrap:anywhere}
.dac-preview-assistant{align-items:stretch;color:var(--dsw-alias-label-primary);font-size:16px;line-height:28px}
.dac-preview-tool,.dac-preview-system{align-items:stretch;color:var(--dsw-alias-label-secondary);font-size:14px;line-height:24px}
.dac-preview-meta{display:flex;gap:8px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.dac-preview-plain{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}
.dac-preview-disclosure{color:var(--dsw-alias-label-secondary)}
.dac-preview-reasoning-body{color:var(--dsw-alias-label-tertiary);white-space:pre-wrap;word-break:break-word;padding:4px 0 4px 22px;font-size:14px;line-height:24px}
.dac-preview-code{border:1px solid var(--dsw-alias-border-l1,var(--dsw-alias-border-l2));background:var(--dsw-alias-markdown-code-block,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-label-primary);border-radius:12px;padding:12px 16px;white-space:pre-wrap;overflow-wrap:anywhere}
```

Keep the feed and rail rules for Task 4. In the dialog header, render `t('preview.readOnly')` beneath the session title and add a smoke assertion for the localized read-only label.

- [ ] **Step 6: Add localized copy strings and test fallback mode**

Add `preview.copy`, `preview.copied`, `preview.imageUnavailable`, `preview.readOnly`, and tool-state strings to both locale dictionaries.

Expose `resolvePreviewPrimitives`, `PreviewMarkdown`, and `PreviewReasoning` through `exports.__test`. In the smoke test, call the resolver with `() => { throw new Error('missing'); }`, assert all entries are `null`, then render `PreviewMarkdown` through `createHookHarness` with `{ text: '<b>literal</b>', t, primitives: missingPrimitives }`. Assert the returned element is a `<p>` whose text is the literal `<b>literal</b>` string; do not mutate the factory-wide primitive face after module initialization.

- [ ] **Step 7: Run focused and full tests**

```bash
node --test test/smoke.test.mjs
npm test
```

Expected: both commands exit 0; user/right, assistant/left, Markdown primitive, reasoning disclosure, and safe fallback assertions pass.

- [ ] **Step 8: Commit the native message layout**

```bash
git add lib/client.js test/smoke.test.mjs
git commit -m "feat: match archived preview to native chat"
```

---

### Task 4: Correlate Tool Results and Keep an Active Turn Rail

**Files:**
- Modify: `lib/client.js:500-545,1030-1180`
- Modify: `test/smoke.test.mjs:2140-2280`

**Interfaces:**
- Consumes: structured `callId` and `toolCallId` from Task 1.
- Produces: `buildPreviewNodes(messages)`, an ordered visible-node array with matched tool results folded into their calls and unmatched results retained.
- Produces: `usePreviewRail(nodes, feedRef)`, returning `{ activeKey, bindNode }` and disconnecting its observer on unmount.
- Preserves: stable page order and existing rail numbers when later pages append.

- [ ] **Step 1: Add failing pure correlation assertions**

Expose `buildPreviewNodes` through `exports.__test`, then add:

```js
const correlated = clientExports.__test.buildPreviewNodes?.([
  { seq: 1, role: 'assistant', segments: [{ kind: 'tool-call', callId: 'call-a', name: 'read_file', argumentsText: '{}' }] },
  { seq: 2, role: 'tool', segments: [{ kind: 'tool-result', toolCallId: 'call-a', text: 'ok', isError: false }] },
  { seq: 3, role: 'tool', segments: [{ kind: 'tool-result', toolCallId: 'missing', text: 'orphan', isError: true }] },
]);
assert(correlated?.length === 2, 'tool correlation folds one matching result without hiding an orphan');
assert(correlated?.[0]?.segments[0]?.result?.text === 'ok', 'tool correlation attaches the matching result');
assert(correlated?.[1]?.segments[0]?.text === 'orphan', 'tool correlation retains an unmatched result');
```

- [ ] **Step 2: Run the smoke test and observe the missing helper**

Run `node --test test/smoke.test.mjs`.

Expected: FAIL because `buildPreviewNodes` is absent.

- [ ] **Step 3: Implement deterministic two-pass correlation**

Add this pure helper before `PreviewDialog`:

```js
function buildPreviewNodes(messages) {
  const results = new Map();
  const source = Array.isArray(messages) ? messages : [];
  for (let messageIndex = 0; messageIndex < source.length; messageIndex += 1) {
    const message = source[messageIndex];
    const sourceSegments = Array.isArray(message?.segments) ? message.segments : [];
    for (let segmentIndex = 0; segmentIndex < sourceSegments.length; segmentIndex += 1) {
      const segment = sourceSegments[segmentIndex];
      if (segment?.kind !== 'tool-result' || typeof segment.toolCallId !== 'string') continue;
      const queue = results.get(segment.toolCallId) ?? [];
      queue.push({ messageIndex, segmentIndex, segment });
      results.set(segment.toolCallId, queue);
    }
  }
  const consumed = new Set();
  const nodes = [];
  for (let messageIndex = 0; messageIndex < source.length; messageIndex += 1) {
    const message = source[messageIndex];
    const segments = [];
    for (let index = 0; index < (Array.isArray(message?.segments) ? message.segments.length : 0); index += 1) {
      const segment = message.segments[index];
      const identity = `${messageIndex}:${index}`;
      if (segment?.kind === 'tool-result' && consumed.has(identity)) continue;
      if (segment?.kind === 'tool-call' && typeof segment.callId === 'string') {
        const match = (results.get(segment.callId) ?? []).find((entry) => entry.messageIndex >= messageIndex
          && !consumed.has(`${entry.messageIndex}:${entry.segmentIndex}`));
        if (match !== undefined) {
          consumed.add(`${match.messageIndex}:${match.segmentIndex}`);
          segments.push({ ...segment, result: match.segment });
          continue;
        }
      }
      segments.push(segment);
    }
    if (segments.length > 0) nodes.push({ ...message, key: `${message.seq}:${messageIndex}`, segments });
  }
  return nodes;
}
```

- [ ] **Step 4: Render native-style tool disclosures**

Add `PreviewTool` using `DisclosureRow` when available and `<details>` otherwise. Its collapsed title is the tool name, its body shows `argumentsText`, and a matched `result` appears below with semantic error styling when `isError === true`. `JsonBlock` receives parsed JSON only when `JSON.parse` succeeds; invalid JSON stays escaped code text.

Use this implementation boundary:

```js
function previewJsonValue(text) {
  try { return JSON.parse(text); } catch { return text; }
}

function PreviewTool({ segment, t }) {
  const [open, setOpen] = _react.useState(false);
  const DisclosureRow = previewPrimitives.DisclosureRow;
  const JsonBlock = previewPrimitives.JsonBlock;
  const body = (0, jsx.jsxs)('div', { className: `dac-preview-tool-body${segment.result?.isError ? ' dac-error' : ''}`, children: [
    JsonBlock !== null
      ? (0, jsx.jsx)(JsonBlock, { label: t('preview.toolArguments'), payload: previewJsonValue(segment.argumentsText || '') })
      : (0, jsx.jsx)('pre', { className: 'dac-preview-code', children: segment.argumentsText || '' }),
    segment.result !== undefined && (0, jsx.jsx)('pre', { className: 'dac-preview-tool-result', children: segment.result.text || '' }),
  ] });
  if (DisclosureRow === null) return (0, jsx.jsxs)('details', { className: 'dac-preview-disclosure', children: [
    (0, jsx.jsx)('summary', { children: segment.name || t('preview.toolCall') }),
    body,
  ] });
  return (0, jsx.jsx)(DisclosureRow, {
    title: segment.name || t('preview.toolCall'),
    open,
    expandable: true,
    expandOnRowClick: true,
    onToggle: () => setOpen((value) => !value),
    children: body,
  });
}
```

Route `tool-call` segments to `PreviewTool`. Route unmatched `tool-result` segments to the same disclosure vocabulary with a localized `preview.toolResult` title and their own `isError` state.

Add smoke assertions that `read_file`, `README.md`, and the matched result appear once, and that an orphan result still appears.

- [ ] **Step 5: Add and test the read-only time/copy action row**

Expose `previewCopyText` through `exports.__test` and add:

```js
const copyNode = clientExports.__test.buildPreviewNodes([{
  seq: 7,
  role: 'assistant',
  segments: [
    { kind: 'text', text: 'answer' },
    { kind: 'tool-call', name: 'read_file', argumentsText: '{"path":"README.md"}', result: { text: 'contents' } },
  ],
}])[0];
assert(clientExports.__test.previewCopyText(copyNode) === 'answer\n\nread_file\n{"path":"README.md"}\ncontents', 'preview copy text follows visible segment order');
```

Implement the bounded visible-text transform and action row:

```js
function previewCopyText(node) {
  return (Array.isArray(node?.segments) ? node.segments : []).flatMap((segment) => {
    if (segment.kind === 'tool-call') return [segment.name, segment.argumentsText, segment.result?.text];
    return [segment.text];
  }).filter((value) => typeof value === 'string' && value !== '').join('\n\n');
}

function PreviewActions({ node, t }) {
  const [copied, setCopied] = _react.useState(false);
  const copy = async () => {
    const text = previewCopyText(node);
    const clipboard = typeof navigator === 'undefined' ? null : navigator.clipboard;
    if (text === '' || typeof clipboard?.writeText !== 'function') return;
    await clipboard.writeText(text);
    setCopied(true);
  };
  return (0, jsx.jsxs)('div', { className: 'dac-preview-actions', children: [
    (0, jsx.jsx)('time', { dateTime: Number.isFinite(node.time) ? new Date(node.time).toISOString() : undefined, children: formatDate(t, node.time) }),
    (0, jsx.jsx)('button', { type: 'button', onClick: copy, 'aria-label': copied ? t('preview.copied') : t('preview.copy'), children: copied ? t('preview.copied') : t('preview.copy') }),
  ] });
}
```

Render `PreviewActions` at the end of every user and assistant node. Add CSS that keeps it visually subdued, reveals it on `.dac-preview-node:hover` and `.dac-preview-node:focus-within`, and keeps the copy button keyboard reachable even when opacity is zero.

- [ ] **Step 6: Add failing active-rail tests**

Add a dedicated `MockIntersectionObserver` with captured callback, `observe`, `unobserve`, and `disconnect`. Render the preview with real node refs, trigger one entry with `{ isIntersecting: true, intersectionRatio: 0.8, target: secondNode }`, re-render, and assert:

```js
assert(secondRailButton?.props['aria-current'] === 'true', 'turn rail marks the currently visible node');
previewHarness.unmount();
assert(intersectionObserver.disconnected === true, 'turn rail disconnects its observer on unmount');
```

- [ ] **Step 7: Implement active-node observation and reduced-motion jumps**

Use a feed-rooted observer:

```js
function usePreviewRail(nodes, feedRef) {
  const [activeKey, setActiveKey] = _react.useState(nodes[0]?.key ?? null);
  const elements = _react.useRef(new Map());
  _react.useEffect(() => {
    const Observer = typeof window !== 'undefined' ? window.IntersectionObserver : null;
    if (typeof Observer !== 'function' || feedRef.current === null) return () => {};
    const observer = new Observer((entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting)
        .sort((left, right) => right.intersectionRatio - left.intersectionRatio)[0];
      if (visible?.target?.dataset?.previewKey) setActiveKey(visible.target.dataset.previewKey);
    }, { root: feedRef.current, threshold: [0.25, 0.5, 0.75] });
    for (const element of elements.current.values()) observer.observe(element);
    return () => observer.disconnect();
  }, [nodes]);
  return {
    activeKey,
    bindNode: (key) => (element) => {
      if (element === null) elements.current.delete(key);
      else elements.current.set(key, element);
    },
  };
}
```

Rail buttons set `aria-current={activeKey === node.key ? 'true' : undefined}` and call:

```js
function jumpToPreviewNode(node, keyboard) {
  const target = document.getElementById(`dac-preview-node-${node.key}`);
  const reduced = typeof window?.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  target?.scrollIntoView?.({ block: 'start', behavior: reduced ? 'auto' : 'smooth' });
  if (keyboard) target?.focus?.({ preventScroll: true });
}
```

Use `onClick: (event) => jumpToPreviewNode(node, event.detail === 0)`. Give each article `tabIndex: -1` so keyboard rail activation can focus it without adding transcript nodes to ordinary Tab order.

- [ ] **Step 8: Keep the rail desktop-left and narrow-top**

Retain the two-column dialog layout on desktop. Add:

```css
.dac-preview-rail button[aria-current="true"]{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover-solid);border-color:var(--dsw-alias-border-l2)}
@media (max-width:640px){
  .dac-preview-layout{grid-template-columns:minmax(0,1fr);grid-template-rows:auto minmax(0,1fr)}
  .dac-preview-rail{flex-direction:row;overflow-x:auto;border-right:none;border-bottom:1px solid var(--dsw-alias-border-l2)}
  .dac-preview-rail button{flex:none}
}
```

- [ ] **Step 9: Run focused and full tests, then commit**

```bash
node --test test/smoke.test.mjs
npm test
git add lib/client.js test/smoke.test.mjs
git commit -m "feat: correlate archive tools and track preview turns"
```

Expected: tests exit 0; matched results fold once, orphan results remain, active rail state updates, and observer cleanup runs.

---

### Task 5: Load and Release Archived Images in the Browser

**Files:**
- Modify: `lib/client.js:640-690,1000-1210,2090-2100`
- Modify: `test/smoke.test.mjs:1280-1360,2140-2300`

**Interfaces:**
- Consumes: `POST /preview/image` from Task 2.
- Produces: `fetchArchiveImage(sessionId, attachmentId, signal): Promise<Blob>`.
- Produces: `PreviewImage`, which lazily fetches, creates one object URL, aborts pending work, and revokes the URL on unmount.
- Produces: `groupPreviewSegments(segments)` so consecutive images render as one start/end-aligned gallery.

- [ ] **Step 1: Add a failing image-fetch boundary test**

Expose `fetchArchiveImage` through `exports.__test`. Extend the fetch stub so `/preview/image` returns a PNG Blob, then assert:

```js
const controller = new AbortController();
const imageBlob = await clientExports.__test.fetchArchiveImage?.('session-a', 'attachment-session-a', controller.signal);
const imageRequest = inspectRequests.at(-1);
assert(imageBlob?.type === 'image/png', 'preview image helper returns a browser Blob');
assert(imageRequest?.url === '/plugins/dsh-archived-chats/preview/image', 'preview image helper targets the image route');
assert(imageRequest?.options.method === 'POST', 'preview image helper uses POST');
assert(imageRequest?.options.headers['x-dsh-archived-chats'] === '1', 'preview image helper sends the guard header');
assert(imageRequest?.options.signal === controller.signal, 'preview image helper forwards cancellation');
assert(imageRequest?.options.body === '{"sessionId":"session-a","attachmentId":"attachment-session-a"}', 'preview image helper sends only session and attachment identity');
```

- [ ] **Step 2: Run the smoke test and observe the missing helper**

Run `node --test test/smoke.test.mjs`.

Expected: FAIL because `fetchArchiveImage` is absent.

- [ ] **Step 3: Implement the binary fetch boundary**

Add beside `fetchArchivePreview`:

```js
async function fetchArchiveImage(sessionId, attachmentId, signal) {
  const res = await fetch(`${API_BASE}/preview/image`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [GUARD_HEADER]: '1' },
    body: JSON.stringify({ sessionId, attachmentId }),
    signal,
  });
  if (!res.ok) {
    const parsed = await res.json().catch(() => ({}));
    const error = new Error(parsed.message || parsed.error || `HTTP ${res.status}`);
    error.body = parsed;
    throw error;
  }
  return res.blob();
}
```

- [ ] **Step 4: Add failing Blob URL lifecycle and fallback tests**

In `[11d]`, provide `windowMock.IntersectionObserver`, `windowMock.URL.createObjectURL`, and `windowMock.URL.revokeObjectURL` spies. Render an image segment with the Task 1 descriptor, trigger intersection, flush the fetch, and assert:

```js
assert(createdObjectUrls.length === 1, 'visible archived image creates one object URL');
assert(previewElements.some((element) => element.type === 'img' && element.props?.src === createdObjectUrls[0]), 'archived image renders verified bytes');
previewHarness.unmount();
assert(revokedObjectUrls.includes(createdObjectUrls[0]), 'closing preview revokes archived image URLs');
```

Repeat with a rejected image response and assert the localized `preview.imageUnavailable` placeholder is present while assistant text remains rendered.

- [ ] **Step 5: Implement lazy loading and unconditional cleanup**

Add `PreviewImage`:

```js
function PreviewImage({ sessionId, attachment, t }) {
  const rootRef = _react.useRef(null);
  const [state, setState] = _react.useState({ status: 'idle', url: null });
  _react.useEffect(() => {
    if (typeof attachment?.attachmentId !== 'string') return () => {};
    const controller = new AbortController();
    let objectUrl = null;
    let started = false;
    let disposed = false;
    let observer = null;
    const load = async () => {
      if (started) return;
      started = true;
      setState({ status: 'loading', url: null });
      try {
        const blob = await fetchArchiveImage(sessionId, attachment.attachmentId, controller.signal);
        if (disposed) return;
        objectUrl = (window.URL ?? URL).createObjectURL(blob);
        setState({ status: 'ready', url: objectUrl });
      } catch (error) {
        if (!controller.signal.aborted) setState({ status: 'error', url: null });
      }
    };
    const Observer = typeof window !== 'undefined' ? window.IntersectionObserver : null;
    if (typeof Observer !== 'function' || rootRef.current === null) void load();
    else {
      observer = new Observer((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          void load();
        }
      }, { rootMargin: '240px' });
      observer.observe(rootRef.current);
    }
    return () => {
      disposed = true;
      observer?.disconnect();
      controller.abort();
      if (objectUrl !== null) (window.URL ?? URL).revokeObjectURL(objectUrl);
    };
  }, [sessionId, attachment?.attachmentId]);

  const alt = attachment?.name || `${attachment?.width ?? '?'}×${attachment?.height ?? '?'}`;
  if (state.status === 'ready') return (0, jsx.jsx)('img', { ref: rootRef, src: state.url, alt, loading: 'lazy' });
  return (0, jsx.jsx)('span', { ref: rootRef, className: 'dac-preview-image-placeholder', children: state.status === 'error' ? t('preview.imageUnavailable') : alt });
}
```

- [ ] **Step 6: Group consecutive images and align by role**

Implement and expose:

```js
function groupPreviewSegments(segments) {
  const groups = [];
  for (let index = 0; index < (Array.isArray(segments) ? segments.length : 0); index += 1) {
    const segment = segments[index];
    if (segment?.kind !== 'image') { groups.push({ kind: 'segment', segment }); continue; }
    const images = [segment];
    while (segments[index + 1]?.kind === 'image') images.push(segments[++index]);
    groups.push({ kind: 'images', images });
  }
  return groups;
}
```

Render image groups inside `.dac-preview-images[data-align="end"]` for user nodes and `data-align="start"` for all others. Use a bounded grid, preserve aspect ratio, and cap each image to the transcript width and 420 pixels of height.

- [ ] **Step 7: Run focused and full tests, then commit**

```bash
node --test test/smoke.test.mjs
npm test
git add lib/client.js test/smoke.test.mjs
git commit -m "feat: render stored images in archive preview"
```

Expected: tests exit 0; guarded Blob fetch, lazy start, successful render, failure isolation, abort, and URL revocation assertions pass.

---

### Task 6: Complete Types, Documentation, Packaging, and Real-Host Verification

**Files:**
- Modify: `lib/types/index.d.ts`
- Modify: `lib/types/client/index.d.ts`
- Modify: `README.md:26-60,129-142`
- Modify: `README.en.md:26-60,129-142`
- Modify: `docs/ARCHITECTURE.md:20-58,128-142`
- Modify: `docs/ARCHITECTURE.en.md:20-58,128-142`
- Create after the real-host pass: `assets/screenshots/8-conversation-preview.png`

**Interfaces:**
- Consumes: all behavior completed in Tasks 1-5.
- Produces: accurate public declarations and user/maintainer documentation.
- Produces: fresh automated, packaging, endpoint, and real-host visual evidence for the completed 0.10.0 preview.

- [ ] **Step 1: Finalize public declarations**

In `lib/types/index.d.ts`, explicitly list `/preview/image`, state that the route is guarded and read-only, and document optional attachment-service degradation.

In `lib/types/client/index.d.ts`, replace “paginated conversation preview with timeline navigation” with a description that includes native user/right and assistant/left presentation, public Markdown/disclosure primitives, the retained responsive turn rail, and authorized stored images.

- [ ] **Step 2: Update user and architecture documentation**

Update both READMEs so the 0.10.0 release notes say:

- archive preview follows the Harness conversation layout;
- user messages are right-aligned and assistant messages are left-aligned;
- Markdown, reasoning, tool activity, JSON, code, and available stored images are presented read-only; and
- missing attachment capability affects images only.

Update both architecture documents with the exact `/preview/image` authorization sequence, public-primitive fallback rule, tool-correlation rule, Blob URL cleanup, and retained rail behavior.

- [ ] **Step 3: Run the complete automated verification**

```bash
npm test
npm pack --dry-run --json
git diff --check
```

Expected: `npm test` reports `fail 0`; dry-run packaging includes `lib/search.js`, the updated types/docs, and no temporary files; `git diff --check` prints nothing and exits 0.

- [ ] **Step 4: Restart the linked local Host and verify the served revision**

Confirm the profile still links the feature worktree:

```bash
dsh plugin --profile web list
```

Expected: `dsh-archived-chats` points to `.worktrees/session-time-machine`.

Stop any existing `dsh web` process with `SIGTERM`, start `dsh web` again, then load `http://127.0.0.1:3080/`. Confirm the boot payload contains a fresh `dsh-archived-chats/client.js?rev=...` value and that `POST /plugins/dsh-archived-chats/preview` no longer returns the old-method response.

- [ ] **Step 5: Perform the real-host visual and interaction matrix**

Using one archived conversation that contains user text, assistant Markdown, code, reasoning, a successful tool, a failed tool, and an image, verify each item in both light and dark themes:

1. user bubble is right-aligned and assistant prose is left-aligned;
2. assistant Markdown, table, links, and code copy affordance match the ordinary chat surface;
3. reasoning starts collapsed and is keyboard operable;
4. matching tool result folds into its call and an error uses the semantic error color;
5. image bytes load without revealing a filesystem path;
6. the rail jumps, follows scroll, exposes `aria-current`, and remains on the left;
7. at 640 pixels or narrower the rail moves above the feed and user bubbles keep useful width;
8. closing with Escape restores focus to the row eye button;
9. DevTools shows revoked Blob URLs are no longer used after closing; and
10. previewing does not change the archived ID set or sidebar.

Compare the same user and assistant messages in the ordinary Harness chat surface. Record any difference caused by an unavailable public primitive as an explicit fallback result; do not reach for a private renderer to remove it.

- [ ] **Step 6: Capture the verified preview and link it from both READMEs**

Capture the desktop light-theme real-host preview after Step 5 as:

```text
assets/screenshots/8-conversation-preview.png
```

Add the image immediately after the existing search screenshot in both READMEs with localized alt text. Do not generate or mock this screenshot; it must show the linked `0.10.0` build in the real Harness host.

- [ ] **Step 7: Re-run final verification after documentation and screenshot changes**

```bash
npm test
npm pack --dry-run --json
git diff --check
git status --short
```

Expected: tests report `fail 0`; the package contains the new screenshot and intended source/docs; whitespace check is clean; status contains only the planned Task 6 files.

- [ ] **Step 8: Commit the verified release documentation**

```bash
git add lib/types/index.d.ts lib/types/client/index.d.ts README.md README.en.md docs/ARCHITECTURE.md docs/ARCHITECTURE.en.md assets/screenshots/8-conversation-preview.png
git commit -m "docs: document native archived conversation preview"
```

- [ ] **Step 9: Confirm branch state without merging or publishing**

```bash
git status --short --branch
git log --oneline --decorate -8
```

Expected: `feature/session-time-machine` is clean and contains the design, plan, projection, image route, native client, image client, and documentation commits. Stop here for review; merging and publishing are separate user-authorized actions.
