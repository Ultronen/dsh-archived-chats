# Export and Backup 0.7.0 Design

## Status

Approved product direction. This specification defines the `0.7.0` increment:

- JSON is the authoritative machine-readable archive backup.
- Markdown is a human-readable transcript companion.
- One session and any selected set of sessions use the same ZIP package format.
- Import and restore are deferred to `0.8.0`.

## Context

`dsh-archived-chats` 0.6.0 can organize archived sessions with tags and notes and can report their storage size. It cannot preserve those sessions outside the Harness storage tree. Harness rc.7 has an official Session log export for a live conversation tree and its attachments, but that export does not understand this plugin's archived-session list, private metadata, storage statistics, or batch selection.

Version 0.7.0 therefore adds an archive-focused backup format without replacing or wrapping Harness's official raw Session export. The new format is designed so `0.8.0` can validate and import the JSON records later.

## Goals

1. Export one archived session from its row.
2. Export the current selected archived sessions as one ZIP file.
3. Preserve the complete inspected session metadata and event log in versioned JSON.
4. Preserve title, workspace, timestamps, origin, tags, note, metadata timestamp, and measured storage facts.
5. Include a readable Markdown transcript derived from Harness's canonical message projection.
6. Include a versioned manifest that inventories every session and file in the package.
7. Produce safe, deterministic paths even when titles are empty, hostile, duplicated, or exceptionally long.
8. Stream the ZIP response and retain at most one inspected session payload at a time during batch generation.
9. Keep export failures isolated from unarchive, delete, metadata editing, statistics, and ordinary archive listing.

## Non-goals

- Import, restore, merge, overwrite, or duplicate handling. These belong to `0.8.0`.
- Automatic or scheduled backups.
- Cloud upload, synchronization, encryption, or password-protected ZIP files.
- A replacement for Harness's official Session log export.
- Copying attachment binaries or descendant sessions. JSON retains durable attachment references, and the manifest explicitly records that attachment bytes are not included. Users who need an attachment-complete tree use the official Session log export.
- Exporting unarchived, pending-deletion, missing, or otherwise invisible sessions.
- Rendering a pixel-perfect copy of conversation cards in Markdown.

## Package Format

Every export downloads one ZIP. A single-session package and a batch package differ only in session count and outer filename.

```text
dsh-archived-chats-2026-08-19.zip
├── manifest.json
└── sessions/
    ├── 001-project-plan-a1b2c3d4/
    │   ├── session.json
    │   └── transcript.md
    └── 002-project-plan-f9e8d7c6/
        ├── session.json
        └── transcript.md
```

The folder prefix preserves requested order. The title portion is normalized for cross-platform filesystems, limited to 80 characters, and falls back to `untitled`. The final eight safe characters of the session ID disambiguate duplicate titles. If two normalized paths still collide, the later path receives `-2`, `-3`, and so on.

The outer filename is:

- one session: `dsh-archived-chat-<safe-title>-<YYYY-MM-DD>.zip`
- multiple sessions: `dsh-archived-chats-<count>-<YYYY-MM-DD>.zip`

HTTP uses both an ASCII `filename` fallback and RFC 5987 `filename*`, plus `Content-Type: application/zip`, `Cache-Control: no-store`, and `X-Content-Type-Options: nosniff`.

## JSON Schemas

### Manifest

`manifest.json` is formatted UTF-8 JSON with this version-one shape:

```json
{
  "format": "dsh-archived-chats/export",
  "version": 1,
  "exportedAt": "2026-08-19T12:00:00.000Z",
  "generator": {
    "name": "dsh-archived-chats",
    "version": "0.7.0"
  },
  "sessionCount": 1,
  "attachmentsIncluded": false,
  "sessions": [
    {
      "id": "session-id",
      "title": "Project plan",
      "workspace": {
        "id": "workspace-id",
        "title": "Plugin market"
      },
      "createdAt": 1787131200000,
      "origin": "user",
      "metadataUpdatedAt": "2026-08-18T12:00:00.000Z",
      "tags": ["important"],
      "note": "Keep this result.",
      "storage": {
        "status": "ready",
        "sizeBytes": 401600,
        "fileCount": 3
      },
      "files": {
        "json": "sessions/001-project-plan-a1b2c3d4/session.json",
        "markdown": "sessions/001-project-plan-a1b2c3d4/transcript.md"
      }
    }
  ]
}
```

