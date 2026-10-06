# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

A single-file IT PMO Kanban board: everything (CSS, HTML, JS) lives in `index.html`. There is no build step, package manager, linter, or test suite. To run it, open `index.html` in a browser (or serve the folder with any static server, e.g. `python -m http.server`).

Board data is held **in memory only**: a page refresh resets it to the seed tasks. There is no persistence layer by design (the UI shows a "Demo mode" note saying so).

## File layout

`index.html` is split into banner-commented sections (`/* ==== SECTION ==== */`), in order:
- **CSS**: design tokens on `:root` (palette, `--sp-*` spacing scale, radii, shadows), then base, header, filters, board/columns, cards, modal/form, toasts, responsive (columns stack below 768px), reduced-motion.
- **HTML**: header with summary strip, filter bar, four static `<section class="column" data-status="...">` columns, Add Task modal, toast region.
- **JS** (`'use strict'`, no framework, no modules): CONFIG → STATE → HELPERS → SEED DATA → FILTERING → RENDERING → ACTIONS → TOASTS → BOARD EVENTS → DRAG & DROP → FILTER EVENTS → MODAL → FORM → NETWORK → INIT.

Keep new code in the matching section and follow the existing style (CSS custom properties for colors/spacing, `escapeHtml()` on every interpolated value in template strings).

## Architecture

- **Single state object, full re-render.** `state` holds `tasks`, `filters`, `nextId`, and the per-card UI state `pendingDeleteId` / `openMoveId` (at most one card shows a Move menu or Delete confirmation). Every mutation updates `state` and then calls `renderBoard()`, which rebuilds every column's `innerHTML` from `state.tasks` and also refreshes the header summary. Do not patch card DOM directly.
- **Focus restoration.** Because re-rendering replaces card DOM, handlers call `focusInCard(id, selector)` or `focusColumnHeading(status)` afterwards to keep keyboard focus stable. Any new card-level action needs the same treatment.
- **Event delegation.** Card buttons carry `data-action="..."` and are handled in one `handleBoardClick` switch on `#board`. Drag-and-drop (native HTML5) is also delegated on `#board` and moves cards through the same `moveTask()` used by the keyboard-accessible Move menu.
- **Filtering** is a pure `applyFilters()` over `state.tasks`; column count badges show `visible / total` while filters are active.
- **Enumerations** (`STATUSES`, `PROJECTS`, `CATEGORIES`, `PRIORITIES`) are constants in CONFIG; selects are populated from them in `init()`, and `validateForm()` checks values against them. CSS classes and element IDs are derived with `slug()` (e.g. `"In Progress"` → `in-progress` → `#col-in-progress`, `#sum-in-progress`, `.dot-in-progress`, `.prio-*`, `.pill-*`). **Adding or renaming a status** therefore also requires editing the static column `<section>`, the summary `<li>`, the `.dot-*` CSS class, and the `.board` grid's `repeat(4, ...)`.
- **Dates** are local `YYYY-MM-DD` strings (`toISODate`, deliberately avoiding `toISOString()`'s UTC off-by-one) and are compared as strings. Seed due dates are offsets from today, so the demo always includes overdue items.
- **Task IDs** are `ITPM-0001`-style, from `formatId(state.nextId++)`.

## Email notification (FormSubmit)

On Add Task, the card is added optimistically first, then `notifyNewTask()` POSTs to FormSubmit's AJAX endpoint with a 15s `AbortController` timeout. Failures only produce a warning toast and never roll back the card. While a request is in flight (`state.inFlight`), the Add buttons are disabled.

- `FORMSUBMIT_ENDPOINT` at the top of the script is the **only** place the recipient email lives. It ships as the placeholder `YOUR_EMAIL@example.com`, which deliberately throws, so the warning toast is expected until it's configured.
- FormSubmit needs a one-time activation: the first submission to a new address sends a confirmation email, and nothing is delivered until that link is clicked. It can return HTTP 200 with `success: "false"`, which the code treats as a failure.
