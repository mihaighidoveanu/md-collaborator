# Test Specification — md-collaborator

**Scope:** Functional correctness only. Out of scope: security, performance, code quality, UX.

**Stack:** Playwright (E2E), in-process Express + in-memory SQLite (integration), plain Node (unit). GitHub API is mocked in unit and integration layers; real in E2E (or intercepted via MSW).

---

## Layer 1 — Unit Tests

No HTTP, no database. Pure logic.

### 1.1 GitHub URL Parsing

| # | Input | Expected |
|---|-------|----------|
| U-01 | `https://github.com/owner/repo/pull/123` | `{ owner: "owner", repo: "repo", prNumber: 123 }` |
| U-02 | `https://github.com/owner/repo/pull/123/` (trailing slash) | Same as U-01 |
| U-03 | `https://github.com/owner/repo/pull/123/files` | Same as U-01 |
| U-04 | `https://github.com/owner/repo/pull/123?diff=unified` | Same as U-01 |
| U-05 | `https://github.com/owner/repo/pull/123/files?diff=split` | Same as U-01 |
| U-06 | `https://github.com/owner/repo/issues/123` (not a PR) | Parse error |
| U-07 | `https://gitlab.com/owner/repo/pull/123` (non-GitHub) | Parse error |
| U-08 | `https://github.com/owner/repo` (no PR path) | Parse error |
| U-09 | `not-a-url` | Parse error |
| U-10 | Empty string | Parse error |

### 1.2 LCS / Content Reconstruction

All cases test `lcsIndices()` + `reconstructMinimalContent()` together. "Original" is what GitHub returned; "edited" is what the reviewer saved. "Result" is what should be committed.

| # | Scenario | Expected result |
|---|----------|-----------------|
| U-11 | Identical original and edited | Output byte-for-byte identical to original |
| U-12 | One line added in the middle | Only inserted line differs; surrounding lines from original |
| U-13 | One line deleted | Deleted line absent; surrounding lines from original |
| U-14 | One line changed | Only that line uses edited version |
| U-15 | All lines changed | Output identical to edited |
| U-16 | Empty original, non-empty edited | Output identical to edited (all additions) |
| U-17 | Non-empty original, empty edited | Output is empty |
| U-18 | Only whitespace/blank-line changes | Whitespace changes captured; non-whitespace lines from original |
| U-19 | File exactly 3000 lines — normal path | LCS path executes, correct output |
| U-20 | File >3000 lines — fallback path | Falls back gracefully (no crash, output equals edited content) |

### 1.3 Session Middleware

Tests for `requireSession` and `requireActiveOrApproved` called with a seeded in-memory store (no HTTP).

| # | Middleware | Token state | Expected |
|---|-----------|------------|----------|
| U-21 | `requireSession` | active | Calls `next()` |
| U-22 | `requireSession` | approved | Returns 403 |
| U-23 | `requireSession` | revoked | Returns 403 |
| U-24 | `requireSession` | unknown | Returns 404 |
| U-25 | `requireActiveOrApproved` | active | Calls `next()` |
| U-26 | `requireActiveOrApproved` | approved | Calls `next()` |
| U-27 | `requireActiveOrApproved` | revoked | Returns 403 |
| U-28 | `requireActiveOrApproved` | unknown | Returns 404 |

---

## Layer 2 — Integration Tests

Express app with a fresh in-memory SQLite DB per test suite. `server/github.js` is fully mocked.

### 2.1 Admin Authentication

Applies to all three admin routes: `GET /admin/sessions`, `POST /admin/sessions`, `POST /admin/sessions/:id/revoke`.

| # | Scenario | Expected |
|---|----------|----------|
| I-01 | Correct `x-admin-secret` header | Request proceeds (2xx or relevant success) |
| I-02 | Wrong `x-admin-secret` header | 401 |
| I-03 | No `x-admin-secret` header | 401 |
| I-04 | `ADMIN_SECRET` env var not set at startup | All admin routes return 401 (fail closed); server still starts |