Unavailable storage uses `status: "unavailable"`, `sizeBytes: null`, and `fileCount: null`. Missing workspace, creation time, origin, metadata timestamp, and note use JSON `null`; tags always use an array. Manifest order matches the user's submitted session order after duplicate IDs are removed.

### Session Record

Each `session.json` is formatted UTF-8 JSON:

```json
{
  "format": "dsh-archived-chats/session",
  "version": 1,
  "exportedAt": "2026-08-19T12:00:00.000Z",
  "archive": {
    "id": "session-id",
    "title": "Project plan",
    "workspace": {
      "id": "workspace-id",
      "title": "Plugin market"
    },
    "createdAt": 1787131200000,
    "origin": "user",
    "tags": ["important"],
    "note": "Keep this result.",
    "metadataUpdatedAt": "2026-08-18T12:00:00.000Z",
    "storage": {
      "status": "ready",
      "sizeBytes": 401600,
      "fileCount": 3
    }
  },
  "source": {
    "meta": {},
    "events": []
  }
}
```

`source.meta` and `source.events` are the values returned by `sessionPersistence.inspect(id)` without lossy transformation. The version and format fields let the future importer reject unknown schemas rather than guessing.

## Markdown Transcript

`transcript.md` begins with YAML front matter containing the same user-facing archive facts as the JSON record. String values are JSON-quoted inside YAML to avoid ambiguous punctuation or multiline injection.

The transcript uses only append-origin message-producing events. Harness documents those events as the durable human transcript: later model-surface replacement records may change future context, but must not erase content the user already saw. The exporter calls `isAppendSurfaceEvent(event)` and `deriveEventMessage(event)` from `@deepseek-ai/dsh-session` instead of maintaining a second event-schema parser.

Message headings are `## User`, `## Assistant`, and `## Tool result`, followed by the event timestamp when available. Content rendering is deterministic:

- text blocks become ordinary Markdown text;
- reasoning blocks use a `Reasoning` subsection and fenced text;
- tool calls show the tool name and raw JSON arguments in a fenced block;
- tool results recursively render their content and retain their call ID and error marker;
- image blocks emit a descriptive placeholder with name, media type, dimensions, byte length, and attachment ID;
- unknown future blocks are preserved as fenced JSON instead of being dropped.

Markdown is a viewing aid, not the restore source. A rendering failure for an unknown or malformed block falls back to JSON text for that block and does not mutate `session.json`.

## Architecture

### `lib/export.js`

A new focused host module owns all export-domain behavior:

- normalize safe ZIP paths and outer filenames;
- normalize archive descriptors for manifest/session schemas;
- render an inspected event log to Markdown using Harness projection helpers;
- write a sequential ZIP through `zip-stream`;
- expose stable validation errors for empty, oversized, missing, and no-longer-archived selections.

`zip-stream` is the only new ZIP dependency. Its entry callback makes serialization explicit: the exporter appends the manifest, inspects one session, appends that session's JSON and Markdown, releases the payload, and only then inspects the next session. It never accumulates every event log in a batch.

### `lib/index.js`

The existing host entry remains the composition and HTTP boundary. It gains one read-only route:

```text
POST /plugins/dsh-archived-chats/export
```

The request uses `application/x-www-form-urlencoded` so a native browser form can initiate a streamed download without buffering the ZIP into a JavaScript `Blob`:

```text
sessionIds=["session-a","session-b"]
```

The host limits the raw form body to 512 KiB, requires one to 2,000 unique string IDs, and rejects malformed input with a plain UTF-8 HTTP 400 response. It snapshots the currently visible archived rows, rejects any requested ID not in that snapshot with HTTP 404, measures storage using the existing statistics service, and starts the ZIP only after request validation succeeds.

The route is read-only and does not require the mutation-only `x-dsh-archived-chats` guard. A cross-origin page cannot read the attachment response, while the native form keeps the actual download bounded-memory in the browser.

If the request is invalid or the first session cannot be inspected before headers are sent, the host returns a normal error response. The first inspected payload is held until ZIP streaming starts; later sessions are still loaded only when their turn arrives. If a later persistence read or socket failure happens after ZIP streaming begins, the host logs only the session ID and stable error code, destroys the incomplete response, and never changes archive state.

### `lib/client.js`

The existing settings section gains:

- a download icon button on every row with the localized label `Export backup`;
- an `Export selected` action in the existing selection bar;
- a top-level `Export all` action when no selection bar is active.

All three call one browser helper that creates a temporary hidden form, writes the JSON ID array into a hidden field, submits it to the same-origin export route, and removes the form on the next task. There is no client-side ZIP buffering and no export modal. The action announces `Download started` through the existing transient notice system. Empty selections remain disabled.

