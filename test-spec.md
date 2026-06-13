# Test Specification — md-collaborator

**Scope:** Functional correctness only. Out of scope: security, performance, code quality, UX.

**Stack:** Playwright (E2E), in-process Express + in-memory SQLite (integration), plain Node (unit). GitHub API is mocked in unit and integration layers; real in E2E (or intercepted via MSW).

**Total: 82 tests** — 21 unit · 43 integration · 18 E2E

---

## Layer 1 — Unit Tests (21)

### 1.1 GitHub URL Parsing

One representative per equivalence partition: valid URL, invalid URL.

| # | Input | Expected |
|---|-------|----------|
| U-01 | `https://github.com/owner/repo/pull/123` | `{ owner: "owner", repo: "repo", prNumber: 123 }` |
| U-02 | `https://github.com/owner/repo/issues/123` | Parse error |

### 1.2 LCS / Content Reconstruction

"Original" = GitHub content; "edited" = reviewer's save; "result" = what gets committed.

| # | Scenario | Expected |
|---|----------|----------|
| U-03 | Identical original and edited | Short-circuits; output identical to original |
| U-04 | One line deleted | Deleted line absent; surrounding lines from original |
| U-05 | One line changed | Only that line uses edited version; others from original |
| U-06 | All lines changed (no LCS matches) | Output identical to edited |
| U-07 | Empty original, non-empty edited | Output identical to edited |
| U-08 | Non-empty original, empty edited | Output is empty |
| U-09 | File with repeated identical lines (e.g. `---` five times) | Correct LCS; no duplication or reordering |
| U-10 | File >3000 lines | Fallback fires; no crash; output equals edited content |

### 1.3 `getPRFiles` Filtering and Pagination

Mocked Octokit — the only tests that exercise the filtering code in `github.js`.

| # | Scenario | Expected |
|---|----------|----------|
| U-11 | PR has `.md`, `.js`, `.yml` files | Only `.md` returned |
| U-12 | PR has a `.md` with `status: "removed"` and one with `status: "modified"` | Only `modified` returned |
| U-13 | Paginator returns two pages (20 + 15 files) | All 35 returned |

### 1.4 Session Middleware

Full state matrix for both middleware functions — auth wiring on individual routes is not re-tested at integration level.

| # | Middleware | Token state | Expected |
|---|-----------|------------|----------|
| U-14 | `requireSession` | active | Calls `next()` |
| U-15 | `requireSession` | approved | 403 |
| U-16 | `requireSession` | revoked | 403 |
| U-17 | `requireSession` | unknown | 404 |
| U-18 | `requireActiveOrApproved` | active | Calls `next()` |
| U-19 | `requireActiveOrApproved` | approved | Calls `next()` |
| U-20 | `requireActiveOrApproved` | revoked | 403 |
| U-21 | `requireActiveOrApproved` | unknown | 404 |

---

## Layer 2 — Integration Tests (43)

Express + in-memory SQLite per suite. `server/github.js` fully mocked.

### 2.1 Admin Authentication

| # | Scenario | Expected |
|---|----------|----------|
| I-01 | Correct `x-admin-secret` header | Request proceeds |
| I-02 | Wrong or missing `x-admin-secret` | 401 |

### 2.2 Session Creation (`POST /admin/sessions`)

Mock returns open PR, head SHA `abc123`, `README.md` + `docs/guide.md`.

| # | Scenario | Expected |
|---|----------|----------|
| I-03 | Valid PR URL, open PR, `.md` files present | 200; `session_id` (UUID), `review_link` (contains token, prefixed with `BASE_URL`); session stored `active` with correct `head_sha` |
| I-04 | PR is closed or merged | 400 "PR is not open"; no session created |
| I-05 | PR exists but has zero `.md` files | 4xx; error indicates no markdown files; no session created |
| I-06 | PR has `.md` files but some are `status: "removed"` | Session created; removed files absent from session file list |
| I-07 | `pr_url` field missing from body | 400 "pr_url is required"; no GitHub call made |
| I-08 | URL does not match GitHub PR pattern | 400; no GitHub call made |

### 2.3 Session Listing (`GET /admin/sessions`)

