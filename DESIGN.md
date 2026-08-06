---
name: Telegram Poll Manager
description: An airport operations ledger for managing GTRSG Telegram shift polls.
colors:
  operations-ink: "#142a33"
  operations-ink-secondary: "#203d48"
  roster-paper: "#f5f7f6"
  docket-sheet: "#ffffff"
  rule-line: "#cbd5d8"
  rule-line-soft: "#e2e8e9"
  muted-copy: "#586b73"
  operational-green: "#008a68"
  operational-green-deep: "#006c52"
  operational-green-soft: "#e1f3ed"
  operational-amber: "#b87600"
  operational-amber-soft: "#fff3d6"
  operational-red: "#bd3e33"
  operational-red-soft: "#fbe9e6"
typography:
  display:
    fontFamily: "Barlow Condensed, Arial Narrow, sans-serif"
    fontSize: "clamp(1.55rem, 3vw, 2rem)"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "0"
  title:
    fontFamily: "Barlow Condensed, Arial Narrow, sans-serif"
    fontSize: "1.1rem"
    fontWeight: 700
    letterSpacing: "0"
  body:
    fontFamily: "Source Sans 3, Segoe UI, sans-serif"
    letterSpacing: "0"
  label:
    fontFamily: "Barlow Condensed, Arial Narrow, sans-serif"
    fontSize: "0.76rem"
    fontWeight: 700
    letterSpacing: "0"
rounded:
  status: "2px"
  control: "3px"
  overlay: "4px"
spacing:
  compact: "0.65rem"
  control: "0.75rem"
  standard: "1rem"
  section: "1.35rem"
  workspace-top: "1.75rem"
components:
  button-primary:
    backgroundColor: "{colors.operational-green}"
    textColor: "{colors.docket-sheet}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    height: "2.55rem"
  button-secondary:
    backgroundColor: "{colors.docket-sheet}"
    textColor: "{colors.operations-ink-secondary}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    height: "2.55rem"
  docket-band:
    backgroundColor: "{colors.docket-sheet}"
    textColor: "{colors.operations-ink}"
    rounded: "0"
    padding: "{spacing.section}"
  form-control:
    backgroundColor: "{colors.docket-sheet}"
    textColor: "{colors.operations-ink}"
    rounded: "{rounded.control}"
  navigation:
    backgroundColor: "{colors.operations-ink}"
    textColor: "{colors.docket-sheet}"
    height: "64px"
---

# Design System: Telegram Poll Manager

## Overview

**Creative North Star: "Movement Roster"**

Movement Roster treats Telegram poll scheduling as an airport operations ledger. It is an Operate-mode interface for GTRSG airline relationship managers: compact, procedural, highly scannable, and explicit about every relationship between an approved user, assigned bot, Telegram group, template, poll, and deployment.

The visual world combines deep ink navigation, cool paper-grey workspaces, ruled white docket bands, technical airport line-art, operational green signals, and restrained structural depth. It rejects a generic floating-card dashboard in favour of full-width ledger sections, squared controls, dense tables, and clear state changes.

**Key Characteristics:**
- Deep-ink 64px navigation with active-route underlines.
- Shallow illustrated mastheads using `/assets/airport-operations-linework.png`.
- Ruled, full-width docket bands instead of floating cards.
- Barlow Condensed for headings, labels, navigation identity, and commands.
- Source Sans 3 for instructions, values, supporting copy, and records.
- Operational green for readiness, selection, focus, and primary action.
- Depth concentrated on navigation, primary actions, menus, and overlays.

## Colors

The palette resembles cool roster paper marked with dark ink and restrained operational signals.

- **Operational Green** (`#008a68`): Primary actions, active markers, avatars, focus borders, and selected-row rules.
- **Operational Green Deep** (`#006c52`): Hovered primary actions and successful status text.
- **Operational Green Soft** (`#e1f3ed`): Hovered rows, secondary-action hover, and positive state fields.
- **Operational Amber** (`#b87600`) and **Amber Soft** (`#fff3d6`): Warning and pending states.
- **Operational Red** (`#bd3e33`) and **Red Soft** (`#fbe9e6`): Errors, destructive actions, and failure states.
- **Operations Ink** (`#142a33`): Navigation, table headers, and primary text.
- **Roster Paper** (`#f5f7f6`): Workspace background.
- **Docket Sheet** (`#ffffff`): Forms, tables, dialogs, and ledger bands.
- **Muted Copy** (`#586b73`): Hints, supporting copy, and empty states.
- **Rule Line** (`#cbd5d8`) and **Rule Line Soft** (`#e2e8e9`): Container and internal dividers.

