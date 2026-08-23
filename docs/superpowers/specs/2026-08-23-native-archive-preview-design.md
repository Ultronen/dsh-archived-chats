# Native-Style Archived Conversation Preview Design

## Status

Approved product direction. This specification defines the read-only preview
redesign for `dsh-archived-chats` 0.10.0. It replaces the current generic card
timeline with a Harness-native conversation presentation while preserving the
left-side turn rail requested for archive navigation.

Implementation has not started. A separate implementation plan will follow
after this specification is reviewed.

## Context

The first 0.10.0 implementation added bounded archive preview and full-text
search, but its preview paints every projected event as the same bordered card.
That presentation does not match the ordinary Harness conversation surface:
user messages do not sit in right-aligned bubbles, assistant prose does not use
the native Markdown treatment, and reasoning and tool activity do not use the
native disclosure vocabulary.

The desired product behavior is a read-only version of the ordinary Harness
chat presentation:

- user messages appear on the right in the normal user bubble;
- assistant messages appear on the left with native Markdown typography;
- reasoning, tool calls, tool results, JSON, code, and images use the same
  visual language as the normal conversation;
- the existing left-side turn rail remains available for fast navigation; and
- previewing an archive never unarchives, opens, resumes, or mutates it.

## Compatibility Finding

`@deepseek-ai/dsh-client-ui-conversation` does not publicly export its internal
`ChatView`, `UserMessageNodeView`, `AssistantMarkdown`, or tool renderers. Its
public browser exports are the plugin application boundary and conversation
controller. The internal renderers also require a live session-scoped runtime,
stores, slot renderers, image loaders, navigation callbacks, and turn data.

Archived preview data comes from persistence inspection and deliberately is not
a live Harness session. Creating a fake session merely to mount private chat
components would couple the plugin to unstable implementation details and could
accidentally expose live-only actions.

The selected design therefore reuses public Harness presentation primitives
where they are available, reuses the official design tokens, and implements a
small read-only adapter for archived projections. It does not import or copy
private conversation components.

## Goals

1. Match the ordinary Harness conversation layout closely enough that archived
   preview feels like the same product surface.
2. Keep user messages right-aligned and assistant messages left-aligned.
3. Render Markdown, reasoning, tool activity, JSON, code, and stored images with
   native presentation primitives or compatible read-only fallbacks.
4. Preserve the left turn rail, add active-turn tracking, and keep keyboard and
   screen-reader navigation usable.
5. Read stored image bytes only through the official Harness attachment service.
6. Preserve all existing archive visibility, request-size, pagination,
   concurrency, cache, and partial-failure boundaries.
7. Keep the preview strictly read-only and independent of the live conversation
   lifecycle.

## Non-goals

- Mounting the private Harness `ChatView` or constructing a fake live session.
- Adding a composer, sending, steering, retrying, branching, editing, or tool
  inspection from the archive preview.
- Changing archive, unarchive, delete, export, import, metadata, or search
  semantics.
- Guessing attachment filesystem paths or issuing permanent attachment URLs.
- Reproducing streaming-only states for durable archived messages.
- Guaranteeing byte-for-byte DOM or CSS-class identity with a specific Harness
  build. The contract is visual and behavioral parity through public surfaces.

## Selected Approach

The preview remains a large modal inside the Archived Chats settings section.
Its body becomes a native-style transcript with a retained navigation rail.

The client attempts to use the host-provided public primitives required by the
ordinary conversation surface, including Markdown, disclosure, JSON, and icon
components. Primitive lookup is feature-detected so an older compatible host
cannot prevent the entire plugin from loading. When a primitive is unavailable,
the preview uses a safe local fallback that preserves content and layout without
rendering raw HTML.

The adapter owns only archive-specific concerns:

- converting bounded persistence projections to read-only view nodes;
- aligning roles in the transcript;
- correlating tool calls and results;
- loading authorized archived images;
- maintaining turn-rail state; and
- cleaning up preview-only browser resources.

## User Interface

### Dialog Shell

The preview uses a near-full-screen modal sized for the ordinary chat content
column. The header contains the archived session title, a localized read-only
preview label, and a close button. The dialog keeps the existing focus trap,
Escape handling, click-outside behavior, and focus restoration.

There is no composer or live-session action bar. Loading, empty, and fatal
preview errors occupy the transcript region without shifting the dialog shell.

### Transcript Layout

The transcript uses the same content-width token and 16-pixel flow rhythm as
the ordinary Harness chat when those tokens exist.

