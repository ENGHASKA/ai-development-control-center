# Dashboard design system

The dashboard is a tool people check from a phone between other work, so state comes first and decoration last. It builds on the existing token system in `dashboard/app/globals.css`; prefer those tokens over new values.

## Principles

- **Show state in words.** Color supports meaning and never carries it alone: every task state has an icon and a label.
- **Never imply capability.** A control that would be refused is removed or disabled with its reason on screen. Capabilities come from `lib/agent-capabilities.ts` and `/api/agents`.
- **Failure says what to do.** An error names what happened and the next action, without apology or error codes.
- **One thing at a time.** Scannable lists lead; details open on request.

## Color

Dark is the default: cool graphite rather than flat grey or black.

| Token | Dark | Light | Use |
|---|---|---|---|
| `--page` | `#17191d` | `#ffffff` | Reading surface |
| `--canvas` | `#121317` | `#f7f7f7` | Behind the page, sidebar |
| `--surface` | `#1f2227` | `#ffffff` | Raised controls and panels |
| `--field` | `#272b31` | `#f3f3f3` | Inputs and segmented tracks |
| `--ink` | `#e9ebef` | `#0d0d0d` | Primary text |
| `--ink-2` | `#b6bbc4` | `#4f4f4f` | Secondary text |
| `--ink-3` | `#9aa1ad` | `#6b6b6b` | Metadata |

Status tokens: `--accent-ink` active, `--orange-ink` needs you, `--red-ink` errors, `--green` healthy. Tints (`--orange-tint`, `--red-tint`) sit behind messages.

Measured contrast: ink on page 14.7:1 dark and 19.4:1 light; `--ink-3` on page 6.8:1 dark and 5.3:1 light; `--ink-3` on surface 6.1:1 dark; `--ink-2` on field 7.4:1 dark. `tests/contrast.test.ts` guards the palette.

## Type and spacing

Geist for interface text and JetBrains Mono for code, paths and logs. Page titles are 26px semibold, section labels 12 to 14px medium, body 14 to 15px. Inputs are 16px on phones so iOS doesn't zoom. Text is sentence case; loading labels end in an ellipsis character, and `tests/ui-copy.test.ts` enforces the copy rules.

## Components

| Component | Where | Use for |
|---|---|---|
| `Segmented` | `components/atoms/Segmented.tsx` | One choice from a few. Real radio buttons, so arrow keys and screen readers work |
| `Sheet` | `components/claude/Sheet.tsx` | Dialogs: centered on desktop, bottom sheet on phones, traps focus, restores it on close |
| `Select` | `components/claude/Select.tsx` | Longer choices, themed |
| `ProjectPicker` | `components/claude/ProjectPicker.tsx` | Choosing, creating and adding projects |
| `StateBadge` | `components/claude/TasksScreen.tsx` | Icon and word for a task state |

## Interaction

Touch targets are at least 44px on phones (`min-h-11`), with `.tap` extending smaller visual controls. Focus is always visible. Motion answers a person's action and respects reduced motion. Layouts keep safe-area padding (`safe-x` and `safe-top`) on a wrapper, because those classes set padding themselves and override spacing utilities on the same element.

## Layout

Phones put the project, run mode and composer in thumb reach at the bottom. Task lists are rows with hairline dividers rather than cards, so more fits on a screen and state lines up down the left edge.
