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

### 1.2 LCS / Content Reconstruction

All cases test `lcsIndices()` + `reconstructMinimalContent()` together. "Original" is what GitHub returned; "edited" is what the reviewer saved. "Result" is what should be committed.

| # | Scenario | Expected result |
|---|----------|-----------------|
| U-09 | Identical original and edited | Output byte-for-byte identical to original |
| U-10 | One line added in the middle | Only inserted line differs; surrounding lines from original |
| U-11 | One line deleted | Deleted line absent; surrounding lines from original |
| U-12 | One line changed | Only that line uses edited version |
| U-13 | All lines changed | Output identical to edited |
| U-14 | Empty original, non-empty edited | Output identical to edited (all additions) |
| U-15 | Non-empty original, empty edited | Output is empty |
| U-16 | Only whitespace/blank-line changes | Whitespace changes captured; non-whitespace lines from original |
| U-17 | File with repeated identical lines (e.g. `---` separator appears 5 times) | Correct LCS selected; no duplication or line-order corruption |
| U-18 | Original uses CRLF (`\r\n`) line endings | Output uses `\r\n` as the line separator throughout |
| U-19 | File >3000 lines — fallback path | No crash; output equals edited content |

### 1.3 `getPRFiles` Filtering and Pagination

Unit tests against a mocked Octokit. Covers code in `github.js` that integration tests never reach because they mock the whole module.

| # | Scenario | Expected |
|---|----------|----------|
| U-20 | PR files include `.md`, `.js`, `.yml` | Only `.md` file returned |
| U-21 | PR files include a `.md` with `status: "removed"` and one with `status: "modified"` | Only the `modified` file returned |
| U-22 | Octokit paginator returns two pages of `.md` files (20 + 15) | All 35 files returned |

### 1.4 Session Middleware

Tests for `requireSession` and `requireActiveOrApproved` called with a seeded in-memory store (no HTTP). Auth wiring to individual routes is not re-tested at the integration level.

| # | Middleware | Token state | Expected |
|---|-----------|------------|----------|
| U-23 | `requireSession` | active | Calls `next()` |
| U-24 | `requireSession` | approved | Returns 403 |
| U-25 | `requireSession` | revoked | Returns 403 |
| U-26 | `requireSession` | unknown | Returns 404 |
| U-27 | `requireActiveOrApproved` | active | Calls `next()` |
| U-28 | `requireActiveOrApproved` | approved | Calls `next()` |
| U-29 | `requireActiveOrApproved` | revoked | Returns 403 |
| U-30 | `requireActiveOrApproved` | unknown | Returns 404 |

---

## Layer 2 — Integration Tests

Express app with a fresh in-memory SQLite DB per test suite. `server/github.js` is fully mocked. Auth state variants (revoked→403, unknown→404) are only tested once per middleware type; remaining routes trust the unit-level middleware tests.

### 2.1 Admin Authentication

Applies to all three admin routes.

| # | Scenario | Expected |
|---|----------|----------|
| I-01 | Correct `x-admin-secret` header | Request proceeds |
| I-02 | Wrong `x-admin-secret` header | 401 |
| I-03 | No `x-admin-secret` header | 401 |
| I-04 | `ADMIN_SECRET` env var not set at startup | All admin routes return 401; server still starts |

### 2.2 Session Creation (`POST /admin/sessions`)

GitHub mock returns: open PR, head SHA `abc123`, two `.md` files (`README.md`, `docs/guide.md`).

| # | Scenario | Expected |
|---|----------|----------|
| I-05 | Valid PR URL, PR is open, has `.md` files | 200; session stored with `status: "active"`; `head_sha` matches mock; response contains `session_id` (UUID) and `review_link` prefixed with `BASE_URL` |
| I-06 | PR is closed/merged | 400 "PR is not open"; no session created |
| I-07 | PR exists but has zero `.md` files | 4xx; no session created; error indicates no markdown files |
| I-08 | PR has `.md` files but some are deletions | Session created; file list contains only added/modified `.md` files |
| I-09 | `pr_url` field missing from request body | 400 "pr_url is required"; no GitHub call made |
| I-10 | GitHub returns 404 for the PR | 400; no session created |
| I-11 | `getPRFiles` fails (GitHub error after PR fetch) | 4xx/5xx; no session created |
| I-12 | Invalid URL format | 400 before any GitHub call |
| I-13 | Two calls with the same PR URL | Both sessions created; both active; distinct tokens |