### 2.2 Session Creation (`POST /admin/sessions`)

GitHub mock returns: open PR, head SHA `abc123`, two `.md` files (`README.md`, `docs/guide.md`).

| # | Scenario | Expected |
|---|----------|----------|
| I-05 | Valid PR URL, PR is open, has `.md` files | 201; session stored with `status: "active"`; token is 64-char hex string; `headSha` stored matches mock value |
| I-06 | Response body shape | Contains `session_id` (UUID) and `review_link` (string prefixed with `BASE_URL`, containing the token) |
| I-07 | PR is closed/merged | 4xx error; no session created |
| I-08 | PR exists but has zero `.md` files (all changes are `.js`, `.yml`, etc.) | 4xx error; no session created; error message indicates no markdown files |
| I-09 | PR modifies `.md` files but some are deletions — deleted files excluded | Session created; file list contains only added/modified `.md` files, not deleted ones |
| I-10 | GitHub returns 404 for the PR | 4xx error propagated; no session created |
| I-11 | `getPRFiles` fails (GitHub error) | 4xx/5xx error; no session created |
| I-12 | Invalid URL format (not parseable) | 400 before any GitHub call is made |
| I-13 | Two `POST /admin/sessions` calls with the same PR URL | Both sessions created; both active; each has a distinct token |

### 2.3 Session Listing (`GET /admin/sessions`)

| # | Scenario | Expected |
|---|----------|----------|
| I-14 | No sessions exist | 200; empty array |
| I-15 | Multiple sessions with different statuses | All sessions returned; each includes `id`, `status`, `prNumber`, `editedFileCount`, `createdAt`, review link |
| I-16 | Session with two dirty edits | `editedFileCount` is 2 |
| I-17 | Session with no edits | `editedFileCount` is 0 |

### 2.4 Session Revocation (`POST /admin/sessions/:id/revoke`)

| # | Scenario | Expected |
|---|----------|----------|
| I-18 | Revoke active session | 200; session `status` becomes `"revoked"` |
| I-19 | Revoke already-revoked session | 404 "Session not found or already inactive" (WHERE clause requires `status='active'`; no match) |
| I-20 | Revoke approved session | 404 "Session not found or already inactive" (same reason) |
| I-21 | Non-existent session ID | 404 |
| I-22 | Use session token (not id) in the URL | 404 (token ≠ id; wrong identifier type) |

### 2.5 Review Session Metadata (`GET /review/api/:token`)

| # | Scenario | Expected |
|---|----------|----------|
| I-23 | Active session | 200; `status: "active"`; file list with all `.md` files from PR; all `visited: false`, `edited: false` initially |
| I-24 | Approved session | 200; `status: "approved"`; file list returned |
| I-25 | Revoked session | 403 |
| I-26 | Unknown token | 404 |
| I-27 | After one file is visited | That file has `visited: true`; others still `false` |
| I-28 | After one file is edited | That file has `edited: true`; others still `false` |

### 2.6 File Content Retrieval (`GET /review/api/:token/files/*`)

| # | Scenario | Expected |
|---|----------|----------|
| I-29 | First fetch of a file (no prior edit) | 200; returns original content from GitHub mock |
| I-30 | Fetch after a `PUT` edit | 200; returns edited content from DB, not GitHub |
| I-31 | Active session | 200 |
| I-32 | Approved session | 200 (read-only access still works) |
| I-33 | Revoked session | 403 |
| I-34 | Unknown token | 404 |
| I-35 | File path in the PR (`docs/guide.md`) | 200; correct content |
| I-36 | Deeply nested file path (`docs/api/v2/nested/guide.md`) | 200; wildcard route reconstructs full path correctly |
| I-37 | File path not in this session's PR file list but valid in GitHub repo | 200; returns GitHub content (server does not filter GET by PR file list) |
| I-38 | File path that doesn't exist on GitHub at all | 404 |