| # | Scenario | Expected |
|---|----------|----------|
| I-09 | Sessions exist with varying edit counts | Response array; each item contains `id`, `token`, `owner`, `repo`, `pr_number`, `pr_title`, `status`, `created_at`, `edits_count`; `token` must be present (admin panel constructs review links from it); `edits_count` reflects actual number of dirty files |

### 2.4 Session Revocation (`POST /admin/sessions/:id/revoke`)

| # | Scenario | Expected |
|---|----------|----------|
| I-10 | Revoke active session | 200; `status` becomes `"revoked"` |
| I-11 | Revoke non-active session (already revoked or approved) | 404 "Session not found or already inactive" |
| I-12 | Use session token (not UUID id) in path | 404 |

### 2.5 Review Session Metadata (`GET /review/api/:token`)

| # | Scenario | Expected |
|---|----------|----------|
| I-13 | Active session | 200; `status: "active"`; file list; all `visited: false`, `edited: false` |
| I-14 | Approved session | 200; `status: "approved"`; file list returned |
| I-15 | Revoked session | 403 |
| I-16 | Unknown token | 404 |
| I-17 | After visiting one file and editing another | Visited file has `visited: true`; edited file has `edited: true`; others unchanged |

### 2.6 File Content Retrieval (`GET /review/api/:token/files/*`)

| # | Scenario | Expected |
|---|----------|----------|
| I-18 | First fetch, no prior edit | 200; `{ content, source: "github" }` |
| I-19 | Fetch after a `PUT` edit | 200; `{ content: <edited>, source: "edit" }` |
| I-20 | Approved session | 200 (read access survives approval) |
| I-21 | File path not in session's PR file list | 404 |
| I-22 | File path that doesn't exist on GitHub | 404 |

### 2.7 File Visit Tracking

| # | Scenario | Expected |
|---|----------|----------|
| I-23 | First `GET` of a file on active session | File marked visited in DB; subsequent `GET /review/api/:token` shows `visited: true` for that file |
| I-24 | Same file fetched twice | Only one visit record (ON CONFLICT DO NOTHING) |
| I-25 | Fetch file on approved session | Visit record NOT created (tracking is active-session only) |

### 2.8 File Edit / Auto-save (`PUT /review/api/:token/files/*`)

| # | Scenario | Expected |
|---|----------|----------|
| I-26 | Active session, PR file, `content` + `originalContent` in body | 200; content stored; `original_content` set from body; `dirty: true` |
| I-27 | Second `PUT` to same file | Content updated; `original_content` unchanged (COALESCE preserves first value) |
| I-28 | `PUT` without `originalContent` field | 200; `original_content` null; on approval LCS skipped, raw content committed |
| I-29 | `PUT` with no `content` field | 400 "content is required" |
| I-30 | Approved session | 403 |
| I-31 | File path not in session's PR file list | 404 |

### 2.9 Approval (`POST /review/api/:token/approve`)

`getCurrentHeadSha` mock returns stored SHA unless overridden.

| # | Scenario | Expected |
|---|----------|----------|
| I-32 | Active session, one dirty file, no conflict | 200 `{ ok: true }`; `commitChanges` called with file + stored `head_sha`; session becomes `"approved"` |
| I-33 | Multiple dirty files | All bundled into a single `commitChanges` call |
| I-34 | No dirty files | 200; `commitChanges` not called; session becomes `"approved"` |
| I-35 | Branch conflict (`getCurrentHeadSha` returns different SHA) | 409; session remains `"active"` |
| I-36 | `commitChanges` throws | 5xx; session remains `"active"` |
| I-37 | Two simultaneous `POST /approve` on same token | First 200; second 403 |
| I-38 | Already-approved session | 403 |
| I-39 | After approval, `PUT` to any file | 403 |
| I-40 | Content passed to `commitChanges` | Matches `reconstructMinimalContent(original_content, content)`; null `original_content` → raw content |

### 2.10 Review HTML Route (`GET /review/:token`)

| # | Scenario | Expected |
|---|----------|----------|
| I-41 | Known token (any status) | 200; `Content-Type: text/html` |
| I-42 | Unknown token | 404 plain text; no HTML |

### 2.11 GitHub Pagination

| # | Scenario | Expected |
|---|----------|----------|
| I-43 | PR with 35 `.md` files across two pages | All 35 appear in session file list |