### 2.3 Session Listing (`GET /admin/sessions`)

| # | Scenario | Expected |
|---|----------|----------|
| I-14 | No sessions exist | 200; empty array |
| I-15 | Multiple sessions with different statuses | Each object includes `id`, `token`, `owner`, `repo`, `pr_number`, `pr_title`, `status`, `created_at`, `edits_count` (snake_case; `token` must be present so the admin panel can construct the review link) |
| I-16 | Session with two dirty edits vs. session with none | `edits_count` is 2 for the first, 0 for the second |

### 2.4 Session Revocation (`POST /admin/sessions/:id/revoke`)

| # | Scenario | Expected |
|---|----------|----------|
| I-17 | Revoke active session | 200; `status` becomes `"revoked"` |
| I-18 | Revoke already-revoked session | 404 "Session not found or already inactive" |
| I-19 | Revoke approved session | 404 "Session not found or already inactive" |
| I-20 | Non-existent session ID | 404 |
| I-21 | Use session token (not id) in the URL | 404 |

### 2.5 Review Session Metadata (`GET /review/api/:token`)

| # | Scenario | Expected |
|---|----------|----------|
| I-22 | Active session | 200; `status: "active"`; file list with all `.md` files; all `visited: false`, `edited: false` |
| I-23 | Approved session | 200; `status: "approved"`; file list returned |
| I-24 | Revoked session | 403 |
| I-25 | Unknown token | 404 |
| I-26 | After one file is visited | That file has `visited: true`; others still `false` |
| I-27 | After one file is edited | That file has `edited: true`; others still `false` |
| I-28 | `getPRFiles` throws during metadata fetch | 500; session state unchanged |

### 2.6 File Content Retrieval (`GET /review/api/:token/files/*`)

| # | Scenario | Expected |
|---|----------|----------|
| I-29 | First fetch of a file (no prior edit) | 200; `{ content, source: "github" }` |
| I-30 | Fetch after a `PUT` edit | 200; `{ content: <edited>, source: "edit" }` |
| I-31 | Approved session | 200 (read-only access still works) |
| I-32 | Deeply nested file path (`docs/api/v2/nested/guide.md`) | 200; wildcard route reconstructs full path correctly |
| I-33 | File path not in this session's PR file list | 404 |
| I-34 | File path that doesn't exist on GitHub (`getFileContent` returns null) | 404 |
| I-35 | GitHub returns a non-404 error when fetching file content | 500 |

### 2.7 File Visit Tracking

| # | Scenario | Expected |
|---|----------|----------|
| I-36 | `GET .../files/foo.md` on active session, first time | `foo.md` marked visited in DB |
| I-37 | `GET /review/api/:token` after visit | `foo.md` has `visited: true` in file list |
| I-38 | Same file fetched twice on active session | Only one visit record in DB (ON CONFLICT DO NOTHING) |
| I-39 | Fetching a file on approved session | Visit record is NOT created (visit tracking is active-session only) |

### 2.8 File Edit / Auto-save (`PUT /review/api/:token/files/*`)

| # | Scenario | Expected |
|---|----------|----------|
| I-40 | Active session, PR file, content + `originalContent` in body | 200; `content` stored; `original_content` set from body; `dirty: true` |
| I-41 | Second `PUT` to same file with new content | Content updated; `original_content` unchanged (COALESCE preserves first-seen value) |
| I-42 | `PUT` without `originalContent` field (first save) | 200; `original_content` stored as null; approval commits raw saved content (LCS skipped) |
| I-43 | `PUT` with content identical to original | 200; `dirty: true`; file committed on approval |
| I-44 | `PUT` empty string as content | 200; empty content stored; `dirty: true` |
| I-45 | `PUT` with no `content` field in body | 400 "content is required" |
| I-46 | Approved session | 403 (verifies write is locked post-approval) |
| I-47 | File path not in session's PR file list | 404 |
| I-48 | Deeply nested path (`PUT .../files/a/b/c/d.md`) | 200; path stored and retrievable |