### 2.7 File Visit Tracking

| # | Scenario | Expected |
|---|----------|----------|
| I-39 | `GET /review/api/:token/files/foo.md` on active session, first time | `foo.md` marked visited in DB |
| I-40 | `GET /review/api/:token` after visit | `foo.md` has `visited: true` in file list |
| I-41 | Same file fetched twice on active session | Only one visit record in DB (no duplicate; ON CONFLICT DO NOTHING) |
| I-42 | Fetching a file on approved session | Visit record is NOT created (visit tracking is active-session only) |

### 2.8 File Edit / Auto-save (`PUT /review/api/:token/files/*`)

| # | Scenario | Expected |
|---|----------|----------|
| I-43 | Active session, valid file, new content with `originalContent` in body | 200; `content` stored; `original_content` set from request body; `dirty: true` |
| I-44 | Second `PUT` to same file with different `originalContent` | Content updated; `original_content` unchanged (first-seen value preserved by COALESCE) |
| I-45 | `PUT` without `originalContent` field in body (first save) | 200; `original_content` stored as null; during approval, LCS is skipped and raw saved content is committed |
| I-46 | `PUT` with content identical to original | 200; stored; `dirty: true`; file will be committed on approval (confirmed correct) |
| I-47 | `PUT` empty string as content | 200; empty content stored; `dirty: true` |
| I-48 | `PUT` with no `content` field in body | 400 "content is required" |
| I-49 | `GET` after `PUT` | Returns saved content, not original |
| I-50 | Approved session | 403 |
| I-51 | Revoked session | 403 |
| I-52 | Unknown token | 404 |
| I-53 | File path not in session's PR file list | 200; server does not validate PUT paths against PR file list; content is stored |
| I-54 | Deeply nested path (`PUT /review/api/:token/files/a/b/c/d.md`) | 200; path stored and retrievable |

### 2.9 Approval (`POST /review/api/:token/approve`)

GitHub mock's `getCurrentHeadSha` returns the same SHA stored at session creation unless overridden.

| # | Scenario | Expected |
|---|----------|----------|
| I-55 | Happy path: active session, one dirty file, no conflict | 200 `{ ok: true }`; `commitChanges` called with that file; session `status` becomes `"approved"` |
| I-56 | Happy path: active session, multiple dirty files, no conflict | 200; all dirty files bundled into single `commitChanges` call; session becomes `"approved"` |
| I-57 | No dirty files at all | 400 "No changes to approve."; session remains `"active"`; `commitChanges` not called |
| I-58 | Only visited-but-not-edited files (no dirty flag) | 400 "No changes to approve."; session remains `"active"` |
| I-59 | Dirty file with content identical to original | `commitChanges` is called (dirty flag is the trigger, not a content diff) |
| I-60 | Branch conflict (mock `getCurrentHeadSha` returns different SHA than stored) | 409; session remains `"active"` |
| I-61 | `commitChanges` throws (GitHub error mid-commit) | 5xx error; session remains `"active"` |
| I-62 | `getCurrentHeadSha` throws (GitHub error before commit) | 5xx error; session remains `"active"` |
| I-63 | Two simultaneous `POST /approve` requests on same token | First succeeds (200, session approved); second returns 403 |
| I-64 | `POST /approve` on already-approved session | 403 |
| I-65 | `POST /approve` on revoked session | 403 |
| I-66 | After approval, `PUT /review/api/:token/files/*` | 403 |
| I-67 | Committed content uses LCS reconstruction | Content passed to `commitChanges` matches `reconstructMinimalContent(original_content, content)` for each dirty file; null `original_content` → raw `content` passed through |

### 2.10 Review HTML Route (`GET /review/:token`)

This route performs a DB lookup and has real branching — it does not just blindly serve HTML.

