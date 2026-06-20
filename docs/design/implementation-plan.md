# Implementation Plan — Align Code with `functional-spec.md`

Can we delete this?

**Goal:** Bring the codebase into compliance with `docs/design/functional-spec.md`.
This plan is written to be executed by **smaller/cheaper models**: each task is
small, mechanical, names exact files and symbols, gives the precise logic, and
ends with a runnable verification (`npm test`). Do the phases **in order** — each
builds on the last.

---

## 0. The one divergence that drives everything

**Spec (§2.1):** the "current PR" starts as the **original developer PR**
(`sessions.pr_number` / `sessions.head_branch`). Every "Submit changes" commits
**directly onto the current PR's branch** off its live head. A **new branch + new
PR** is created **only** when the current PR is found **merged or closed** — that
new pair then becomes the current PR.

**Current code (`server/routes/review.js`, submit handler):** the *first* submit
always creates a review branch **and** a review PR (`if (!branch) { needNewBranch
= true; needNewPr = true; }`), and resubmits reuse that review branch. This is the
**old model** the spec's §9 conflict log explicitly overrides.

Everything else in the plan flows from fixing this: the submit handler, the fake
GitHub helper, the integration tests, the e2e test, `test-spec.md`, and two small
UI/admin touch-ups.

### Design decisions (resolve these once, up front)