### 2.9 Approval (`POST /review/api/:token/approve`)

GitHub mock's `getCurrentHeadSha` returns the stored SHA unless overridden.

| # | Scenario | Expected |
|---|----------|----------|
| I-49 | Active session, one dirty file, no conflict | 200 `{ ok: true }`; `commitChanges` called with that file and stored `head_sha`; session becomes `"approved"` |
| I-50 | Multiple dirty files | All bundled into a single `commitChanges` call |
| I-51 | No dirty files | 200; `commitChanges` not called; session becomes `"approved"` |
| I-52 | Dirty file with content identical to original | `commitChanges` is called (dirty flag is the trigger) |
| I-53 | Branch conflict (`getCurrentHeadSha` returns different SHA) | 409; session remains `"active"` |
| I-54 | `commitChanges` throws | 5xx; session remains `"active"` |
| I-55 | `getCurrentHeadSha` throws | 5xx; session remains `"active"` |
| I-56 | Two simultaneous `POST /approve` on same token | First succeeds; second returns 403 |
| I-57 | Already-approved session | 403 |
| I-58 | After approval, `PUT /review/api/:token/files/*` | 403 |
| I-59 | LCS reconstruction used for committed content | Content passed to `commitChanges` matches `reconstructMinimalContent(original_content, content)`; null `original_content` → raw content passed through |

### 2.10 Review HTML Route (`GET /review/:token`)

| # | Scenario | Expected |
|---|----------|----------|
| I-60 | Valid active token | 200; `Content-Type: text/html` |
| I-61 | Valid approved token | 200; HTML served (JS renders read-only state) |
| I-62 | Valid revoked token | 200; HTML served (JS renders error via API call) |
| I-63 | Unknown token | 404 text response; no HTML |

### 2.11 GitHub Pagination

| # | Scenario | Expected |
|---|----------|----------|
| I-64 | Session creation with PR returning 35 `.md` files across two pages | Session created; `GET /review/api/:token` file list contains all 35 files |

---

## Layer 3 — End-to-End Tests (Playwright)

Full browser, real Express server, GitHub API intercepted (MSW or Playwright route intercept).

### 3.1 Admin Panel — Create Session

| # | Scenario | Expected |
|---|----------|----------|
| E-01 | Correct secret + valid PR URL → Create | New row with correct PR number, "active" status, clickable review link |
| E-02 | Wrong admin secret | Error message; no new row |
| E-03 | PR URL with no `.md` files | Error message; no session created |

### 3.2 Admin Panel — Revoke Session

| # | Scenario | Expected |
|---|----------|----------|
| E-04 | Active session → click Revoke | Row status updates to "revoked" |
| E-05 | Reviewer navigates to revoked link | Error shown; editor not accessible |

### 3.3 Full Happy Path

| # | Step | Expected |
|---|------|----------|
| E-06 | Admin creates session for PR with 3 `.md` files | Review link generated |
| E-07 | Reviewer opens link | Sidebar shows 3 files; all unvisited, unedited |
| E-08 | Reviewer clicks file 1 | Content loads; file marked visited |
| E-09 | Reviewer edits file 1 | Edit indicator appears; auto-save fires after debounce |
| E-10 | Reviewer clicks file 2 | Content loads; file 2 marked visited |
| E-11 | Reviewer skips file 3, clicks Approve | Warning modal lists file 3 as unvisited |
| E-12 | Reviewer dismisses, opens file 3, approves | No warning; approval succeeds; read-only state |
| E-13 | Editor toolbar after approval | Disabled; cannot type |
| E-14 | Approved banner | Session shows as approved |

### 3.4 Edit Persistence Across Page Reload

