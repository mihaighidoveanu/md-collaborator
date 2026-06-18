# Tests

The suite is organized by **business requirement** (see `../test-spec.md`), not by
code structure. Every test asserts *observable behavior* through a stable seam —
HTTP responses, or a pure function's contract — so the app's internals (SQL,
helper names, file layout) can change without touching the tests.

## How it stays refactor-resistant

The app is built by `createApp({ db, github })` (`server/app.js`) with its
dependencies injected:

- **Database** — `createDb(':memory:')` gives each test an isolated DB.
- **GitHub** — a recording fake (`helpers/fakeGithub.js`) implements the same
  5-method adapter contract the real `server/github.js` exports. Tests assert on
  what the fake *received* (e.g. one commit, with these files) rather than on
  any internal call.

Integration tests drive the real Express app over HTTP on an ephemeral port.
Unit tests target the extracted pure logic in `server/lib/`.

## Running

```bash
npm test          # unit + integration (node:test, no browser needed)
npm run test:e2e  # browser specs (needs: npx playwright install chromium)
```

The E2E specs cover behaviors that only exist in the browser and load the editor
+ mermaid from a CDN, so they require a browser and network access.

## Requirement → test mapping

| Req  | Test(s)                                   | Level | File |
|------|-------------------------------------------|-------|------|
| R1.1 | correct secret reaches endpoints          | I | integration/admin.test.js |
| R1.2 | wrong/missing secret refused              | I | integration/admin.test.js |
| R2.1 | open PR → working link + active session   | I | integration/admin.test.js |
| R2.2 | closed/merged PR refused                  | I | integration/admin.test.js |
| R2.3 | PR with no markdown refused               | I | integration/admin.test.js |
| R2.4 | invalid URL refused before any GH call    | I | integration/admin.test.js |
| R3.1 | non-markdown files excluded               | U | unit/files.test.js |
| R3.2 | deleted markdown excluded                 | U | unit/files.test.js |
| R3.3 | large PR drops nothing                     | U/I | unit/files.test.js, integration/review.test.js |
| R4.1 | listing shows status/edits/working link   | I | integration/admin.test.js |
| R5.1 | revoke cuts off the reviewer              | I | integration/admin.test.js |
| R5.2 | revoking a non-active session is a no-op  | I | integration/admin.test.js |
| R6.1 | reviewer reads file list + contents       | I | integration/review.test.js |
| R6.2 | reviewer sees own latest edit             | I | integration/review.test.js |
| R6.3 | file outside the set refused              | I | integration/review.test.js |
| R7.1 | edit survives reload                       | E | e2e/review.spec.js |
| R7.2 | baseline fixed at first save              | I | integration/review.test.js |
| R8.1 | opening a file marks it reviewed          | I | integration/review.test.js |
| R8.2 | approving with unopened files warns       | E | e2e/review.spec.js |
| R9.1 | approve commits + locks session           | I | integration/review.test.js |
| R9.2 | many files → one commit                    | I | integration/review.test.js |
| R9.3 | approve with no edits closes cleanly      | I | integration/review.test.js |
| R10.1| single changed line → minimal diff        | U | unit/minimalDiff.test.js |
| R10.2| repeated identical lines preserved        | U | unit/minimalDiff.test.js |
| R10.3| very large file (fallback) intact         | U | unit/minimalDiff.test.js |
| R11.1| advanced branch → approval refused        | I | integration/review.test.js |
| R11.2| commit failure → session stays open       | I | integration/review.test.js |
| R12.1| editing approved session refused          | I | integration/review.test.js |
| R12.2| re-approving refused                       | I | integration/review.test.js |
| R13.1| revoked link grants no access             | I | integration/review.test.js |
| R14.1| mermaid renders, not raw code             | E | e2e/review.spec.js |
| R15.1| unchanged upstream opens plain, no refetch| I | integration/review.test.js |
| R15.2| seen file + upstream move → two-way diff  | I | integration/review.test.js |
| R16.1| edit + upstream drift → three-way, conflict flagged | I | integration/review.test.js |
| R16.2| non-overlapping edits → three-way, no conflict | I | integration/review.test.js |
| R16.3| edit + no upstream drift stays plain      | I | integration/review.test.js |
| R17.1| anchored + free comments created & listed | I | integration/review.test.js |
| R17.2| comment requires a body; resolve & delete | I | integration/review.test.js |
| R17.3| comments scoped to their own session      | I | integration/review.test.js |
| R9.1 | submit with edits: one branch/commit/PR; session stays active | I/E | integration/review.test.js, e2e/review.spec.js |
| R9.2 | several edited files → one commit          | I | integration/review.test.js |
| R9.3 | submit with no edits approves instead      | I/E | integration/review.test.js, e2e/review.spec.js |
| R18.1| (B1) open review PR: reuse branch + PR     | I | integration/review.test.js |
| R18.2| (B2) merged PR, branch alive: reuse branch, new PR | I | integration/review.test.js |
| R18.3| (B3) merged PR, branch deleted: new branch + PR | I | integration/review.test.js |
| R19.1| a failed approval leaves the session unchanged | I/E | integration/review.test.js, e2e/review.spec.js |
| R20.1| commit-submit clears dirty; next no-edit submit approves | I | integration/review.test.js |
| R20.2| a commit failure on a reused branch (B1) never deletes it | I | integration/review.test.js |

## Code corrections driven by these tests

The spec flagged behaviors the implementation did not yet satisfy, now fixed:

- **R4.1** — admin session listing now returns `token` so the link opens the session.
- **R6.3** — file reads are restricted to the session's reviewable file set.
- **R9.3** — approving with no edits closes the session cleanly, committing nothing.
- **R2.3** — session creation now refuses a PR with no reviewable markdown.
- **R19** — `submit()`/`openFile()` in `public/review.html` unconditionally
  flushed the open file to the server before checking for pending edits.
  Since the PUT route always marks a file `dirty=1`, this made "Approve"
  unreachable through the real UI whenever a file was open (i.e. always —
  one auto-opens on load). Both call sites now only save when there are
  actual unsaved keystrokes (`editorDirty`).
- `fakeGithub.js`'s `createPullRequest` did not register the new PR (and
  `commitChanges` did not advance the branch's tracked head SHA), so a
  second real submit through the fake — exactly what re-submission e2e
  coverage needs — threw 404 on `getPRState`. Both are now tracked.
