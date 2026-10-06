# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

A single-file IT PMO Kanban board: everything (CSS, HTML, JS) lives in `index.html`. There is no build step, package manager, linter, or test suite. To run it, open `index.html` in a browser (or serve the folder with any static server, e.g. `python -m http.server`).

Board data is held **in memory only**: a page refresh resets it to the seed tasks. There is no persistence layer by design (the UI shows a "Demo mode" note saying so).

## File layout

`index.html` is split into banner-commented sections (`/* ==== SECTION ==== */`), in order:
- **CSS**: design tokens on `:root` (orange `--brand-*` scale, `--st-*` status colours + `-bg` column tints, `--p-*` priority, health colours, `--sp-*` spacing, radii, shadows), then base, header, panels, analytics, delivery, filters, board/columns, cards, modal/form, toasts, responsive (columns stack below 768px; 44px targets on coarse pointers), reduced-motion.
- **HTML**: header with summary strip, **Board Analytics** panel, **Delivery Board** panel, filter bar, four static `<section class="column" data-status="...">` columns, Add Task modal (with honeypot field), toast region, chart tooltip.
- **JS** (`'use strict'`, no framework, no modules): CONFIG → STATE → HELPERS → SANITISATION → SEED DATA → FILTERING → ANALYTICS → RENDERING → ACTIONS → TOASTS → TOOLTIP → PANEL TOGGLES → BOARD EVENTS → DRAG & DROP → FILTER EVENTS → MODAL → FORM → NETWORK → INIT.

Keep new code in the matching section and follow the existing style (CSS custom properties for colors/spacing, `escapeHtml()` on every interpolated value in template strings).

## Architecture

