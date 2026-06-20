# Design: Non‑blocking reviewer workflow ("Nagendra")

This is an older file.

**Status:** Approved plan, ready to execute.
**Audience:** The engineer/AI agent implementing this. Follow the phases in
order. Each phase is independently shippable and carries its own tests.
**Language note:** UI copy in English (matches existing `review.html`).

---

## 0. Why / the five requirements

The reviewer (call him "Nagendra") opens a review link for a PR and works on
its markdown. We want him to be able to:

1. **Review non‑blocking** — his work never overwrites the author's branch.
2. **See what changed since the last time he looked** at each file.
3. **Leave explanatory comments**, either anchored to a paragraph or free / general.
4. **His edits open a pull request** instead of committing to the branch directly.
5. **When upstream moved while he had unsent edits**, see a *three‑way* view:
   the base he started from, the new upstream content, and his own unsent edits.

### Decisions already locked (do not re‑litigate)

| # | Decision |
|---|----------|
| D1 | When the reviewer submits, we create a **new branch off the PR head** and open a **PR that targets the original PR's head branch** (`sessions.head_branch`). His changes layer on top of the author's PR as a sub‑PR the author can merge. |
| D2 | The old "Approve → commit directly to the branch + lock" flow is **replaced** by the PR model in D1. There is no direct‑commit path anymore. |
| D3 | **Comments UI:** hovering a paragraph reveals a comment‑icon button; clicking it anchors a comment to that paragraph. A second button with the same icon sits **top‑right next to the editor** and creates a **free/general** comment (no anchor). |
| D4 | **Diff view opens by default** when the file changed upstream since the reviewer last saw it. If he *also* has unsent local edits to that file, show the **three‑way** view instead. |

---

## 1. Current architecture (what you are changing)

Read these before touching anything:

- `server/app.js` — wires `db` + `github` into the admin & review routers (dependency injection; tests swap in fakes).
- `server/db.js` — SQLite schema (`sessions`, `file_edits`, `file_visits`) + a light migration pattern (`ALTER TABLE ... ADD COLUMN` wrapped in `try{}catch{}`).
- `server/github.js` — the GitHub adapter. Exports exactly: `getPR, getPRFiles, getFileContent, commitChanges, getCurrentHeadSha`.
- `server/routes/review.js` — reviewer API (`GET /api/:token`, `GET/PUT /api/:token/files/*`, `POST /api/:token/approve`).
- `server/routes/admin.js` — session create/list/revoke.
- `server/middleware/session.js` — `requireSession` (active only) and `requireActiveOrApproved`.
- `server/lib/minimalDiff.js` — `reconstructMinimalContent(orig, saved)` + exported `lcsIndices(a, b)`. **Reuse `lcsIndices` for all diffing.**
- `server/lib/files.js` — `selectReviewableFiles` (markdown, non‑removed).
- `public/review.html` — the entire reviewer SPA (Toast UI editor, autosave, approve). One file, vanilla JS.
- `tests/helpers/fakeGithub.js` — in‑memory fake implementing the 5‑method adapter contract. **Every new adapter method must be added here too.**
- `tests/` — `unit/`, `integration/`, `e2e/`; `helpers/server.js` boots the app with fakes; spec is `test-spec.md`.

### Key facts to internalize

- `file_edits.original_content` is the **base**: the content the reviewer first
  started editing from, captured on the *first* save and never overwritten
  (`COALESCE(original_content, excluded.original_content)`). This is exactly the
  "base" leg of the three‑way diff (req 5).
- `sessions.head_sha` is the PR head SHA captured at session creation. The
  current approve flow refuses (HTTP 409) if the live head SHA has moved. We are
  **replacing that refusal** with the three‑way reconciliation view.
- `commitChanges(owner, repo, branch, headSha, editedFiles)` builds a tree on
  top of `headSha` and force‑moves `heads/<branch>`. We will keep the
  tree/commit building but point it at a **new** branch.
- The reviewer is a single anonymous identity per session (the token *is* the
  identity). No multi‑user concerns inside one session.

---

## 2. Target architecture overview

