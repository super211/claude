---
description: Scan for secrets, push to GitHub, deploy GitHub Pages via Actions, write README, set repo About
argument-hint: <github repo URL or owner/repo>
---

Publish this project to GitHub. Target repository: **$ARGUMENTS**

If `$ARGUMENTS` is empty, ask the user for the GitHub repo URL (or `owner/repo`) before doing anything else. Normalise it to `OWNER/REPO` and `https://github.com/OWNER/REPO.git`. The Pages URL is `https://OWNER.github.io/REPO/` (or `https://OWNER.github.io/` when REPO is `OWNER.github.io`).

Work through the steps in order. Stop and report if a step fails; do not skip ahead. The secret scan (step 1) always runs **before** anything is pushed.

## 1. Scan for sensitive data (blocking)

Scan every file that would be committed: tracked files plus untracked files that `.gitignore` doesn't exclude (`git ls-files -co --exclude-standard`, or the whole folder if it isn't a repo yet). Also check the existing git history if the repo already has commits (`git log -p`), because deleting a secret in a new commit doesn't remove it from history.

Look for:
- **Secret files**: `.env*` (except `.env.example`), `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*`, `*.keystore`, `credentials*.json`, `service-account*.json`, `.npmrc` / `.pypirc` containing tokens, `*.sqlite`/`*.db` dumps, `*.log`.
- **Token patterns**: `ghp_`, `gho_`, `github_pat_`, `sk-`, `sk-ant-`, `AKIA[0-9A-Z]{16}`, `AIza`, `xox[baprs]-`, `-----BEGIN .*PRIVATE KEY-----`, `eyJ` JWTs, and URLs with embedded credentials (`://user:pass@`).
- **Assignments**: `password|passwd|secret|api_key|apikey|token|client_secret|connection_string` set to a literal value.
- **Personal data**: real email addresses, phone numbers, internal hostnames/IPs, and absolute local paths that reveal usernames (e.g. `C:\Users\<name>\`).

Then classify every hit:
- **Placeholders and public-by-design values** (e.g. `YOUR_EMAIL@example.com`, `noreply@anthropic.com` co-author lines) → fine. List them so the user can see them.
- **Real secrets or personal data** → **STOP**. Show file:line with the value masked (first 4 chars + `…`) and propose a fix: move it to an env var or an untracked config file, add the file to `.gitignore`, and rotate the secret if it is already in history. Do not push until the user confirms.

Create or update `.gitignore` with sensible entries for the stack (always include `.env`, `*.log`, OS/editor junk such as `.DS_Store`, `Thumbs.db`, `.vscode/` unless already committed intentionally, and `.claude/settings.local.json`).

## 2. Upload the code to GitHub

1. If this folder isn't a git repo, run `git init -b main`.
2. If `git config user.name`/`user.email` are unset, ask the user what to use, or offer the GitHub username plus the user's account email, and set them **repo-locally only** (no `--global`).
3. Set or verify the `origin` remote. If one already exists and points somewhere else, ask before changing it.
4. Check the remote with `git ls-remote origin`. If it already has commits that aren't local, fetch and show the user what's there. Never force-push or overwrite remote history without explicit confirmation.
5. Stage the scanned files, show `git status --short`, commit with a descriptive message (include any co-author line from the session's attribution instructions), and push with `git push -u origin main`, or the repo's default branch if that's different.

## 3. Create or edit GitHub Pages via GitHub Actions

1. Work out what the site is: a static site at the repo root (e.g. `index.html`), or a build output (`npm run build` → `dist/` / `build/`). If unclear, ask.
2. Create or update `.github/workflows/pages.yml`:
   - triggers: `push` to the default branch, plus `workflow_dispatch`;
   - permissions: `contents: read`, `pages: write`, `id-token: write`; concurrency group `pages`;
   - steps: `actions/checkout` → build or stage only the publishable files into `_site/` (never publish `.claude/`, `CLAUDE.md`, `.github/` or other non-site files) and `touch _site/.nojekyll` → `actions/configure-pages` → `actions/upload-pages-artifact` (path `_site`) → `actions/deploy-pages`. Use the current major versions of these actions.
   - If the workflow already exists, edit it in place rather than replacing it.
3. Fix things that commonly 404 on a project site served from `/REPO/`:
   - root-absolute asset paths (`/style.css`) → make them relative (`./style.css`) or prefix them with `/REPO/`;
   - a missing `index.html` at the site root;
   - a missing favicon → add an inline data-URI `<link rel="icon">`;
   - SPA routes → keep any existing `404.html`, but don't add one unless the user wants it.
4. Commit and push.
5. **Enable Pages.** The workflow's `GITHUB_TOKEN` cannot create a Pages site (`configure-pages` with `enablement: true` fails with "Resource not accessible by integration"). Check `https://api.github.com/repos/OWNER/REPO` → `has_pages`. If it's false, use the first option available:
   - `gh` CLI, if installed and authenticated: `gh api -X POST repos/OWNER/REPO/pages -f build_type=workflow`;
   - the user's stored git credential via the REST API (`POST /repos/OWNER/REPO/pages` with `{"build_type":"workflow"}`), **only after the user explicitly authorises it in this session**; never print the token;
   - otherwise give the user the manual step: Settings → Pages → Source = **GitHub Actions**, at `https://github.com/OWNER/REPO/settings/pages`.
   If Pages exists but uses a branch source, switch it to `build_type: workflow` the same way (PUT).
6. Trigger or re-run the deploy, wait for it to finish (poll the public Actions API in a background command, not short foreground sleeps), then verify the Pages URL returns HTTP 200 with the expected `<title>`. If a run fails, read the job's step conclusions and check-run annotations, then fix and retry.

## 4. Create or edit the README

Create or update `README.md` from what the code actually does (read it, don't guess):
- the title and a one-paragraph summary;
- a **Live demo** link to the Pages URL;
- features; how to run locally; configuration (e.g. placeholder constants the user must change, without real values); tech stack / constraints; how deployment works (the Pages workflow); and limitations (e.g. no persistence).
- Keep any existing hand-written README sections and only update facts that changed. Don't invent badges, licences or contributors. Mention a licence only if a LICENSE file exists.

Commit and push. This triggers a redeploy; confirm it succeeds.

## 5. Create or edit the repo About

Set the repository's About panel to:
- a description of one sentence, ≤ 350 chars, based on the README summary;
- a website: the Pages URL;
- topics (optional): 3–8 lowercase, hyphenated keywords that match the stack. Ask before replacing existing topics.

Use `gh repo edit OWNER/REPO --description "…" --homepage "<pages url>" --add-topic …` if `gh` is available. Otherwise use the REST API with the same authorisation rules as step 3.5: `PATCH /repos/OWNER/REPO` with `{"description": "...", "homepage": "..."}`, and `PUT /repos/OWNER/REPO/topics` with `{"names": [...]}`. If neither is possible, give the user the exact text to paste into the gear icon next to "About" on the repo page.

Verify with `https://api.github.com/repos/OWNER/REPO` (`description`, `homepage`).

## 6. Final report

Reply with:
- **Live Pages URL** (verified HTTP 200) and the repo URL;
- the secret scan result: what was checked, what was found, and what was allowed as a placeholder;
- the commits pushed, by short SHA and subject;
- any manual step still pending for the user, if one was needed.
