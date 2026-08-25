# Origins and Branches Redesign QA

- Source visual truth: `/var/folders/ys/gql_w5s5753b185hyw_l7j000000gn/T/codex-clipboard-0gTGFg.png`
- Source pixels: `1728 x 1428`
- Earlier layout reference: `/var/folders/ys/gql_w5s5753b185hyw_l7j000000gn/T/codex-clipboard-ClA9YR.png`
- Source role: the user's real leaf-only state and latest toolbar feedback; earlier references still ground card hierarchy and arrow behavior
- Product truth: managed objects are archived/recycled chats; active/missing ancestors are context only; unrelated active descendants are excluded
- Implementation URL: `http://127.0.0.1:64409/`
- Implementation full screenshot: `/private/tmp/dac-lineage-redesign-1470x712.png`
- Implementation leaf-only screenshot: `/private/tmp/dac-lineage-leaf-1470x712.png`
- Implementation focused screenshot: `/private/tmp/dac-lineage-redesign-panel.png`
- Implementation narrow panel screenshot: `/private/tmp/dac-lineage-redesign-narrow.png`
- Combined layout comparison: `/private/tmp/dac-lineage-redesign-comparison.png`
- Saved release screenshot: `assets/screenshots/14-origins-branches.png`
- Desktop viewport: `1470 x 712` CSS px at device scale factor 1
- Focused panel pixels/CSS size: `564 x 569` at device scale factor 1
- Narrow viewport: `600 x 900` CSS px; responsive panel width `504` CSS px
- State: release capture uses one active source context, two archived chats, and one recycled chat; the regression capture uses one active source context and two archived leaf chats

**Evidence**

- Default rendering contains `3` managed cards and no standalone source-context strip.
- The search field occupies its own full-width row; the project and status filters now render below it inside one compact flex group aligned flush right (`rightGap = 0`), with each native select filling its wrapper so the chevron stays inside the control.
- Fork source context is rendered inside the managed card, above the `从「…」分出` relationship line.
- Creation time and compact ID/copy actions share one footer row, with creation time left-aligned and ID actions right-aligned.
- Foldable cards place a small transparent accordion arrow in its own full-width row directly below the compact ID/Copy ID footer row; the connector rail contains only its guide and dot.
- The dedicated accordion row has no white fill, border, or shadow; it is a transparent centered arrow affordance.
- Clicking the foldable card body toggles exactly once; clicking the inline arrow stops bubbling, and clicking Copy ID does not toggle the card.
- Leaf-only data still renders the global control as a visible disabled `全部展开` button with `dac-chev open`; it no longer disappears when there is nothing to fold.
- Nested managed data exposes exactly one global fold button. Fully expanded state renders `全部折叠` with class `dac-chev collapse` (up); collapsed/mixed state renders `全部展开` with class `dac-chev open` (down).
- Per-node disclosure uses right-pointing chevrons when collapsed and down-pointing chevrons when expanded.
- Filtering to Recycle Bin leaves one recycled card plus the necessary source context and reports `1 个已管理会话`.
- Searching for `验收` preserves the matching archived child, its archived ancestor, and the necessary active source context, reporting two managed results.
- Desktop panel: `clientWidth = 564`, `scrollWidth = 564`; relationship list: `clientWidth = 564`, `scrollWidth = 564`.
- Narrow panel: `clientWidth = 504`, `scrollWidth = 504`; relationship list: `clientWidth = 504`, `scrollWidth = 504`.
- Browser console and page errors: none during navigation, filtering, searching, and responsive capture.
- Browser interaction contract: `3 → 2 → 3` list items for card collapse/expand; Copy ID remains at `3`; accordion computed style is transparent background, `0px none` border, and no shadow.
- Backend unit evidence proves an archived root does not pull in an ordinary active child, while an active intermediate node remains when it connects two managed nodes.

**Required Fidelity Surfaces**

- Fonts and typography: the implementation keeps the DSH inherited system stack, compact 11–13 px control/card text, semibold card titles, and readable 18–20 px line heights. No text is clipped in desktop or narrow captures.
- Spacing and layout rhythm: the crowded one-line toolbar was replaced by a full-width search row plus a compact right-aligned filter group. Managed cards now use a clear title/status row, relationship copy, and a left/right footer row; the accordion arrow sits directly under Copy ID without adding horizontal overflow.
- Colors and visual tokens: surfaces, borders, labels, accent, success, and danger states use DSH semantic tokens. The bottom scope bar uses a subtle accent-tinted surface rather than the source's unrelated integration CTA.
- Image quality and asset fidelity: the target contains no product imagery that belongs in this view. The implementation reuses existing DSH search, chevron, archive, and settings icons; the source's GitHub/Slack/Notion/Linear logos were intentionally excluded because the user rejected that content model.
- Copy and content: `来源于`, `活动会话，仅用于解释关系`, `已归档`, `回收站`, project/type/date metadata, compact IDs, and the scope note express the approved managed-object rules. Missing active titles use `来源信息不可用`, not an invented untitled chat.