**The Signal Discipline Rule.** Green, amber, and red communicate action or operating state; they are not decorative page fills.

## Typography

**Display Font:** Barlow Condensed, with Arial Narrow and sans-serif fallbacks.  
**Body Font:** Source Sans 3, with Segoe UI and sans-serif fallbacks.

Condensed headings and labels evoke manifests, movement boards, and printed operating forms. Source Sans 3 keeps dense instructions and records readable.

- **Display** (700, `clamp(1.55rem, 3vw, 2rem)`, 1.2): Page mastheads.
- **Title** (700, `1.1rem`): Docket and workflow headings.
- **Body** (Source Sans 3): Instructions, values, records, and supporting copy.
- **Label** (700, `0.76rem`, zero tracking): Form labels and operating metadata.
- **Ledger Metadata** (700, `0.66rem`): Uppercase compact operating terms.

**The Condensed Command Rule.** Use Barlow Condensed for commands and hierarchy, not for long explanatory passages.

## Layout

The desktop workspace is `min(1180px, calc(100% - 2.5rem))` with `1.75rem` top padding. The masthead is `8.25rem` high, reserves 47% of its width for technical line-art, and ends with a 3px operational-green rule.

Sections are full-width white docket bands with `1.35rem` padding and 1px top and bottom rules. Cards do not float. Managed groups and workflow commands are vertically ruled rows, with the managed-group roster immediately following the page masthead.

At `760px`, rule ledgers collapse to one column. At `720px`, the workspace becomes `calc(100% - 1rem)` and the masthead reserves 39% for artwork. At `520px`, the brand contracts to its mark, masthead artwork is removed, and section padding becomes `1rem`.

## Elevation & Depth

The system is flat by default. Structure comes from ink bands, tonal paper layers, 1px rules, and green inset selection bars. Shadows are reserved for elements that genuinely sit above or initiate action.

- **Low:** `0 5px 14px rgba(20, 42, 51, 0.08)`.
- **Mid:** `0 14px 34px rgba(20, 42, 51, 0.14)` for account menus.
- **High:** `0 26px 70px rgba(8, 23, 29, 0.28)` for dialogs.
- **Navigation:** `0 8px 24px rgba(8, 23, 29, 0.18)`.
- **Primary Action:** `0 5px 12px rgba(0, 108, 82, 0.18)`.

**The Structural Depth Rule.** Do not add shadows to ordinary docket bands, tables, filters, roster rows, or previews.

## Shapes

The form language is compact and squared. Status pills use 2px corners, controls and framed ledgers use 3px, and navigation marks, menus, mastheads, and overlays use 4px. Full-width docket bands and roster rows use square corners. Borders are generally 1px and use the rule-line palette.

## Components

### Buttons
Primary buttons use operational green, white text, 3px corners, condensed bold type, and restrained action depth. Secondary buttons are white with a `#9db2b7` border and ink-secondary text. Focus uses a 3px `rgba(0, 138, 104, 0.28)` outline.

### Cards / Containers
Cards are full-width docket bands with white fill, square corners, `1.35rem` padding, and `#cbd5d8` top and bottom rules.

### Inputs / Fields
Inputs and selects use white fill, `#afbec2` 1px borders, 3px corners, and `inset 0 1px 2px rgba(20, 42, 51, 0.06)`. Read-only fields use `#edf1f1`.

### Navigation
Navigation is a 64px operations-ink band. Links are square, full-height cells. Hover and active states use `#1d3843`; the active route adds a 3px `#31bd92` bottom rule.

### Tables and Rosters
Tables use an operations-ink header, soft ruled rows, alternating bands, and green-soft hover. Managed-group rows use border-separated white bands and an inset green selection rule.

### Command Dialog
The group command dialog is `min(92vw, 570px)` with 4px corners and high elevation. Workflow choices are `4.75rem` ruled rows.

## Do's and Don'ts

### Do:
- Treat every screen as a scan-first operating record.
- Use ruled full-width bands, compact controls, and dense tables.
- Reserve operational colours for actions, focus, status, and selection.
- Preserve the one-user, one-bot, many-groups hierarchy visually.
- Retain reduced-motion behavior.

### Don't:
- Turn workflow sections into floating rounded cards.
- Use decorative gradients, oversized radii, or ornamental colour fields.
- Add shadows where rules and tonal layers already establish structure.
- Use Barlow Condensed for long instructions or record values.
- Expose cross-user controls to non-admin users.
