# ClipCargo Phase 3 Studio Design QA

## Evidence

- Source visual truth: `D:\GPTDocument\项目\CodingPro\ces\antigravity-first-analysis-recovery\ClipCargo-UI-Prototype-v2.html` and `ClipCargo-UI-Design-Spec-v2.md`.
- Implementation captures:
  - `reports/product-flow-audit-2026-11-10/130-studio-light-1180x740.png`
  - `reports/product-flow-audit-2026-11-10/131-studio-dark-1180x740.png`
  - `reports/product-flow-audit-2026-11-10/132-studio-light-960x620.png`
  - `reports/product-flow-audit-2026-11-10/133-studio-dark-960x620.png`
- Density: CSS pixel ratio 1; exact viewport sizes 1180 × 740 and 960 × 620.
- State: Studio active, original video selected, deterministic local-media decode fallback visible. The fallback intentionally exercises the compatibility-copy and system-player recovery controls.

## Visual comparison

The Studio retains the prototype's integrated title bar, 212 px sidebar at the primary size, two-column editing workspace, 306 px tool rail, compact information density, indigo `#515fd4` accent, restrained 8–12 px radii and shallow elevation. Light and dark captures use the same semantic tokens and preserve contrast without changing hierarchy.

At 960 × 620 the shell narrows the sidebar and processing rail, reduces the preview minimum height and keeps all nine processing modes plus the primary action visible. The notes surface is intentionally suppressed by the compact-height rule; keyboard marker capture remains active and the list returns above the 660 px height breakpoint. No controls overlap or escape the application frame.

## Functional fidelity

- Real `<video>` source path, VTT tracks, 0.5×–2× playback and decode recovery routes are wired to the existing commands.
- Asset switcher changes between original and derivative videos without leaving Studio.
- Timeline exposes a draggable playhead, independent In/Out handles, selection duration, cue markers and notes.
- Space, arrows, I, O and M are ignored while an editable control owns focus.
- The 9:16 frame and X/Y/zoom sliders share state; verified processing payload maps 25%, 70%, 145% to `0.25`, `0.7`, `1.45`.
- All nine existing FFmpeg modes remain available. Missing FFmpeg renders an installation route and disables submission; this is covered by the Studio smoke test.
- Auto-import stores the created derivative and triggers the existing editor-import command only after completion.
- Legacy `#player-backdrop` and `#process-backdrop` DOM and corresponding modal styles are absent.

## Interaction and runtime checks

- Switching to the derivative updates the heading to `竖屏成片示例`: passed.
- Adding a marker from the timeline while preventing `M` inside a note input: passed.
- Creating a crop task updates the shared mini-task capsule and preserves the selected crop recipe: passed.
- Background refresh defers while Studio is mounted or dragging, so playback position and pointer interactions are not reset.
- Browser console warnings/errors after the final light/dark and responsive pass: none.
- Static, state, command-contract, native-host and Rust tests: passed.

## Comparison history

1. Initial Studio pass retained the two legacy modal DOM blocks and the old placeholder route. Removed both overlays, their obsolete styling and the placeholder.
2. Processing submission could stay disabled in the browser harness when component state was initially unknown. Restricted the disabled state to an explicit `ffmpegReady === false` result.
3. Keyboard handling was checked with a focused note input; `M` no longer creates a marker there, while the timeline shortcut still does.
4. Final pass verified both themes at both required dimensions with no P0/P1/P2 visual or interaction defect remaining.

final result: passed