- **User:** a row aligned to the end. Its bubble is limited to
  `min(525px, 82%)`, uses the Harness bubble background token, 22-pixel radius,
  and native 16/24 text metrics.
- **Assistant:** a start-aligned, borderless row using native 16/28 Markdown
  typography. Assistant content is not wrapped in a generic card.
- **Tool:** a start-aligned disclosure row correlated with its result when the
  call ID is available. Error results use the semantic error token.
- **System/context:** a subdued full-width information row rather than a user or
  assistant bubble.
- **Unknown:** a bounded JSON disclosure that never injects untrusted HTML.

Message time and copy affordances follow the ordinary hover/focus pattern but
remain secondary to the transcript. Copy copies only the visible textual
message representation.

### Turn Rail

The left rail remains part of the preview. It is visually quieter than the
transcript and does not reduce the native chat content width.

- Every visible transcript node has a stable rail entry and DOM anchor.
- Clicking an entry scrolls its node into view and moves focus only when the
  action originated from keyboard navigation.
- An `IntersectionObserver` rooted at the transcript scrollport marks the
  currently read node with `aria-current` and an active visual state.
- Newly loaded pages append rail entries without renumbering existing entries.
- On narrow screens the rail becomes a compact horizontal strip above the
  transcript so user bubbles retain useful width.
- Reduced-motion preference disables smooth scrolling.

### Content Presentation

- Assistant text uses the public Harness Markdown renderer when available,
  including native code-block copy labels and table behavior.
- User text follows the ordinary user-bubble treatment. Consecutive image
  segments use an end-aligned gallery; assistant images use a start-aligned
  gallery.
- Reasoning uses the native disclosure primitive and is collapsed initially.
- Tool calls preserve tool name, call ID, arguments, completion state, result,
  and error state. A matching result is folded into the call disclosure. An
  unmatched result remains visible as a standalone degraded tool row.
- Structured or unknown values use the native JSON primitive when available.
- Image alternative text includes the safe display name and verified dimensions.

## Projection Contract

The existing `/preview` route remains a guarded POST and keeps its pagination
envelope. Its message payload becomes structured enough for native-style
presentation without returning raw persistence events.

Conceptually, one page contains:

```json
{
  "session": { "id": "session-id", "title": "Archived title" },
  "messages": [
    {
      "seq": 12,
      "time": 1787470000000,
      "role": "assistant",
      "source": "assistant",
      "segments": [
        { "kind": "text", "text": "Markdown text" },
        { "kind": "reasoning", "text": "Reasoning text" },
        {
          "kind": "tool-call",
          "callId": "call-1",
          "name": "read_file",
          "argumentsText": "{\"path\":\"README.md\"}"
        }
      ]
    },
    {
      "seq": 13,
      "time": 1787470001000,
      "role": "tool",
      "source": "tool",
      "segments": [
        {
          "kind": "tool-result",
          "toolCallId": "call-1",
          "text": "result",
          "isError": false
        }
      ]
    }
  ],
  "total": 2,
  "nextOffset": null
}
```

Image segments contain only a validated immutable reference descriptor:
attachment ID, verified media type, byte count, width, height, and optional safe
display name. Segment text and structured arguments remain subject to the
existing code-point bounds. Search continues indexing the bounded textual
representation and does not index binary image bytes.

Tool correlation is a client presentation transform over bounded projections.
It must preserve chronological order and cannot hide unmatched or malformed
results. The authoritative cache continues storing projections, not rendered
React nodes or attachment bytes.

## Attachment Read Path

A new guarded local route, `POST /plugins/dsh-archived-chats/preview/image`,
accepts a bounded JSON body containing `sessionId` and `attachmentId`.

Before returning bytes, the host:

1. applies the existing method, guard-header, and body-size checks;
2. rebuilds the current visible archive set and rejects unarchived,
   pending-deletion, or unknown sessions;
3. inspects that session and finds the exact attachment reference in an
   append-origin projected message;
4. rejects IDs that do not belong to that session;
5. feature-detects the official `attachments` service;
6. calls `ctx.attachments.readImage(ref, signal)`; and
7. returns the verified bytes using the service-returned media type and length.

The route never accepts a caller-supplied path or trusts caller-supplied media
metadata. It sends `Cache-Control: no-store` and aborts the attachment read when
the request is aborted. An unavailable attachment service returns a stable
unsupported response without affecting text preview.