| # | Scenario | Expected |
|---|----------|----------|
| I-68 | Valid active token | 200; `Content-Type: text/html`; review.html served |
| I-69 | Valid approved token | 200; review.html served (JS renders read-only state) |
| I-70 | Valid revoked token | 200; review.html served (JS renders error state via API call) |
| I-71 | Unknown token | 404 text response ("Link not found."); no HTML |

### 2.11 GitHub Pagination

| # | Scenario | Expected |
|---|----------|----------|
| I-72 | PR with 35 `.md` files (mock returns two pages of results) | Session file list contains all 35 files |
| I-73 | PR with exactly 30 `.md` files (one full page) | Session file list contains all 30 files (no premature stop) |

---

## Layer 3 — End-to-End Tests (Playwright)

Full browser, real Express server, GitHub API intercepted (MSW or Playwright route intercept).

### 3.1 Admin Panel — Create Session

| # | Scenario | Expected |
|---|----------|----------|
| E-01 | Navigate to `/admin.html`, enter correct secret, paste valid PR URL, click Create | Success; new row appears in session table with correct PR number, "active" status, and clickable review link |
| E-02 | Enter wrong admin secret | Error message displayed; no new row in table |
| E-03 | Enter PR URL for a PR with no `.md` files | Error message displayed; no session created |

### 3.2 Admin Panel — Revoke Session

| # | Scenario | Expected |
|---|----------|----------|
| E-04 | Active session in table → click Revoke | Row status updates to "revoked" |
| E-05 | Reviewer navigates to revoked link | Error shown (not the editor UI); cannot access files |

### 3.3 Full Happy Path

| # | Step | Expected |
|---|------|----------|
| E-06 | Admin creates session for PR with 3 `.md` files | Review link generated |
| E-07 | Reviewer opens review link | Sidebar shows all 3 files; all unvisited, all unedited |
| E-08 | Reviewer clicks file 1 | Content loads in editor; file marked visited in sidebar |
| E-09 | Reviewer edits file 1 content | Edit indicator appears; auto-save fires after debounce |
| E-10 | Reviewer clicks file 2 | Content loads; file 2 marked visited |
| E-11 | Reviewer does not open file 3, clicks Approve | Warning modal appears listing file 3 as unvisited |
| E-12 | Reviewer dismisses modal, opens file 3, clicks Approve | No warning; approval succeeds; page enters read-only state |
| E-13 | Editor toolbar disabled after approval | Cannot type in editor |
| E-14 | Approved state banner visible | Session shows as approved |

### 3.4 Edit Persistence Across Page Reload

| # | Scenario | Expected |
|---|----------|----------|
| E-15 | Reviewer edits a file, waits for auto-save, reloads page | Edited content is still present; not the original |

### 3.5 Read-Only After Approval

| # | Scenario | Expected |
|---|----------|----------|
| E-16 | Reviewer approves, then tries to edit (clicks in editor) | Editor is non-editable |
| E-17 | Reviewer approves, then navigates to a different file and back | File still shows edited content; editor still read-only |

### 3.6 Conflict on Approval

| # | Scenario | Expected |
|---|----------|----------|
| E-18 | GitHub mock returns different head SHA at approval time | Error message shown to reviewer; session remains editable |

### 3.7 Mid-Session Revocation

| # | Scenario | Expected |
|---|----------|----------|
| E-19 | Reviewer has page open; admin revokes session; reviewer triggers auto-save | Save returns 403; error feedback shown to reviewer |
| E-20 | Reviewer has page open; admin revokes session; reviewer reloads page | Error page/message shown; editor not accessible |

### 3.8 Mermaid Diagram Rendering