```
Reviewer opens link
  └─ GET /api/:token                 → session + file list (+ per-file change flags)
  └─ GET /api/:token/files/<path>    → { mine?, base?, upstream, seen?, view, diff }
        view ∈ { plain | two_way | three_way }   ← drives default-open diff (D4)
  └─ PUT /api/:token/files/<path>    → autosave (unchanged)
  └─ comments:
        GET    /api/:token/comments
        POST   /api/:token/comments         { file_path?, anchor?, body }
        PATCH  /api/:token/comments/:id     { resolved }
        DELETE /api/:token/comments/:id
  └─ POST /api/:token/submit          → create branch + commit + open PR (D1/D2)
                                        returns { ok, pr_number, pr_url }
```

New server modules:

- `server/lib/diff.js` — pure diff helpers used by routes (so the browser only renders, never computes). Built on `lcsIndices`.
- GitHub adapter gains `createBranch` and `createPullRequest`.

Session status lifecycle becomes: `active → submitted` (terminal, PR opened) or
`active → revoked`. The string `approved` is **renamed to `submitted`**
everywhere (DB default stays `active`; code/tests/spec updated — see §8).

---

## 3. Data model changes (`server/db.js`)

Add to `SCHEMA` (new installs) **and** add idempotent `ALTER TABLE` migrations in
`createDb` for existing DBs (mirror the existing `try{...}catch{}` pattern).

### 3.1 `sessions` — record the PR we opened

```sql
ALTER TABLE sessions ADD COLUMN submitted_pr_number INTEGER;
ALTER TABLE sessions ADD COLUMN submitted_pr_url TEXT;
ALTER TABLE sessions ADD COLUMN submitted_branch TEXT;
```

### 3.2 `file_edits` — record which SHA the base came from

```sql
ALTER TABLE file_edits ADD COLUMN base_sha TEXT;   -- session.head_sha at first save
```