---

## Layer 3 — End-to-End Tests (18)

Full browser, real server, GitHub API intercepted.

### 3.1 Admin Panel

| # | Scenario | Expected |
|---|----------|----------|
| E-01 | Correct secret + valid PR URL → Create | New row: correct PR number, "active", clickable review link |
| E-02 | Wrong admin secret | Error message; no new row |
| E-03 | Active session → Revoke | Row status updates to "revoked" |
| E-04 | Reviewer opens revoked link | Error shown; editor not accessible |

### 3.2 Full Reviewer Happy Path

| # | Step | Expected |
|---|------|----------|
| E-05 | Admin creates session for PR with 3 `.md` files | Review link generated |
| E-06 | Reviewer opens link | Sidebar: 3 files, all unvisited, unedited |
| E-07 | Reviewer clicks file 1 | Content loads; file marked visited |
| E-08 | Reviewer edits file 1 | Edit indicator; auto-save fires after debounce |
| E-09 | Reviewer clicks file 2 | Content loads; file 2 visited |
| E-10 | Reviewer skips file 3, clicks Approve | Warning modal lists file 3 |
| E-11 | Dismiss, open file 3, click Approve | No warning; approval succeeds; page read-only |
| E-12 | Editor toolbar | Disabled; cannot type |
| E-13 | Approved banner | Session shows as approved |

### 3.3 Key Scenarios

| # | Scenario | Expected |
|---|----------|----------|
| E-14 | Edit file, wait for auto-save, reload page | Edited content present; not original |
| E-15 | Approve, then click in editor | Editor non-editable |
| E-16 | GitHub returns different head SHA at approval | Error shown; session remains editable |
| E-17 | Admin revokes; reviewer triggers auto-save | 403 returned; error feedback shown |
| E-18 | File with valid ` ```mermaid ` block | SVG rendered; not raw code |

---

## Fixtures

| Fixture | Used by |
|---------|---------|
| Open PR, 2 `.md` files, SHA `abc123` | I-03–I-08 and all E2E |
| Closed/merged PR | I-04 |
| Open PR, zero `.md` files | I-05 |
| PR with a `removed` `.md` file + a `modified` `.md` file | I-06, U-12 |
| Paginated response: 35 `.md` files across 2 pages | U-13, I-43 |
| File content: short markdown (original) | I-18–I-31, LCS unit tests |
| File content: edited variant | I-27, I-40 |
| File content: identical to original | U-03 |
| File content: >3000 lines | U-10 |
| File with repeated identical lines | U-09 |
| PUT body with `originalContent` | I-26 |
| PUT body without `originalContent` | I-28, I-40 |
| Sessions in each state (active/approved/revoked) | U-14–U-21 |

---

## Coverage Map

| Feature | Unit | Integration | E2E |
|---------|------|-------------|-----|
| URL parsing | U-01–U-02 | — | — |
| LCS reconstruction | U-03–U-10 | I-40 | — |
| `getPRFiles` filtering + pagination | U-11–U-13 | — | — |
| Session middleware | U-14–U-21 | — | — |
| Admin auth | — | I-01–I-02 | E-02 |
| Session creation | — | I-03–I-08 | E-01 |
| Session listing (incl. token field) | — | I-09 | E-01 |
| Session revocation | — | I-10–I-12 | E-03–E-04 |
| Review metadata + auth wiring | — | I-13–I-17 | E-06 |
| File content (source field, approved read) | — | I-18–I-22 | E-07, E-14 |
| Visit tracking (active-session only) | — | I-23–I-25 | E-07, E-10 |
| Auto-save (with/without originalContent) | — | I-26–I-31 | E-08 |
| Approval state machine | — | I-32–I-39 | E-11–E-13 |
| LCS in approval | — | I-40 | — |
| Conflict detection | — | I-35 | E-16 |
| Review HTML route | — | I-41–I-42 | — |
| GitHub pagination | — | I-43 | — |
| Post-approval read-only | — | I-38–I-39 | E-15 |
| Mid-session revocation | — | — | E-17 |
| Mermaid rendering | — | — | E-18 |
| Full end-to-end flow | — | — | E-05–E-13 |
| Edit persistence | — | — | E-14 |