| # | Scenario | Expected |
|---|----------|----------|
| E-21 | File contains a valid ` ```mermaid ` block | SVG diagram rendered in editor; not a raw code block |
| E-22 | File contains an invalid mermaid block | Error displayed in place of diagram; no crash; rest of file renders normally |

### 3.9 No-Edit Approval

| # | Scenario | Expected |
|---|----------|----------|
| E-23 | Reviewer opens all files, makes no edits, clicks Approve | Error shown ("No changes to approve."); session remains active and editable |

---

## Fixtures and Test Data

| Fixture | Used by |
|---------|---------|
| Valid GitHub PR response: open, 2 `.md` files, head SHA `abc123` | All integration and E2E tests |
| GitHub PR response: closed/merged | I-07 |
| GitHub PR response: open, zero `.md` files | I-08, E-03 |
| GitHub PR response: open, `.md` files where some have `status: "removed"` | I-09 |
| GitHub PR response: 35 `.md` files across two pages | I-72, I-73 |
| File content: short markdown string (original) | I-29 through I-54, LCS unit tests |
| File content: edited variant of the above | I-44, I-67, LCS unit tests |
| File content: identical to original (no changes) | U-11, I-46, I-59 |
| File content: empty string | U-16–U-17, I-47 |
| File content: whitespace-only changes | U-18 |
| File content: 3001-line markdown document | U-19–U-20 |
| Pre-seeded sessions in each state (active/approved/revoked) | Middleware unit tests, state-machine integration tests |
| PR with deeply nested `.md` file path `docs/api/v2/nested/guide.md` | I-36, I-54 |
| PUT request body with `originalContent` field | I-43 |
| PUT request body without `originalContent` field | I-45, I-67 |

---

## Coverage Map

| Feature | Unit | Integration | E2E |
|---------|------|-------------|-----|
| URL parsing (all formats + errors) | U-01–U-10 | — | — |
| LCS reconstruction | U-11–U-20 | I-67 | — |
| LCS fallback when originalContent is null | — | I-45, I-67 | — |
| Session middleware | U-21–U-28 | — | — |
| Admin auth | — | I-01–I-04 | E-02 |
| ADMIN_SECRET not set | — | I-04 | — |
| Session creation (happy path) | — | I-05–I-06 | E-01 |
| Session creation (no .md files) | — | I-08 | E-03 |
| Session creation (deleted files excluded) | — | I-09 | — |
| Session creation (error paths) | — | I-07, I-10–I-12 | — |
| Multiple sessions same PR | — | I-13 | — |
| Session listing | — | I-14–I-17 | E-01 |
| Session revocation | — | I-18–I-22 | E-04–E-05 |
| Review HTML route | — | I-68–I-71 | — |
| Review metadata | — | I-23–I-28 | E-07 |
| File content (original vs edited) | — | I-29–I-38 | E-08, E-15 |
| Deeply nested file paths | — | I-36, I-54 | — |
| Non-PR file GET (no server-side filtering) | — | I-37 | — |
| Non-existent file GET | — | I-38 | — |
| Visit tracking (active sessions only) | — | I-39–I-42 | E-08, E-11 |
| Auto-save (with/without originalContent) | — | I-43–I-54 | E-09 |
| Missing content field in PUT | — | I-48 | — |
| Non-PR file PUT (no server-side filtering) | — | I-53 | — |
| Approval (one dirty file) | — | I-55 | E-12–E-14 |
| Approval (multiple dirty files, single commit) | — | I-56 | — |
| Approval (no dirty files → 400) | — | I-57, I-58 | E-23 |
| Approval (identical content still committed) | — | I-59 | — |
| Conflict detection | — | I-60 | E-18 |
| GitHub failure during approval | — | I-61–I-62 | — |
| Concurrent approval requests | — | I-63 | — |
| Post-approval state (read-only) | — | I-64–I-67 | E-16–E-17 |
| GitHub pagination | — | I-72–I-73 | — |
| Mid-session revocation | — | — | E-19–E-20 |
| Mermaid rendering | — | — | E-21–E-22 |
| Full end-to-end flow | — | — | E-06–E-14 |
| Edit persistence across reload | — | — | E-15 |