**Findings**

- No actionable P0, P1, or P2 findings remain.
- [P3] The real DSH settings panel is much narrower than the Figma reference artboard, so cards carry two compact metadata lines rather than the reference's single long line. This is an intentional responsive adaptation.
- [P3] In the leaf-only state, the disabled `全部展开` control intentionally uses subdued contrast so it remains discoverable without competing with available actions.

**Comparison History**

- Pass 1: the original implementation used a bordered debug-like tree canvas, full-size gray active rows, `width:max-content`, and horizontal scrolling. It also included every active descendant of an archived focus node.
- Pass 2: introduced managed-only projection, compact context strips, status filtering, managed-result counts, outlined cards, and a bottom scope bar. Browser comparison found toolbar overlap in the real 564 px panel.
- Pass 3: moved fold controls into the list heading, tightened search/filter columns, hid fold controls when there were no managed branches, and added the accent-tinted scope bar. Desktop and narrow captures showed no overlap or horizontal overflow, but the hidden leaf-only control later proved too ambiguous.
- Pass 4: after the user's annotated toolbar review, placed search on its own row, made both filters equal-width, replaced two disabled-prone fold buttons with one dynamic control, and corrected global and per-node chevron directions. Browser evidence shows the intended text/icon transition and no overflow.
- Pass 5: after the user's real leaf-only screenshot, grouped project/status filters at the right edge and made the dynamic control permanently visible. Leaf-only data now shows disabled `全部展开`; nested data still transitions between `全部折叠`/up and `全部展开`/down.
- Pass 6: after the user's card-level review, removed standalone active-source rows, moved source copy into fork cards, moved creation time beside copy-ID actions, moved per-card disclosure into the card bottom-center accordion slot, and made both select arrows stay inside their native controls. Browser evidence shows no overflow.
- Pass 7: after the user's screenshot review, removed the accordion's white fill/border and made the whole foldable card clickable while stopping event bubbling for the arrow and Copy ID actions. Browser evidence confirms one-toggle behavior and transparent control styling.
- Pass 8: moved the transparent accordion arrow into its own full-width centered row below the ID/Copy ID footer, preserving first-row alignment, whole-card click toggling, and no horizontal overflow.

**Primary Interactions**

- Browser tested: navigation to Origins & Branches, right-aligned project/status filters with internal arrows, the leaf-only disabled expand state, dynamic collapse/expand text and arrow changes for nested data, transparent centered accordion disclosure in its own row below Copy ID, whole-card click toggling, event-bubbling isolation for arrow/Copy ID actions, in-card fork source copy, left/right footer alignment, text search, responsive reflow, and no-horizontal-overflow metrics.
- Automated tests: focused projection, necessary ancestor paths, active-descendant exclusion, project/status filtering, search path preservation, compact context rendering, disclosure semantics, copy ID, diagnostics, deep iterative rendering, and large-tree collapse defaults.
- Console checked: yes; zero new errors.

**Implementation Checklist**

- [x] Exclude unrelated active descendants from focused lineage projection.
- [x] Preserve active/missing ancestors only as necessary relationship context.
- [x] Replace untitled active-source fallbacks with explicit unavailable-source copy.
- [x] Add search, project/status filters, managed-result counts, and contextual fold controls.
- [x] Put search on its own row and group project/status filters compactly at the right edge.
- [x] Use one dynamic global fold button with collapse-up and expand-down arrows.
- [x] Keep that global button visible and disabled as `全部展开` when the tree has no foldable branches.
- [x] Keep per-node disclosure directions collapsed-right and expanded-down.
- [x] Render managed chats as compact cards with fork source copy inside the card; do not add standalone active-source rows.
- [x] Place creation time on the left and compact ID/copy actions on the right in one footer row.
- [x] Put per-card disclosure controls in their own centered row directly below the compact ID/Copy ID row rather than on the connector rail.
- [x] Keep the accordion arrow transparent with no white fill, border, or shadow.
- [x] Make the foldable card body clickable and prevent nested controls from toggling twice.
- [x] Remove horizontal scrolling at desktop and narrow widths.
- [x] Verify browser interactions, responsive layout, and console output.

final result: passed