| # | Scenario | Expected |
|---|----------|----------|
| E-15 | Edit a file, wait for auto-save, reload | Edited content present; not original |

### 3.5 Read-Only After Approval

| # | Scenario | Expected |
|---|----------|----------|
| E-16 | Approve, then click in editor | Editor non-editable |
| E-17 | Approve, navigate to another file and back | Still shows edited content; still read-only |

### 3.6 Conflict on Approval

| # | Scenario | Expected |
|---|----------|----------|
| E-18 | GitHub mock returns different head SHA at approval | Error shown; session remains editable |

### 3.7 Mid-Session Revocation

| # | Scenario | Expected |
|---|----------|----------|
| E-19 | Page open; admin revokes; reviewer triggers auto-save | 403 returned; error feedback shown |
| E-20 | Page open; admin revokes; reviewer reloads | Error shown; editor not accessible |

### 3.8 Mermaid Diagram Rendering

| # | Scenario | Expected |
|---|----------|----------|
| E-21 | File with valid ` ```mermaid ` block | SVG rendered; not a raw code block |
| E-22 | File with invalid mermaid block | Error shown in place of diagram; no crash |

### 3.9 No-Edit Approval

| # | Scenario | Expected |
|---|----------|----------|
| E-23 | Open all files, make no edits, approve | Approval succeeds; no commit; session enters read-only state |

---

## Fixtures and Test Data

| Fixture | Used by |
|---------|---------|
| Valid GitHub PR response: open, 2 `.md` files, head SHA `abc123` | I-05–I-13 and all E2E tests |
| GitHub PR response: closed/merged | I-06 |
| GitHub PR response: open, zero `.md` files | I-07, E-03 |
| GitHub PR response: open, `.md` files where some have `status: "removed"` | I-08, U-21 |
| Mocked Octokit: 35 `.md` files across two pages | U-22, I-64 |
| File content: short markdown string (original) | I-29–I-48, LCS unit tests |
| File content: edited variant | I-41, I-59, LCS unit tests |
| File content: identical to original | U-09, I-43, I-52 |
| File content: empty string | U-14–U-15, I-44 |
| File content: whitespace-only changes | U-16 |
| File content: file with repeated identical lines | U-17 |
| File content: CRLF line endings | U-18 |
| File content: >3000 lines | U-19 |
| Pre-seeded sessions (active/approved/revoked) | U-23–U-30, state-machine integration tests |
| PR with deeply nested `.md` path `docs/api/v2/nested/guide.md` | I-32, I-48 |
| PUT body with `originalContent` | I-40 |
| PUT body without `originalContent` | I-42, I-59 |

---

## Coverage Map

| Feature | Unit | Integration | E2E |
|---------|------|-------------|-----|
| URL parsing | U-01–U-08 | — | — |
| LCS reconstruction | U-09–U-18 | I-59 | — |
| LCS: size fallback | U-19 | — | — |
| `getPRFiles` filtering and pagination | U-20–U-22 | — | — |
| Session middleware | U-23–U-30 | — | — |
| Admin auth | — | I-01–I-04 | E-02 |
| Session creation | — | I-05–I-13 | E-01 |
| Session listing (incl. token field) | — | I-14–I-16 | E-01 |
| Session revocation | — | I-17–I-21 | E-04–E-05 |
| Review metadata | — | I-22–I-28 | E-07 |
| File content (source field, approved read) | — | I-29–I-35 | E-08, E-15 |
| Visit tracking (active-only) | — | I-36–I-39 | E-08, E-11 |
| Auto-save (with/without originalContent) | — | I-40–I-48 | E-09 |
| Approval (state machine + LCS) | — | I-49–I-59 | E-12–E-14, E-23 |
| Conflict detection | — | I-53 | E-18 |
| Review HTML route branching | — | I-60–I-63 | — |
| GitHub pagination end-to-end | — | I-64 | — |
| Mid-session revocation | — | — | E-19–E-20 |
| Mermaid rendering | — | — | E-21–E-22 |
| Full end-to-end flow | — | — | E-06–E-14 |
| Edit persistence across reload | — | — | E-15 |