On narrow screens, row actions retain fixed icon-button dimensions and the selection bar wraps its text actions without overlapping the list. The new icon uses the host icon library's download glyph when available and a small code-native fallback consistent with the existing row actions.

## Data Flow

1. The user clicks a row, selection, or all export action.
2. The browser submits a hidden same-origin form containing ordered session IDs.
3. The host parses and validates the bounded form body.
4. The host snapshots visible archive rows and rejects stale or hidden IDs.
5. The host resolves storage facts and prepares collision-free package paths.
6. The host starts the ZIP response and writes `manifest.json`.
7. For each session in order, the host calls `sessionPersistence.inspect(id)`, writes `session.json`, renders and writes `transcript.md`, then releases that inspected payload.
8. `zip-stream` finalizes the central directory and the browser download manager saves the response.

## Failure Handling and Safety

- Export is read-only: it never writes session logs, metadata, statistics, or pending-deletion state.
- IDs must be currently visible archived sessions; pending-deletion and unarchived sessions cannot be exported through this route.
- Request size and session count are bounded before persistence reads begin.
- ZIP entry paths never contain absolute roots, `..`, control characters, Windows reserved characters, or user-provided separators.
- Duplicate IDs are removed in first-seen order; duplicate titles cannot overwrite package entries.
- JSON escaping is delegated to `JSON.stringify`; Markdown metadata is quoted and message content is never interpreted as HTML by this plugin.
- Session note contents and transcript contents are never written to logs.
- A corrupt metadata store behaves as it does in 0.6.0: visible sessions export with empty tags and note plus the unavailable metadata status; export never rewrites the store.
- Statistics failure is represented as unavailable and does not prevent backup.
- Client form cleanup does not cancel the native browser download.
- The response listens for aborted sockets and destroys the ZIP stream so work stops after navigation or cancellation.

## Testing Strategy

### Export Unit Tests

- Safe path generation covers slashes, traversal text, control characters, reserved names, Unicode, empty titles, long titles, duplicate titles, and collision suffixes.
- Manifest/session JSON preserves literal metadata, storage facts, inspected meta, and events with version-one format markers.
- Markdown renders user, assistant, reasoning, tool call, tool result, image, and unknown blocks; replacement events do not erase append-origin transcript content.
- ZIP output contains one manifest and exactly two entries per requested session in deterministic order.
- The exporter calls `inspect` serially and does not request the next session until the previous entries finish.
- A mid-stream inspection failure aborts the archive and never inspects later sessions.

### Host Integration Tests

- The export route registers alongside the existing seven routes.
- Malformed form bodies, empty selections, more than 2,000 IDs, non-string IDs, and bodies over 512 KiB return 400.
- Unknown, unarchived, and pending-deletion IDs return 404 before ZIP headers.
- A valid single and batch request returns attachment headers and a readable ZIP.
- Duplicate IDs export once in first-seen order.
- Export never calls metadata mutation, delete, unarchive, or registry write paths.

### Client Smoke Tests

- Row, selected, and all export controls render with localized labels.
- Each control submits the correct ordered IDs to the export route through a temporary form.
- Export controls disable for empty or busy scopes without disabling existing lifecycle actions.
- The selection bar remains usable at desktop and narrow widths.
- Existing search, filtering, sorting, metadata, statistics, unarchive, delete, accessibility, theme, and rc.7 compatibility tests remain green.

### Release Verification

- Full `npm test` and syntax checks.
- `npm pack --dry-run --json` includes `lib/export.js`, the client/host bundles, types, and no development `data/`.
- A real Harness rc.7 host returns a readable ZIP for one archived session and a multi-session selection.
- The ZIP is opened independently and its manifest entry paths are checked against the central directory.
- Real-host light/dark and narrow-screen visual checks confirm that export controls do not overlap existing actions.

## Compatibility and Rollout

- Minimum runtime remains DeepSeek Harness `0.1.0-rc.7` and Node.js 18, matching `zip-stream` 7.x.
- `@deepseek-ai/dsh-session` `^0.1.0-rc.7` is a runtime dependency for canonical transcript projection.
- The export format begins at version 1 and is independent from the npm package version.
- Version 0.7.0 adds no migration and does not change metadata schema version 1.
- Version 0.8.0 will treat only `dsh-archived-chats/session` version 1 JSON as an import candidate and will define conflict, workspace, attachment, and restore policies in a separate specification.