(`original_content` is the base content; `base_sha` records the SHA it was read
at, so we can tell whether upstream moved relative to the reviewer's base.)

### 3.3 Replace `file_visits` with a "seen snapshot" (req 2)

Keep the table name `file_visits` (it is referenced for the unopened‑files
warning) but give it memory of *what* was seen:

```sql
ALTER TABLE file_visits ADD COLUMN seen_content TEXT;
ALTER TABLE file_visits ADD COLUMN seen_sha TEXT;
-- visited_at already exists; we now UPDATE it on every open (see §5.2)
```

### 3.4 New table `comments` (req 3)

```sql
CREATE TABLE IF NOT EXISTS comments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   TEXT NOT NULL,
  file_path    TEXT,                 -- NULL = session-level free comment
  anchor_text  TEXT,                 -- snapshot of the paragraph text; NULL = unanchored
  paragraph_index INTEGER,           -- 0-based paragraph index at creation time; NULL = unanchored
  body         TEXT NOT NULL,
  resolved     INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  FOREIGN KEY(session_id) REFERENCES sessions(id)
);
```

Anchoring strategy: store **both** `paragraph_index` (fast path) and
`anchor_text` (the paragraph's text, for re‑anchoring when paragraphs shift).
On render, try `paragraph_index`; if that paragraph's text no longer **exactly**
matches `anchor_text`, fall back to locating the paragraph whose text **equals**
`anchor_text` (an exact text match, not approximate); if neither matches,
render the comment as **"detached"** in the
panel (still visible, just not pinned). Keep this logic in the browser.

---

## 4. GitHub adapter (`server/github.js`) + fake

Add two methods; keep the existing five.

```js
// Create a new ref heads/<newBranch> pointing at fromSha. Idempotent-ish:
// if the ref exists, append a numeric suffix until createRef succeeds.
async function createBranch(owner, repo, newBranch, fromSha) { /* octokit.git.createRef */
  // returns the branch name actually created
}

// Open a PR. Returns { number, html_url }.
async function createPullRequest(owner, repo, head, base, title, body) { /* octokit.pulls.create */ }
```

Update the `module.exports` list. Then mirror both in
`tests/helpers/fakeGithub.js`:

- Add `createBranch: []` and `createPullRequest: []` to the `calls` record.
- `createBranch(owner, repo, newBranch, fromSha)` → push the call, return
  `newBranch` (or `newBranch + '-2'` if a test pre‑seeds a collision).
- `createPullRequest(...)` → push the call, return
  `{ number: 1000 + calls.createPullRequest.length, html_url: 'https://github.com/.../pull/<n>' }`.
- Honor a `config.submitShouldFail` flag (throw) analogous to `commitShouldFail`,
  so req‑11‑style "PR creation failed → session stays open" can be tested.

---

## 5. Server routes (`server/routes/review.js`)

### 5.1 `server/lib/diff.js` (new, pure, unit‑tested)

```js
const { lcsIndices } = require('./minimalDiff');

// Inline line diff: returns an ordered list of rows.
// row = { type: 'eq' | 'add' | 'del', text }
function lineDiff(oldText, newText) { /* walk lcsIndices like reconstructMinimalContent does */ }

// Three-way alignment keyed on the common BASE.
// Returns rows aligned by base line:
//   { base, upstream, mine,
//     upstreamChanged: bool, mineChanged: bool, conflict: bool }
// conflict = base line changed on BOTH sides to different values.
function threeWay(baseText, upstreamText, mineText) { /* LCS(base,upstream) + LCS(base,mine), align on base index */ }

module.exports = { lineDiff, threeWay };
```

Keep it line‑based (markdown is line‑oriented and `lcsIndices` is already
line‑based via the callers). Do **not** pull in an npm diff library.

### 5.2 `GET /api/:token/files/*` — now change‑aware

Replace the current handler body. Steps:

1. Validate the path is in the reviewable set (unchanged — keep the 404).
2. Load `edit` (content + original_content + base_sha) and the `file_visits`
   row (seen_content + seen_sha) for this `(session, path)`.
3. Fetch **current upstream** content via
   `github.getFileContent(owner, repo, path, liveHeadSha)` where `liveHeadSha =
   await github.getCurrentHeadSha(owner, repo, session.head_branch)`. (Falls back
   to `session.head_sha` if that call fails.)
4. Decide `view`:
   - `mine` exists (a dirty edit) **and** upstream differs from the edit's
     `original_content` → `view = 'three_way'`; payload `{ base: original_content,
     upstream, mine: content, diff: threeWay(base, upstream, mine) }`. **(req 5)**
   - else if a prior `seen_content` exists and differs from `upstream` →
     `view = 'two_way'`; payload `{ seen: seen_content, upstream,
     diff: lineDiff(seen_content, upstream) }`. **(req 2 / D4)**
   - else `view = 'plain'`; payload `{ content: mine ?? upstream, source }`.
5. **After** computing the response, update the seen snapshot (so "since last
   time" advances): `INSERT … ON CONFLICT(session_id,file_path) DO UPDATE SET
   seen_content = excluded.seen_content, seen_sha = excluded.seen_sha,
   visited_at = excluded.visited_at`. Store `upstream` as the new `seen_content`.
   Do this only when `session.status = 'active'` (read‑only sessions don't
   advance the watermark). **Remove the old `DO NOTHING`.**

> The response always includes `view` plus the editable text the front‑end
> should load into Toast UI as `content` (= `mine ?? upstream`), so the editor
> still works even when a diff is shown alongside.

### 5.3 `PUT /api/:token/files/*` — record `base_sha`

Unchanged except: when writing `original_content` for the first time, also write
`base_sha = session.head_sha`. Keep the `COALESCE`/first‑write‑wins semantics for
both columns.

### 5.4 Comments endpoints (new)

All under `requireSession` **except GET**, which uses `requireActiveOrApproved`
(so comments remain visible after submit).

- `GET /api/:token/comments` → all rows for the session, ordered by `created_at`.
- `POST /api/:token/comments` body `{ file_path?, anchor_text?, paragraph_index?, body }`
  → insert; `body` required and non‑empty (400 otherwise); returns the row.
- `PATCH /api/:token/comments/:id` body `{ resolved: bool }` → update, scoped to
  the session (404 if the comment isn't in this session).
- `DELETE /api/:token/comments/:id` → delete, scoped to the session.

### 5.5 `POST /api/:token/submit` — replaces `/approve` (D1/D2)

Rename the route from `approve` to `submit`. New behavior:

1. Save‑pending is handled client‑side (as today). Load dirty files
   (`file_path, content, original_content`).
2. If there are **no** dirty files: set `status='submitted'` and return
   `{ ok: true, submitted: false }` (clean close, no PR — mirrors the old
   "approve with no edits" rule).
3. Compute `liveHeadSha = getCurrentHeadSha(owner, repo, head_branch)`.
   - **Do not 409 on mismatch.** The three‑way view already surfaced upstream
     drift per file. Build commits off `liveHeadSha` so we never clobber.
4. `newBranch = await github.createBranch(owner, repo,
   \`review/pr${pr_number}-${token.slice(0,8)}\`, liveHeadSha)`.
5. Reconstruct minimal content per dirty file with
   `reconstructMinimalContent(original_content, content)` (unchanged helper) and
   `commitChanges(owner, repo, newBranch, liveHeadSha, files)`.
6. Open the PR: `createPullRequest(owner, repo, head=newBranch,
   base=head_branch, title=\`Review: ${pr_title}\`, body=<comment summary>)`.
   The body lists the reviewer's comments (anchored ones quoted) so they travel
   with the PR. Persist `submitted_pr_number/url/branch` on the session.
7. Set `status='submitted'`. Return `{ ok: true, submitted: true, pr_number,
   pr_url }`.
8. On any GitHub failure: leave `status='active'`, return 500 — never a
   half‑submitted session (mirrors existing req‑11 safety; covered by
   `config.submitShouldFail`).

> Comments are stored locally and summarized into the PR body. (Posting them as
> GitHub *inline review comments* requires mapping paragraphs → diff line numbers
> and is explicitly **out of scope** — note it as a future enhancement.)

### 5.6 `middleware/session.js`

Replace the `'approved'` checks/strings with `'submitted'`. Messaging:
`requireSession` rejects `submitted` with "This review has already been
submitted." Keep `requireActiveOrApproved` (rename to
`requireActiveOrSubmitted`) so reading/comments still work post‑submit.

---

## 6. Reviewer UI (`public/review.html`)

This is the largest piece. Keep it in the single file, vanilla JS, matching the
existing style. Sub‑tasks:

### 6.1 Submit button

Rename "Approve Changes" → "**Submit for PR**". On success, show a banner:
"Opened pull request #N → `<head_branch>`" linking to `pr_url`. Replace the
approved/`showApprovedState` naming with submitted equivalents. The
unopened‑files warning modal stays.

### 6.2 Default‑open diff view (D4, req 2 & 5)

When `openFile` fetches a file, branch on the response `view`. The editor is
**never gated behind a button** — diffs surface as a collapsible **reference
pane above the editor**, and editing always proceeds from `upstream`:

- `plain` → load `content` into Toast UI; no reference pane.
- `two_way` → show the reference pane with `lineDiff(seen, upstream)` (added lines
  green, removed red, GitHub‑style) — informational "here's what moved since you
  last looked" — and mount the editor on `upstream`.
- `three_way` → lay the reference pane **beside the editor** (reference left,
  editor right) for compare‑while‑editing. The reference is a **2‑column** view:
  **Original | Your edits** with a **GitHub‑style left gutter marker** on each
  changed row. The Upstream column is dropped — the editor already shows
  upstream — and signal is carried by a **marker + color, not per‑row text** (a
  legend explains both, so it survives grayscale / colorblindness). The markers
  are role‑based (who changed the line), not GitHub's add/remove `+`/`-` — the
  two‑way "what moved" view already uses `+`/`-` since that one is a real
  before/after diff: `✎` green = you edited this line here; `</>` blue = it came
  from the developer's commit (the editor on the right has the new version); `⚠`
  amber = conflict, both sides changed it. This keeps the table readable while
  still surfacing every upstream change. Mount the editor on `upstream`. Editing **always continues from upstream** — the reviewer
  can never drop the author's changes wholesale by taking their own stale‑based
  version. The reviewer re‑applies their changes (left column) into the editor by
  hand, and the result autosaves as usual. (Rationale: committing a mine‑based
  version would revert any *other* lines the author changed upstream; re‑applying
  onto upstream cannot.)

The reference pane is collapsible (Hide/Show): height‑bounded above the editor in
the two‑way case, a left column in the three‑way case. On a read‑only
**submitted** session no reference pane is shown — there is nothing to reconcile.

Implement the diff renderer as plain DOM tables/divs from the server‑provided
`diff` arrays — **no client‑side diff computation**. Add minimal CSS following
the existing palette (greens `#dcffe4/#22863a`, reds `#ffeef0/#cb2431`, amber for
conflict).

### 6.3 Comments (D3, req 3)

- **Paragraph hover button:** add a ProseMirror‑level affordance — on hover over
  a block node in the WYSIWYG surface, show a small comment‑icon button at the
  paragraph's right edge. Clicking it opens a small composer; on submit, POST a
  comment with `file_path = currentFile`, `paragraph_index` = that block's index
  among top‑level blocks, `anchor_text` = the paragraph's text.
  - Simplest robust implementation: a `mouseover`/`mouseout` listener on the
    editor's contenteditable root that positions a floating button next to the
    hovered top‑level block element; compute `paragraph_index` by counting prior
    sibling blocks. (You do **not** need a custom ProseMirror plugin for this;
    DOM positioning over the rendered blocks is acceptable and simpler.)
- **General comment button:** a button with the **same comment icon**, placed
  **top‑right next to the editor** (in `#header-actions`, left of Submit). Click
  → composer → POST with `file_path = currentFile` (or `null` for a truly
  session‑wide note — pick `currentFile` when a file is open, `null` when none),
  `anchor_text = null`, `paragraph_index = null`.
- **Comments panel:** a right‑hand collapsible panel listing comments for the
  current file (anchored ones near the top, with the quoted `anchor_text`), plus
  general comments. Each row: body, relative time, resolve toggle (PATCH),
  delete (DELETE). Re‑anchor on render per §3.4. Clicking an anchored comment
  scrolls to / highlights its paragraph.
- Load comments in `init()` and after each file open; keep a client cache.

### 6.4 Read‑only after submit

When `status === 'submitted'`: editor read‑only (reuse the existing
contenteditable=false path); the reference (diff/3‑way) pane is **not** shown —
there is nothing to reconcile on a locked session; comments stay viewable but
the composer and per‑comment actions are hidden; Submit button shows "Submitted".

---

## 7. Admin surface (`server/routes/admin.js`, `public/admin.html`)

- `GET /sessions`: the `edits_count` subquery is fine. Add `submitted_pr_number`
  / `submitted_pr_url` to the SELECT and show "PR #N" with a link in
  `admin.html` once a session is submitted. Update any `status === 'approved'`
  display strings to `submitted`.
- Revoke is unchanged (only `active` → `revoked`).

---

## 8. Spec & test deltas (`test-spec.md` + `tests/`)

Update the spec and tests **within each phase**, not at the end. Specific
requirement changes:

- **REQ‑9 (was "Approval commits & closes")** → reframe to "**Submission opens a
  PR and closes the session**":
  - Submitting with edits creates **one new branch**, **one commit**, and **one
    PR** targeting `head_branch`; session becomes `submitted`. Assert via fake
    `calls.createBranch`, `calls.commitChanges` (length 1, branch = new branch),
    `calls.createPullRequest` (head = new branch, base = head_branch).
  - Submitting with no edits closes cleanly, **no branch/PR created**.
- **REQ‑11 (conflict safety)** → change meaning:
  - R11.1 no longer "refuse on advanced branch". Instead: when upstream advanced,
    the file GET returns `view: 'three_way'` (or `two_way`) — assert the payload.
    Submission still succeeds by branching off the **live** head SHA (assert
    `commitChanges` was called with the live SHA, not the stale `session.head_sha`).
  - R11.2 keeps: if PR creation/commit fails (`submitShouldFail`), session stays
    `active`.
- **REQ‑12 (read‑only lock)** → `submitted` (not `approved`) is read‑only: edit &
  re‑submit refused.
- **New REQ‑15 — Change awareness (req 2):** after a reviewer has seen a file,
  if upstream changes, the next GET returns `view: 'two_way'` with a diff of
  seen→upstream; an unchanged file returns `view: 'plain'`.
- **New REQ‑16 — Three‑way (req 5):** with a dirty local edit *and* upstream
  drift, GET returns `view: 'three_way'` with `{ base, upstream, mine }` and a
  `diff` whose conflict rows are flagged correctly.
- **New REQ‑17 — Comments (req 3):** create anchored + free comments; list,
  resolve, delete; comments are scoped to their session (cannot touch another
  session's comment); body required.
- **New unit tests** for `lib/diff.js`: `lineDiff` add/remove/unchanged;
  `threeWay` conflict vs non‑conflict alignment, including duplicate lines
  (reuse the duplicate‑line rigor already in `minimalDiff.test.js`).

Test mechanics: integration tests boot via `tests/helpers/server.js` with
`createFakeGithub`. Extend fixtures with `headShas` overrides (already
supported) to simulate upstream drift, and add `contents` for the live SHA.
E2E (`tests/e2e/review.spec.js`, Playwright) gets: a default‑open diff scenario,
a 3‑way scenario, the paragraph‑hover comment flow, and the submit→PR banner.

---

## 9. Execution order (phased; ship each phase green)

| Phase | Scope | Files |
|------|-------|-------|
| **P0 Foundation** | Schema migrations (§3), adapter `createBranch`/`createPullRequest` + fakes (§4), `lib/diff.js` + its unit tests (§5.1) | `db.js`, `github.js`, `lib/diff.js`, `tests/helpers/fakeGithub.js`, `tests/unit/diff.test.js` |
| **P1 Submit→PR** | Replace approve with submit (§5.5), middleware rename (§5.6), UI submit button + banner (§6.1), admin PR link (§7), REQ‑9/11/12 test updates (§8) | `routes/review.js`, `middleware/session.js`, `review.html`, `admin.js`, `admin.html`, `test-spec.md`, integration tests |
| **P2 Change‑aware GET** | Seen snapshots + `view` decision + default‑open two‑way diff (§5.2, §6.2), REQ‑15 | `routes/review.js`, `review.html`, tests |
| **P3 Three‑way** | three_way payload + 3‑column reconcile UI (§5.2 branch, §6.2), REQ‑16 | `routes/review.js`, `review.html`, tests |
| **P4 Comments** | endpoints (§5.4), hover + general comment UI + panel (§6.3), REQ‑17 | `routes/review.js`, `review.html`, tests |

Within a phase: write/adjust tests alongside code; run `npm test` (node test
runner) and, for UI phases, `npm run test:e2e`. Do not start the next phase
until the current one is green.

---

## 10. Acceptance checklist (definition of done)

- [ ] Reviewer never writes to the PR's own branch; submitting opens a PR
      `review/pr<N>-<token>` → `<head_branch>` with a single commit. *(req 1, 4)*
- [ ] Reopening a file that moved upstream shows a diff **by default**; an
      unchanged file opens straight into the editor. *(req 2)*
- [ ] A file with unsent local edits **and** upstream drift opens in a 3‑column
      Base/Upstream/Mine view with conflicts flagged; the reviewer can resolve
      and the result autosaves. *(req 5)*
- [ ] Hovering a paragraph reveals a comment button that anchors a comment to it;
      the top‑right button creates a general comment; both list, resolve, delete.
      *(req 3)*
- [ ] Submitting with no edits closes the session cleanly with no branch/PR.
- [ ] A GitHub failure during submit leaves the session `active`.
- [ ] `npm test` and `npm run test:e2e` pass; `test-spec.md` reflects the new
      REQ‑9/11/12 semantics and adds REQ‑15/16/17.

---

## 11. Explicitly out of scope (note, don't build)

- Posting comments as GitHub **inline review comments** (paragraph→diff‑line
  mapping). Comments live in the tool and are summarized into the PR body.
- Multiple distinct reviewer identities within one session.
- Real‑time collaboration / live cursors.
- Auth changes to the admin surface.
</content>
</invoke>