1. **Current PR is computed, not stored at creation.** Keep
   `submitted_pr_number` / `submitted_pr_url` / `submitted_branch` **NULL until a
   merge/close fallback opens a new PR**. Everywhere that needs the "current PR",
   compute it:
   - `currentPrNumber = session.submitted_pr_number ?? session.pr_number`
   - `currentBranch   = session.submitted_branch  ?? session.head_branch`
   - `currentPrUrl    = session.submitted_pr_url   ?? originalPrUrl(session)`
   - where `originalPrUrl(s) = ` `` `https://github.com/${s.owner}/${s.repo}/pull/${s.pr_number}` ``
   (This avoids a session-creation change and keeps the "edits sent" banner from
   appearing before the first submit. It matches §6's "current PR … is the
   original PR until/unless a fallback opens a new one".)

2. **Reads always track `head_branch`.** `GET /files/*` already fetches upstream
   off `session.head_branch` (spec §3) — **do not change this.** Consequently the
   edit baseline (`file_edits.base_sha`) must always track **`head_branch`'s live
   head**, regardless of which branch the commit landed on. After a submit:
   `base_sha = (committedBranch === session.head_branch) ? newCommitSha
   : <live head of head_branch>`. (When we commit onto `head_branch` itself, its
   new head *is* `newCommitSha`, so the two cases unify.)

3. **Fallback base branch = the current PR's own base ref.** Get it with
   `github.getPR(owner, repo, currentPrNumber)` → `pr.base.ref` (spec §2.1: "off
   the live head of that PR's own base/target branch"). The new PR targets that
   same base ref.

4. **`fakeGithub.commitChanges` must move the branch head and content.** Today it
   only records the call. Because submits now land on `head_branch` (which reads
   query), the fake must, on commit, set
   `headShas[`${owner}/${repo}@${branch}`] = sha` and
   `contentOverrides[file] = content` for each committed file — mirroring the
   real-world invariant the route relies on.

---

## Phase A — Rewrite the submit handler

**File:** `server/routes/review.js`, the `POST /api/:token/submit` handler.

The **APPROVE path** (no dirty files) is already correct — leave it. Replace the
entire **SUBMIT-CHANGES path** (everything after the approve `return`) with the
matrix below.

### A.1 Helper

Add near the top of the file (module scope):

```js
const originalPrUrl = (s) =>
  `https://github.com/${s.owner}/${s.repo}/pull/${s.pr_number}`;
```

### A.2 New submit-changes logic

```
currentPrNumber = session.submitted_pr_number ?? session.pr_number
currentBranch   = session.submitted_branch  ?? session.head_branch

{ state, merged } = await withRetry(getPRState(owner, repo, currentPrNumber))
isOpen = state === 'open' && !merged

createdBranchThisCall = null
try {
  let committedBranch, commitBaseSha, newPrBase
  if (isOpen) {
    // OPEN current PR (incl. first submit → original PR): commit straight onto it
    committedBranch = currentBranch
    commitBaseSha   = await withRetry(getCurrentHeadSha(owner, repo, currentBranch))
  } else {
    // MERGED/CLOSED → fallback: new branch off the current PR's base, then new PR
    const pr      = await withRetry(getPR(owner, repo, currentPrNumber))
    newPrBase     = pr.base.ref
    const baseSha = await withRetry(getCurrentHeadSha(owner, repo, newPrBase))
    committedBranch = await createBranch(
      owner, repo, `review/pr${session.pr_number}-${session.token.slice(0,8)}`, baseSha)
    createdBranchThisCall = committedBranch
    commitBaseSha = baseSha
  }

  const newCommitSha = await commitChanges(
    owner, repo, committedBranch, commitBaseSha,
    dirtyFiles.map(f => ({ filePath: f.file_path,
      content: reconstructMinimalContent(f.original_content, f.content) })))

  let prNumber = currentPrNumber
  let prUrl    = session.submitted_pr_url ?? originalPrUrl(session)
  if (!isOpen) {
    const comments = <SELECT file_path, anchor_text, body FROM comments WHERE session_id=? ORDER BY created_at>
    const pr = await createPullRequest(owner, repo, committedBranch, newPrBase,
      `Review: ${session.pr_title}`, buildPrBody(session, comments))
    createdBranchThisCall = null               // PR now owns the branch
    prNumber = pr.number; prUrl = pr.html_url
    <UPDATE sessions SET submitted_branch=committedBranch,
       submitted_pr_number=prNumber, submitted_pr_url=prUrl WHERE id=session.id>
  }

  // Baseline tracks head_branch's live head (decision #2)
  const targetHead = committedBranch === session.head_branch
    ? newCommitSha
    : await withRetry(getCurrentHeadSha(owner, repo, session.head_branch))
  <UPDATE sessions SET last_action_sha=targetHead WHERE id=session.id>
  for (f of dirtyFiles)
    <UPDATE file_edits SET dirty=0, original_content=content, base_sha=targetHead
       WHERE session_id=? AND file_path=f.file_path>

  res.json({ ok:true, action:'submitted', pr_number:prNumber, pr_url:prUrl, branch:committedBranch })
} catch (err) {
  if (createdBranchThisCall) { try { await deleteBranch(owner, repo, createdBranchThisCall) } catch {} }
  res.status(500).json({ error: err.message })   // session stays active
}
```

**Notes for the implementer**
- Delete the old `branchExists`-based `needNewBranch/needNewPr` block entirely.
- `commitChanges` **returns the new commit SHA** — capture it (the old code threw
  it away). The fake (Phase B) returns it too.
- Keep the existing `buildPrBody` / `commentsSection` helpers; they're only used
  in the fallback now (correct per §4: a plain commit onto an open PR must not
  touch the PR body).
- The APPROVE path still targets `session.pr_number` (the **original** PR) per
  spec §2 — do **not** change it to the current PR for approvals.

### A.3 Surface the current PR on the meta endpoint

In `GET /api/:token` add two computed fields to the JSON so the UI can always
link the current PR (decision #1):

```js
current_pr_number: session.submitted_pr_number ?? session.pr_number,
current_pr_url:    session.submitted_pr_url    ?? originalPrUrl(session),
```

**Verify Phase A:** `npm test` will now FAIL the old integration tests — that is
expected; they are rewritten in Phase D. First do Phase B so the fake supports the
new flow.

---

## Phase B — GitHub adapter & fake

### B.1 `tests/helpers/fakeGithub.js`
1. **`commitChanges`** — after pushing the call record, advance the branch and
   content (decision #4):
   ```js
   headShas[`${owner}/${repo}@${branch}`] = sha;
   for (const { filePath, content } of editedFiles) contentOverrides[filePath] = content;
   ```
   (Keep the `commitShouldFail` throw at the top, before recording.)
2. **`getPR`** — add `base` to the returned object so the fallback can read
   `pr.base.ref`:
   ```js
   return { state: p.state, title: p.title, head: p.head, base: p.base };
   ```
3. No other fake changes needed — `getPRState`, `createBranch`, `createPullRequest`,
   `deleteBranch`, `mergePr`, `pushCommit` already fit.

### B.2 `server/github.js` (real adapter)
- `getPR` already returns the full Octokit payload, which includes `base.ref` — no
  change needed.
- `branchExists` is no longer called by the route. Leave it exported (harmless) or
  remove it along with its test; simpler to **leave it**.
- Everything else in §8 of the spec already exists. No change.

**Verify Phase B:** still run `npm test` — integration tests rewritten in Phase D,
but unit tests (diff, minimalDiff, files, retry) must stay green.

---

## Phase C — Data model (`server/db.js`)

No schema change is required (all columns already exist). Confirm only that the
`comments` table and `file_edits.base_sha` / `file_visits` match spec §7 — they
do. **No edits in this phase** unless a column is missing. (`last_action_sha` is an
extra implementation column; keep it.)

---

## Phase D — Rewrite integration tests

**File:** `tests/integration/review.test.js`. Rewrite each test below so it
asserts the **new** behavior. Keep the helpers (`setup`, `filePath`) but update
fixtures where noted. Add `base: { ref: 'main' }` to the open PR fixture in
`setup()` so the fallback path has a base:

```js
'acme/docs#1': { state:'open', title:'Docs', head:{ref:'feature',sha:'sha-1'},
                 base:{ref:'main'}, files, contents },
```

### D.1 REQ-9 — `R9.1` (first submit commits directly onto `head_branch`)
Replace branch/PR assertions with:
- `res.json.action === 'submitted'`
- `github.calls.createBranch.length === 0`
- `github.calls.createPullRequest.length === 0`
- `github.calls.commitChanges.length === 1`
- `github.calls.commitChanges[0].branch === 'feature'` (the original head branch)
- `github.calls.commitChanges[0].headSha === 'sha-1'` (live head)
- `res.json.pr_number === 1` and `res.json.pr_url` ends with `/pull/1`
- session still `active`; a second PUT still returns 200
- the session row's `submitted_branch` / `submitted_pr_number` are **still NULL**
  (current PR is still the original PR, nothing was opened).

### D.2 `R9.2` (one commit for many files) — minimal change
Still valid; just ensure no branch/PR is created. Add
`assert.equal(github.calls.createPullRequest.length, 0)`.

### D.3 `R9.3` (no edits → approve) — unchanged. Verify still passes.

### D.4 REQ-11
- **`R11.1`** (branch advanced): set `headShas: { 'acme/docs@feature': 'sha-2-newer' }`.
  Assert **no** `createBranch`; `commitChanges[0].branch === 'feature'`;
  `commitChanges[0].headSha === 'sha-2-newer'`; session active.
- **`R11.2`** (commit fails on open PR): `commitShouldFail:true`. Assert 500;
  `createBranch.length === 0`; `deleteBranch.length === 0` (no branch was created
  in this call); session active.
- **`R11.3` / `R11.4b`** (PR-creation failure): these only apply to the **fallback**
  now. Convert them to use a **merged** current PR (see D.7 setup) so a branch is
  created then PR creation fails → assert `deleteBranch.length === 1` and the
  deleted branch equals the created one; session active. If that duplicates D.7,
  fold them into one fallback-failure test and delete the redundant one.
- **`R11.4`** (transient head-read blip retried): keep; first submit now reads
  `getCurrentHeadSha(feature)`. Assert submit recovers (200) and
  `commitChanges.length === 1`. Remove the `createPullRequest` assertion (none on
  an open PR).

### D.5 REQ-20
- **`R20.1`** (baseline advance): after first submit, assert committed file
  `dirty === 0` and `original_content === content`. The next no-edit submit returns
  `action === 'approved'`, `commitChanges.length === 1` (still one). Keep.
- **`R20.2`** (reused/open-branch commit failure leaves branch intact): with an
  open current PR there is no branch to delete, so assert `deleteBranch.length ===
  0`. Simplify the fixture to the plain `setup()` + `commitShouldFail:true` (same
  as D.4 `R11.2`); if identical, keep just one.

### D.6 The two "stays plain / drift still detected" tests
- **"after a commit-submit, re-opening the file stays plain"**: drop the
  `setupWithReviewPr` second half (no review branch exists on first submit anymore).
  Keep the first half: edit → submit → re-GET → `view === 'plain'`,
  `content === '# Intro\nedited\n'`. This now works because `commitChanges` moves
  `feature`'s head to the commit sha and `base_sha` advanced to it.
- **"a later real upstream move is still detected as drift"**: keep as-is; after
  the submit, `pushCommit` on `feature` with new content/sha → re-GET →
  `view === 'three_way'`. Verify.

### D.7 REQ-18 — rewrite the matrix around the **original** PR
Delete `setupWithReviewPr` (it modeled a separate review PR). Replace with the
spec's matrix driven by the **original** PR's state:

- **`R18.1` (B1 → open):** plain `setup()`. Edit + submit + edit again + submit.
  Assert both submits: `createBranch.length === 0`, `createPullRequest.length ===
  0`, each lands a commit on `feature`. (First submit and a later submit while the
  PR is open both commit straight onto `head_branch`.)
- **`R18.2` (merged, base branch alive → new branch off base + new PR):**
  use `setup()` then `github.mergePr('acme','docs',1,{ deleteBranch:false })`
  (the original PR #1 is now merged). Edit + submit. Assert:
  - `createBranch.length === 1`, `createBranch[0].fromSha === 'sha-main'`
    (the live head of base `main` — see fixture note below),
  - `commitChanges[0].branch === <the new branch>`,
  - `createPullRequest.length === 1`, `createPullRequest[0].base === 'main'`,
  - session row `submitted_pr_number` is the new PR (≠ 1), `submitted_branch` set.
  Fixture: add `headShas: { 'acme/docs@main': 'sha-main' }` so the base head is
  resolvable; ensure the `#1` fixture has `base:{ref:'main'}`.
- **`R18.3` (merged again → subsequent submit reuses the *new* current PR):**
  continue from B2 state: a further edit + submit while the new PR is open commits
  straight onto the new branch (no new branch/PR). (This replaces the old
  branch-deleted case; the spec's "branch deleted" nuance is the same fallback path
  already covered by B2, so one matrix test for the fallback + one for reuse is
  enough. Keep three tests total mapping to: open-reuse, fallback-opens-new,
  reuse-the-new.)

> If you prefer to preserve the old B3 "branch deleted" wording, model it by
> merging the original PR and asserting the new branch is created off `main` —
> functionally identical to B2 here because there was never a review branch to
> delete on the first fallback.

### D.8 "settled" tests
- "never acted on → not settled": unchanged.
- "settled after commit-submit": now the commit lands on `feature`; the fake moves
  `feature`'s head to the commit sha and the route pins `last_action_sha` to it →
  `settled === true`. Verify (no test edit likely needed).
- "no longer settled once target branch moves after commit-submit": keep;
  `pushCommit` on `feature` moves the head past `last_action_sha`. Verify.
- "no longer settled after approval": unchanged.

### D.9 Comment, read, revoke, progress tests (REQ-6/7/8/13/15/16/17)
These don't depend on the submit model — **leave them**, but re-run to confirm the
fixture change (added `base`) didn't disturb them.

**Verify Phase D:** `npm test` → all unit + integration green.

---

## Phase E — Update `test-spec.md`

Edit to match the implemented semantics (the functional spec §10 requires this):

1. **REQ-9 `R9.1`** — reword: *"Submitting with edits commits **directly onto the
   PR's head branch** — no new branch, no new PR — and the session stays active and
   editable."*
2. **REQ-18** — replace the "review branch/PR reuse" matrix with the spec §2.1
   matrix keyed on the **current PR** (= original PR initially):
   - B1: current PR **open** → commit onto its branch, no new branch/PR.
   - B2: current PR **merged/closed** → new branch off its **base** branch + new
     PR, which becomes current.
   - B3: a later submit while that new PR is open → reuse it (commit onto its
     branch).
3. **REQ-11** — note PR-creation/branch cleanup applies only to the
   merged/closed **fallback** path.
4. **REQ-12** — confirm it stays marked *(removed)*.
5. Remove the top-of-file **"⚠ two tests … [drives fix]"** note and the
   `[drives fix]` tags on `R4.1` / `R6.3` **iff** those tests now pass (they do in
   the current tree) — or re-verify and keep if genuinely red.
6. Update the **Test Data** table: replace "Review PR fixture (open, or merged with
   branch alive/deleted)" with "Original PR fixture (open; or merged, to drive the
   fallback)".

No assertions live here — it's documentation; keep it consistent with Phase D.

---

## Phase F — UI (`public/review.html`) & admin (`public/admin.html`)

The UI is **mostly already spec-compliant** (mode-aware button, plain-language
banner, two-/three-way panes, confirm modal copy). Only small touch-ups:

### F.1 Banner links the current PR even on first submit
`submit()` already sets `sessionData.submitted_pr_url = result.pr_url` from the
response and calls `showReviewPrBanner()`. Since the response now always carries
a `pr_url` (the original PR on first submit), this works unchanged. **Confirm**
`showReviewPrBanner()` reads `sessionData.submitted_pr_url`. Optionally also seed
`sessionData.submitted_pr_url` from the meta's new `current_pr_url` **only after a
submit/approve** — do **not** show the "edits sent" banner on initial load before
any submit (keep `init()`'s behavior: banner stays hidden until an action). If
`init()` currently calls `showReviewPrBanner()` unconditionally and that would now
show a banner pre-submit, guard it so it only renders when the session has actually
been submitted/approved (e.g. gate on `sessionData.approved_at` OR a client
`hasSubmitted` flag). Today `submitted_pr_url` is null pre-submit, so the existing
guard already prevents this — verify and leave alone if so.

### F.2 Admin shows the current PR (original until fallback)
`admin.html` already renders `submitted_pr_url` when present and an "Approved"
badge from `approved_at`. To satisfy §6 ("current PR … is the original PR until a
fallback"), make the link fall back to the original PR URL when `submitted_pr_url`
is null:
```js
const prHref = s.submitted_pr_url
  || `https://github.com/${s.owner}/${s.repo}/pull/${s.pr_number}`;
const prNum  = s.submitted_pr_number || s.pr_number;
```
and render `prHref`/`prNum` as the "current PR" link for every session. Keep the
status column as **active / revoked** only (already the case).

No copy in the reviewer UI uses GitHub jargon — confirm the banner still reads
*"Your edits have been sent to the development team for implementation."* (§5.3).

---

## Phase G — e2e (`tests/e2e/review.spec.js`, `tests/e2e/fixtureServer.js`)

The submit-flow e2e (around line 51) asserts a banner with "sent to the
development team" and that re-submitting keeps the **same** PR link. Under the new
model:
- The banner link is the **original PR** URL (`…/pull/4` for the `tok-submit`
  fixture). Keep the assertion that the link is **stable across the second
  submit** (B1 reuse) — it is, because both submits report the original PR.
- No fixture change needed unless the fallback path is exercised (it isn't in e2e).
  Add `base:{ref:'main'}` to the `#4` fixture in `fixtureServer.js` for parity with
  Phase B, harmless even if unused.

**Verify Phase G:** `npm run test:e2e` (Playwright). If browsers aren't installed
in the environment, document the command; do not block the unit/integration
completion on it.

---

## Final acceptance (maps to functional-spec §10)

Run `npm test` and confirm:
- [ ] First edit-submit → commit on `head_branch`, **no** `createBranch` /
      `createPullRequest`; session stays `active`. *(D.1)*
- [ ] Re-submit while current PR open → commit on its branch, no new branch/PR.
      *(D.7 B1)*
- [ ] Re-submit after current PR merged/closed → new branch off its **base** + new
      PR, which becomes current. *(D.7 B2)*
- [ ] No-edit submit → `APPROVE` on the **original** PR; no branch/commit/PR.
      *(D.3)*
- [ ] Button reads "Approve" with no edits, "Submit changes" once edited. *(UI,
      e2e)*
- [ ] After commit-submit, committed files are clean; next no-edit submit approves.
      *(D.5 R20.1)*
- [ ] Moved-upstream file opens a diff by default; unchanged opens plain. *(REQ-15,
      unchanged)*
- [ ] Edited + drifted file opens three-way with conflicts flagged. *(REQ-16,
      unchanged)*
- [ ] Comment anchored/general create-list-resolve-delete. *(REQ-17, unchanged)*
- [ ] GitHub failure during submit leaves session editable; only a branch created
      **in that call** (fallback) is removed. *(D.4 R11.2, D.7 fallback-failure)*
- [ ] UI surfaces the current PR URL in plain language. *(F.1/F.2)*
- [ ] `npm test` green; `test-spec.md` updated. *(E)*

## Out of scope (do not implement — spec §11)
Merge-conflict resolution, GitHub inline review comments, auto-merge/close,
multiple reviewer identities, live collaboration, admin auth changes.