The browser fetches images lazily as they approach the visible transcript,
creates object URLs, and revokes every URL on segment unmount, page replacement,
or dialog close. A failed image renders the descriptor as an accessible
placeholder and does not fail the page.

## Boundaries and Failure Behavior

- `/preview` and `/preview/image` expose only currently visible archived
  sessions.
- Pending deletions and unarchived sessions are unreadable through both routes.
- Projection retains append-origin semantics, so replacement copies are not
  shown or searched twice.
- Page size, segment size, request size, cross-session concurrency, TTL, LRU,
  and cached-code-point limits remain bounded.
- A malformed segment degrades to JSON; a malformed message does not remove
  unrelated messages.
- Primitive lookup failure selects the safe local renderer rather than failing
  plugin registration.
- Markdown is rendered only through the host primitive or as escaped plain
  text. The plugin never injects generated HTML.
- Attachment failures are isolated per image.
- Search excerpts and archive-list filtering remain unchanged by the preview
  redesign.

## Accessibility and Responsive Behavior

- The modal remains labelled, modal, keyboard-contained, and Escape-closeable.
- Close receives initial focus; closing restores focus to the originating row
  preview button or the page heading fallback.
- User, assistant, tool, and system roles have localized accessible labels even
  when visual labels match the ordinary minimal chat surface.
- Rail entries are real buttons with descriptive labels and `aria-current`.
- Disclosure rows are keyboard operable and expose their expanded state.
- Copy actions have localized labels and do not appear only on pointer hover.
- Narrow layouts preserve message alignment and move the rail above the feed.
- Light, dark, high-contrast token fallbacks, and reduced motion are covered.

## Implementation Boundaries

- `lib/search.js` extends the pure bounded projection with structured tool and
  image fields while retaining its current search text derivation and cache.
- `lib/index.js` keeps archive authorization at the host boundary and adds the
  official attachment-service read route.
- `lib/client.js` replaces only the preview presentation and adds the public
  primitive adapter, native-style transcript nodes, rail tracking, lazy image
  loading, and cleanup.
- `lib/types/index.d.ts` and `lib/types/client/index.d.ts` document the extended
  preview and attachment boundaries.
- `test/search.test.mjs` covers pure projection, correlation inputs, bounds, and
  malformed content.
- `test/smoke.test.mjs` covers route authorization, image reads, browser
  rendering, focus, cleanup, responsive rail behavior, and fallbacks.

No unrelated refactor of archive lifecycle, export/import, metadata, or list
management belongs in this increment.

## Testing Strategy

1. **Projection tests:** roles, Markdown text, tool IDs, result errors, image
   references, Unicode bounds, replacement exclusion, and malformed blocks.
2. **Host tests:** method and guard rejection, body limits, visible-archive
   authorization, cross-session attachment denial, verified headers and bytes,
   abort propagation, missing service, missing file, and corrupt attachment.
3. **Client tests:** user/right and assistant/left structure, native primitive
   selection, safe fallback selection, reasoning and tool disclosures, call
   correlation, copy behavior, rail jump/current state, image loading and URL
   revocation, focus restoration, and empty/error states.
4. **Regression suite:** all archive list, search, metadata, statistics,
   export/import, restore, unarchive, and delete tests remain green.
5. **Real-host pass:** on the installed Harness `0.1.1-rc.2`, compare ordinary
   and archived presentations in light, dark, desktop, and narrow layouts with
   user text, assistant Markdown, code, reasoning, tools, errors, and images.

## Acceptance Criteria

The redesign is ready when:

1. A user message is right-aligned in the native bubble and an assistant message
   is left-aligned with native Markdown presentation.
2. Reasoning, tool calls/results, JSON, code, and stored images follow the
   ordinary Harness visual language without exposing live actions.
3. The left turn rail remains usable, tracks the visible node, and adapts on
   narrow screens.
4. Preview and image reads cannot access unarchived, pending-deletion, unknown,
   or cross-session content.
5. Missing primitives, messages, attachment services, or attachment bytes
   degrade locally without disabling archive management.
6. Closing the preview restores focus and releases all preview-owned object URLs.
7. The full automated suite passes and a real Harness `0.1.1-rc.2` visual pass
   confirms the intended parity in light, dark, desktop, and narrow layouts.

## Rollout

This remains part of the unreleased 0.10.0 feature branch. The branch must not
merge or publish until the real-host visual pass is complete. Documentation and
screenshots should be updated only after that pass reflects the final native
preview rather than the superseded generic-card design.
