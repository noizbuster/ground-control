<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30 | Updated: 2026-07-30 -->

# ui

## Purpose

OpenTUI functional view layer for gctrl: session grid/cards, detail dashboard, hierarchy tree/timeline. Components return `Box`/`Text` trees; `src/index.ts` owns renderer lifecycle and swaps **content** factories into ScrollBoxes. Empty barrel — import concrete modules.

## Key Files

| File | Description |
|------|-------------|
| `index.ts` | Empty barrel (`export {}`) |
| `SessionGrid.ts` | `createSessionGridContent` virtualized wrap grid + `SessionGrid` ScrollBox shell; `getGridColumnCount` (max 4) |
| `SessionCard.ts` | Per-session card; `SESSION_CARD_MAX_HEIGHT = 15`; waiting/stall/recent edges; agent-colored border |
| `DetailPanel.ts` | `createDetailPanelContent` metrics/related sessions + DetailPanel ScrollBox; `getDetailPanelContentWidth` |
| `HierarchyView.ts` | Tree/timeline hierarchy renderers; timeline anchor/width helpers |
| `sessionAgentDisplay.ts` | `getSessionAgentDisplayName`: root unknown → "Default", else "Unknown" via config colors |

## Subdirectories

_None._

## For AI Agents

### Working In This Directory
- Pattern: `createXContent(props)` pure tree + optional `X({ scrollBoxId, … })` shell with `ScrollBox`.
- Size type: `number | \`${number}%\` | "100%"`.
- Grid virtualization: row stride = `SESSION_CARD_MAX_HEIGHT(15) + SESSION_GRID_ROW_GAP`; buffer ±2 rows; spacer Boxes; when `viewportHeight === 0` render all.
- `getGridColumnCount`: non-finite width → 1 column; max 4; min card width 30.
- SessionCard edge priority: **awaiting-user > stall/blocked > recently completed > agent color**.
- Hierarchy lines from `lib/hierarchyHelpers`; timeline uses scroll-left + viewport width.
- Detail two-column layout when width ≥ 96.
- Keep display logic in lib (`getStatusLabel`, stall, source chrome); UI composes only.
- Agent colors only through `config/colors` / `sessionAgentDisplay`.

### OpenTUI usage patterns
```ts
import { Box, Text, ScrollBox, bold, dim, fg, t, MouseButton } from "@opentui/core";
Text({ content: t`${dim("label")} ${bold(value)}`, fg: "#E2E8F0" })
Box({ flexDirection: "column" | "row", flexWrap: "wrap", width, height, rowGap, columnGap, backgroundColor, borderColor }, ...children)
```
- Functional components (not classes).
- Local `*_COLORS` + status maps as `#${string}` hex.
- Default export often aliases the main shell component.

### Testing Requirements
- `test/sessionCard.test.ts`, `gridScroll`/`gridColumnCount`, `scrollSectionBorders`, hierarchy width helpers.
- Interaction: `detailTextSelection.test.ts` with `@opentui/core/testing` + `ffi-register.mjs` import first.
- Prefer pure content-factory tests over full app mount.

### Common Patterns
- Content factory vs shell split for efficient re-render from `index.ts` `replaceChildren`.
- Mouse: cards use `MouseButton`; hierarchy may expose `onCopyId`.
- Do not import empty `index.ts` expecting exports.

## Dependencies

### Internal
- `../config/colors`
- `../lib/{hierarchyHelpers,sessionSource,stallDetection,recentCompletion,gridScroll}`
- `../types`
- Sibling ui modules (`sessionAgentDisplay`, card constants)

### External
- `@opentui/core` only

### Consumers
- Primarily `src/index.ts`; `lib/gridScroll` reads layout constants

<!-- MANUAL: -->