- **Single state object, full re-render.** `state` holds `tasks`, `filters`, `nextId`, and the per-card UI state `pendingDeleteId` / `openMoveId` (at most one card shows a Move menu or Delete confirmation). Every mutation updates `state` and then calls `renderBoard()`, which rebuilds every column's `innerHTML` from `state.tasks` (sorted by priority, then due date, via `compareTasks`) and also refreshes the header summary, `renderAnalytics()` and `renderDelivery()`. Analytics and Delivery always use **all** tasks, not the filtered set. Do not patch card DOM directly.
- **Focus restoration.** Because re-rendering replaces card DOM, handlers call `focusInCard(id, selector)` or `focusColumnHeading(status)` afterwards to keep keyboard focus stable. Any new card-level action needs the same treatment.
- **Event delegation.** Card buttons carry `data-action="..."` and are handled in one `handleBoardClick` switch on `#board`. Drag-and-drop (native HTML5) is also delegated on `#board` and moves cards through the same `moveTask()` used by the keyboard-accessible Move menu.
- **Filtering** is a pure `applyFilters()` over `state.tasks`; column count badges show `visible / total` while filters are active.
- **Enumerations** (`STATUSES`, `PROJECTS`, `CATEGORIES`, `PRIORITIES`) are constants in CONFIG; selects are populated from them in `init()`, and `validateForm()` checks values against them. CSS classes and element IDs are derived with `slug()` (e.g. `"In Progress"` → `in-progress` → `#col-in-progress`, `#sum-in-progress`, `.seg-in-progress`, `.prio-*`, `.pill-*`). **Adding or renaming a status** therefore also requires editing the static column `<section>` (and its status icon), the summary `<li>`, the `--st-*` tokens plus the `.column[data-status=...]` and `.seg-*` rules, `WIP_LIMITS` if relevant, and the `.board` grid's `repeat(4, ...)`. Re-run the dataviz palette validator if you change status colours (they were chosen to pass its colour-blind checks).
- **Kanban rules.** `WIP_LIMITS` (In Progress 4, Blocked 3) drives the column WIP badge, the over-limit styling, the KPI tile and a warning toast in `moveTask()`. Delivery health is computed in `computeDelivery()`: Off track = overdue Critical/High or a blocked Critical task; At risk = anything overdue or blocked.
- **Charts** are plain HTML: stacked bars use `flex-grow` = count with 2px gaps, bar lists are single-series (one hue). Every mark has `data-tip` for the shared tooltip, and the same data is available in the "View analytics as tables" `<details>`. Status/health meaning is always carried by text + icon as well as colour.
- **Dates** are local `YYYY-MM-DD` strings (`toISODate`, deliberately avoiding `toISOString()`'s UTC off-by-one) and are compared as strings. Seed due dates are offsets from today, so the demo always includes overdue items.
- **Task IDs** are `ITPM-0001`-style, from `formatId(state.nextId++)`.

## Security model

The app is a static page with no backend, so its controls are client-side layers (threat-modelled with the `cybersecurity-analyst` skill):

- **Content-Security-Policy** `<meta>` at the top of `<head>`: `default-src 'none'`, scripts limited to the one inline script **pinned by SHA-256 hash**, `connect-src https://formsubmit.co` only, `base-uri`/`form-action` `'none'`. Inline event handlers and injected scripts are blocked even if escaping were ever missed.
- **After ANY edit to the `<script>` block you must recompute the hash**, or the browser refuses to run the app (blank board plus a CSP error in the console). Run this from the repo root:
  ```bash
  node -e 'const fs=require("fs"),c=require("crypto");let h=fs.readFileSync("index.html","utf8");const b=h.match(/\n<script>([\s\S]*?)<\/script>/)[1].replace(/\r\n?/g,"\n");const s=c.createHash("sha256").update(b).digest("base64");fs.writeFileSync("index.html",h.replace(/script-src '"'"'sha256-[^'"'"']*'"'"'/,"script-src '"'"'sha256-"+s+"'"'"'"));console.log(s)'
  ```
  The hash is taken over LF-normalised text, because browsers normalise CRLF before hashing. Don't write the literal string `<script>` in comments: the regex anchors on the real tag. CSS edits don't affect the hash.
- **Input handling**: `sanitizeText()` strips control, zero-width and bidi-override characters, collapses whitespace (which also blocks CR/LF email-header injection) and caps length. `validateForm()` allowlists every select value and restricts assignee characters. All output still goes through `escapeHtml()`, and toasts and the tooltip use `textContent`.
- **Notification abuse**: there's a honeypot field (`_honey`), and `reserveNotificationSlot()` allows at most 3 emails per minute. `notifyNewTask()` refuses any endpoint not starting with `FORMSUBMIT_PREFIX`, and sends with `credentials: "omit"`, `redirect: "error"` and a `strict-origin` referrer.
- **Drag and drop** only accepts the custom MIME type `application/x-itpm-task` with an ID matching `ID_PATTERN`, so text or files dragged in from elsewhere are ignored.
- **Known limitation**: `frame-ancestors` (clickjacking) can't be set from a meta tag, and GitHub Pages can't send custom headers.

## Email notification (FormSubmit)

On Add Task, the card is added optimistically first, then `notifyNewTask()` POSTs to FormSubmit's AJAX endpoint with a 15s `AbortController` timeout. Failures only produce a warning toast and never roll back the card. While a request is in flight (`state.inFlight`), the Add buttons are disabled.

- `FORMSUBMIT_ENDPOINT` at the top of the script is the **only** place the recipient email lives. It ships as the placeholder `YOUR_EMAIL@example.com`, which deliberately throws, so the warning toast is expected until it's configured.
- FormSubmit needs a one-time activation: the first submission to a new address sends a confirmation email, and nothing is delivered until that link is clicked. It can return HTTP 200 with `success: "false"`, which the code treats as a failure.

## Deployment (GitHub Pages)

`.github/workflows/pages.yml` deploys on every push to `main`: it copies only `index.html` into `_site/` and publishes it to https://super211.github.io/claude/ (Pages source = "GitHub Actions"). Any new site file must be added to the workflow's copy step. Unknown paths get GitHub's default 404 page. `index.html` uses an inline data-URI favicon so browsers don't request a missing `/favicon.ico`.

To republish elsewhere, run the project command `/publish-github <repo url>` (`.claude/commands/publish-github.md`): it scans for secrets, pushes, sets up the Pages workflow, and writes the README and repo About.

## Browser testing (Playwright MCP)

`.mcp.json` registers the Playwright MCP server at project scope (`cmd /c npx -y @playwright/mcp@latest`; the `cmd /c` wrapper is required on Windows). Use it to open `index.html` or the live Pages URL and exercise drag-and-drop, the Move menu, filters and the Add Task form in a real browser. It uses the installed Chrome by default.
