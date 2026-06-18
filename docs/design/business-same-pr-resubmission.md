# Design: Business commits on the same PR (re-submission + Approve)

**Status:** Approved plan, ready to execute.
**Audience:** The engineer / AI agent implementing this. Follow the phases in
order. Each phase is independently shippable and carries its own tests. Keep
diffs small and run `npm test` (+ `npm run test:e2e` for UI phases) green
before moving on.
**Language note:** UI copy in English (matches existing `review.html`).
**Glossary:** "Business" = the reviewer (Nagendra). "Developer" = the author of
the original PR. "Original PR" = the developer's PR the session was opened from
(`sessions.pr_number` / `sessions.head_branch`). "Review branch / review PR" =
the branch + PR the business's edits land on.

---

## 0. Why / the requirements

Today, when the business submits, we **always** create a brand-new branch and a
brand-new PR, then **lock the session** (`status='submitted'`, terminal — no more
edits). That is wrong for the real workflow: the business reviews iteratively and
should keep landing changes on the **same** review PR, and a no-edit review
should simply **approve** the developer's PR.

New behavior we are building:

1. **Business commits on the same PR.** Re-submissions reuse the existing review
   branch + review PR instead of spawning a new pair every time.
2. **Business sees a branch / PR URL.** Once a review PR exists, the UI surfaces
   its link. If no review PR is open yet, "Submit changes" creates the branch and
   the PR.
3. **The session is no longer terminal.** After submitting, the business can
   submit again. Branch/PR selection follows this matrix:

   | Prior review PR state | Review branch | "Submit changes" does | What the business sees on reopen |
   |---|---|---|---|
   | **Merged** | **deleted** | create branch (off target) → commit → open new PR | the **target branch** content |
   | **Merged** | **still active** | commit to existing branch → open new PR | the target branch content (branch == merged) |
   | **Not merged** | (still active) + **commits were done** | commit to the **same** branch (same PR) | **diffs** (existing two-/three-way view) |
   | **Not merged** | (still active) + **no commits yet** | commit to the **same** branch (same PR) | the business's **last edit** |

   "Target branch" = the original PR's head branch (`sessions.head_branch`). Any
   local work the developer pushes may cause merge conflicts on the review PR; the
   **developer resolves those** — out of scope for this tool.

4. **The submit button is dynamic.** With **no pending edits** it reads
   **"Approve"**; clicking it posts a formal **approving review on the original
   developer PR** (unblocking GitHub's merge button). As soon as the business
   makes an edit, the same button changes to **"Submit changes"** and clicking it
   runs the matrix above.

### Decisions already locked (do not re-litigate)

| # | Decision |
|---|----------|
| D1 | **"Approve" = GitHub approval.** A no-pending-edits submit calls `github.approvePullRequest(owner, repo, session.pr_number, body)` which posts a review with `event: 'APPROVE'` on the **original** PR. It writes no branch/commit and opens no review PR. The link stays usable afterwards. |
| D2 | **Re-submission reuses `submitted_branch` / `submitted_pr_*`.** A new branch is created only on (a) the **first** submit, or (b) the prior review PR is **merged AND** its branch was **deleted**. A new **PR** (on the reused branch) is created when the prior review PR is **merged** (its branch may still be alive). When the prior review PR is **open**, reuse both branch and PR — just add a commit. |
| D3 | **Baselines advance after a successful commit-submit.** Every committed `file_edits` row is reset: `dirty=0`, `original_content = <committed content>`, `base_sha = <new commit sha>`. So the next editing round starts clean and the button reverts to "Approve" until the business edits again. |
| D4 | **The session is never locked.** We stop transitioning `status` to `'submitted'`. `status` stays `'active'` through any number of submits; only `revoked` ends a session. The terminal read-only UI is removed. (`requireActiveOrSubmitted` is kept only for backward-compatible reads.) |
| D5 | **Conflicts are the developer's problem.** We always commit off the **live head** of whichever branch we target (review branch when reusing, target branch when creating). We never attempt a merge or rebase; divergent developer work surfaces as a normal GitHub merge conflict on the review PR. |

---

## 1. Current architecture (what you are changing)

Read these before touching anything:

- `server/github.js` — GitHub adapter. Today exports: `getPR, getPRFiles,
  getFileContent, commitChanges, getCurrentHeadSha, createBranch,
  createPullRequest, deleteBranch`.
- `server/routes/review.js` — reviewer API. The piece you rewrite is
  `POST /api/:token/submit` (lines ~231–300) and the `GET /api/:token` payload
  (so the client can compute "pending edits" and show the review-PR link).
- `server/middleware/session.js` — `requireSession` (active only) +
  `requireActiveOrSubmitted`.
- `server/db.js` — SQLite schema + idempotent `ALTER TABLE … ADD COLUMN`
  migrations wrapped in `try{}catch{}`.
- `server/routes/admin.js` / `public/admin.html` — session list; already shows
  `submitted_pr_number/url`.
- `public/review.html` — the whole reviewer SPA (vanilla JS). Submit logic lives
  in `submit()` (~1110), `showSubmittedState()` (~1153), `init()` (~1171), and the
  `#approve-btn` element (~462). Autosave is `saveCurrentFile()` (~1032) and
  `markFileEdited()`.
- `tests/helpers/fakeGithub.js` — in-memory fake. **Every new adapter method must
  be mirrored here** with a `calls.<name>` record.
- `test-spec.md` + `tests/{unit,integration,e2e}` — keep in lock-step per phase.

### Key facts to internalize

- `sessions.submitted_pr_number / submitted_pr_url / submitted_branch` already
  exist and are written by the current submit flow. We **repurpose them as the
  "current review PR / branch"** (overwritten across re-submissions), not a
  one-shot record.
- `commitChanges(owner, repo, branch, headSha, editedFiles)` builds a tree on top
  of `headSha` and force-moves `heads/<branch>`. Reused unchanged; we just choose
  `branch` and `headSha` per the matrix.
- `createBranch` already auto-suffixes on name collision and returns the actual
  name created.
- `reconstructMinimalContent(original_content, content)` (in
  `server/lib/minimalDiff.js`) is still how we turn a stored edit into the bytes
  to commit. Unchanged.
- The current submit deletes a half-created branch on failure via
  `branchToCleanup`. We keep that idea but **only delete branches we created in
  this same call** (never a reused branch).

---

## 2. Phases (ship each one green)

| Phase | Scope | Primary files |
|------|-------|----------------|
| **P0 Adapter + schema** | New adapter methods + fakes; schema columns | `github.js`, `tests/helpers/fakeGithub.js`, `db.js` |
| **P1 Submit matrix** | Rewrite `POST /submit` (Approve + B1/B2/B3 + first-submit); baseline advance (D3); keep session active (D4) | `routes/review.js`, `middleware/session.js`, integration tests, `test-spec.md` |
| **P2 Dynamic button + PR link** | "Approve" ⇄ "Submit changes"; review-PR/branch banner; no terminal lock | `review.html`, `routes/review.js` (GET payload), e2e tests |
| **P3 Admin + polish** | Admin shows current review PR + "approved" marker; spec cleanup | `admin.js`, `admin.html`, `test-spec.md` |

Do not start a phase until the previous one is green.

---

## 3. P0 — GitHub adapter + fake + schema

### 3.1 `server/github.js` — add three methods (keep all existing exports)

```js
// Lightweight PR state for the re-submission matrix.
// octokit.pulls.get returns { state: 'open'|'closed', merged: bool, ... }.
async function getPRState(owner, repo, prNumber) {
  const octokit = getOctokit();
  const { data } = await octokit.pulls.get({ owner, repo, pull_number: prNumber });
  return { state: data.state, merged: !!data.merged };
}

// True if heads/<branch> exists. 404 → false; other errors propagate.
async function branchExists(owner, repo, branch) {
  const octokit = getOctokit();
  try {
    await octokit.git.getRef({ owner, repo, ref: `heads/${branch}` });
    return true;
  } catch (err) {
    if (err.status === 404) return false;
    throw err;
  }
}

// Post an APPROVE review on the ORIGINAL developer PR (unblocks merge button).
// Returns { id, html_url }.
async function approvePullRequest(owner, repo, prNumber, body) {
  const octokit = getOctokit();
  const { data } = await octokit.pulls.createReview({
    owner, repo, pull_number: prNumber, event: 'APPROVE',
    body: body || 'Approved via review tool.',
  });
  return { id: data.id, html_url: data.html_url };
}
```

Add all three to `module.exports`.

### 3.2 `tests/helpers/fakeGithub.js` — mirror them

- Add `getPRState: [], branchExists: [], approvePullRequest: []` to `calls`.
- `getPRState(owner, repo, number)` → push call; read state from the configured
  `prs[key]` fixture. Support new fixture fields `merged` (default `false`) and
  `state` (default `'open'`). Return `{ state, merged }`.
- `branchExists(owner, repo, branch)` → push call; return
  `existingBranches.has(branch)`. (The fake already tracks `existingBranches`,
  adding on `createBranch` and removing on `deleteBranch`.)
- `approvePullRequest(...)` → push call; honor a new `config.approveShouldFail`
  flag (throw) so "approve failed → session unchanged" is testable. Return
  `{ id: 5000 + calls.approvePullRequest.length, html_url: '…' }`.
- Add a `mergePr(owner, repo, number, { deleteBranch })` test helper that flips a
  fixture PR to `{ state:'closed', merged:true }` and optionally removes its head
  ref from `existingBranches`, so a test can simulate "the review PR got merged".

### 3.3 `server/db.js` — one new column

```sql
ALTER TABLE sessions ADD COLUMN approved_at INTEGER;   -- last GitHub approval ts
```

Mirror the existing wrapped-`ALTER` migration pattern. (`submitted_pr_number /
submitted_pr_url / submitted_branch` already exist — reused, no new columns.)

### 3.4 Tests for P0

- Unit: none required for the thin adapter (it is exercised through integration),
  but **do** extend `fakeGithub` self-consistency if there is a fake test.
- Confirm `npm test` is green with the new fake methods present but unused.

---

## 4. P1 — rewrite `POST /api/:token/submit`

Replace the body of the submit handler in `server/routes/review.js`. The handler
now has **two top-level branches**: Approve (no dirty files) and Submit-changes
(dirty files). Pseudocode — implement faithfully:

```js
router.post('/api/:token/submit', requireSession, async (req, res) => {
  const { session } = req;
  const dirtyFiles = db.prepare(
    'SELECT file_path, content, original_content FROM file_edits WHERE session_id = ? AND dirty = 1'
  ).all(session.id);

  // ── APPROVE path (D1): no pending edits → approve the ORIGINAL PR ──
  if (dirtyFiles.length === 0) {
    try {
      const review = await github.approvePullRequest(
        session.owner, session.repo, session.pr_number,
        buildApprovalBody(session)            // optional: summarize comments
      );
      db.prepare('UPDATE sessions SET approved_at = ? WHERE id = ?')
        .run(Date.now(), session.id);
      return res.json({ ok: true, action: 'approved', review_url: review.html_url });
    } catch (err) {
      return res.status(500).json({ error: err.message }); // session unchanged
    }
  }

  // ── SUBMIT-CHANGES path: resolve target branch/PR via the matrix (D2) ──
  let branch     = session.submitted_branch;
  let prNumber   = session.submitted_pr_number;
  let prUrl      = session.submitted_pr_url;
  let needNewBranch = false;
  let needNewPr     = false;

  if (!branch) {
    needNewBranch = true; needNewPr = true;                 // first submit
  } else {
    const { merged } = await withRetry(() =>
      github.getPRState(session.owner, session.repo, prNumber));
    const alive = await withRetry(() =>
      github.branchExists(session.owner, session.repo, branch));
    if (merged) {
      needNewPr = true;                                     // merged → new PR
      if (!alive) needNewBranch = true;                     //   + branch gone → new branch (B3)
      // alive → reuse branch, new PR (B2)
    } else if (!alive) {
      needNewBranch = true; needNewPr = true;               // edge: open PR but branch deleted
    }
    // else: open PR + alive branch → reuse both (B1), needNew* stay false
  }

  // Pick the base SHA to commit on:
  //   new branch  → off the TARGET branch (session.head_branch) live head
  //   reuse branch→ off the REVIEW branch live head (picks up developer commits, D5)
  let createdBranchThisCall = null;
  try {
    let baseSha;
    if (needNewBranch) {
      baseSha = await withRetry(() =>
        github.getCurrentHeadSha(session.owner, session.repo, session.head_branch));
      branch = await github.createBranch(
        session.owner, session.repo,
        `review/pr${session.pr_number}-${session.token.slice(0, 8)}`, baseSha);
      createdBranchThisCall = branch;                       // only THIS gets cleaned up on failure
    } else {
      baseSha = await withRetry(() =>
        github.getCurrentHeadSha(session.owner, session.repo, branch));
    }

    const commitSha = await github.commitChanges(
      session.owner, session.repo, branch, baseSha,
      dirtyFiles.map(f => ({
        filePath: f.file_path,
        content: reconstructMinimalContent(f.original_content, f.content),
      })));

    if (needNewPr) {
      const comments = db.prepare(
        'SELECT file_path, anchor_text, body FROM comments WHERE session_id = ? ORDER BY created_at'
      ).all(session.id);
      const pr = await github.createPullRequest(
        session.owner, session.repo, branch, session.head_branch,
        `Review: ${session.pr_title}`, buildPrBody(session, comments));
      createdBranchThisCall = null;                         // PR now owns the branch
      prNumber = pr.number; prUrl = pr.html_url;
    }

    // Persist current review branch/PR (overwrite — they are "current", not one-shot).
    db.prepare(`UPDATE sessions
       SET submitted_branch = ?, submitted_pr_number = ?, submitted_pr_url = ?
       WHERE id = ?`).run(branch, prNumber, prUrl, session.id);

    // D3 — advance baselines so the next round starts clean.
    const advance = db.prepare(`UPDATE file_edits
       SET dirty = 0, original_content = content, base_sha = ?
       WHERE session_id = ? AND file_path = ?`);
    for (const f of dirtyFiles) advance.run(commitSha, session.id, f.file_path);

    // NOTE: status stays 'active' (D4) — never set 'submitted'.
    res.json({ ok: true, action: 'submitted',
               pr_number: prNumber, pr_url: prUrl, branch });
  } catch (err) {
    if (createdBranchThisCall) {
      try { await github.deleteBranch(session.owner, session.repo, createdBranchThisCall); } catch {}
    }
    res.status(500).json({ error: err.message });           // session stays active
  }
});
```

Helper `buildApprovalBody(session)` may reuse `buildPrBody`'s comment-summary
logic (or just return a short string). Keep `buildPrBody` as-is for the PR body.

### 4.1 `middleware/session.js` (D4)

`requireSession` currently rejects `status === 'submitted'`. Since we never set
`submitted` anymore, this is dead but harmless — **leave it** for safety on legacy
rows, or relax it to allow continued editing. Do **not** add any new lock.
`requireActiveOrSubmitted` stays.

### 4.2 Integration tests (extend `tests/integration`)

Cover the full matrix against `fakeGithub`:

- **First submit (edits):** one `createBranch` (off `head_branch` sha), one
  `commitChanges` on that branch, one `createPullRequest` (head=new branch,
  base=`head_branch`); session stays `active`; `submitted_branch/pr_*` set; the
  edited rows are now `dirty=0` and their `original_content == content` (D3).
- **B1 re-submit, PR open:** seed `submitted_*`, make a new dirty edit, submit →
  **no** new `createBranch`, **no** new `createPullRequest`, exactly one
  `commitChanges` on the **same** branch off its live head.
- **B2 re-submit, PR merged + branch alive:** `mergePr(..., {deleteBranch:false})`
  then submit → **no** `createBranch`, one `commitChanges` on the reused branch,
  **one** new `createPullRequest` (base=`head_branch`); `submitted_pr_number`
  updated.
- **B3 re-submit, PR merged + branch deleted:** `mergePr(..., {deleteBranch:true})`
  then submit → one `createBranch` (off `head_branch`), one `commitChanges`, one
  new `createPullRequest`.
- **Approve (no edits):** submit with zero dirty files → one
  `approvePullRequest` on `session.pr_number`; **no** branch/commit/PR; `approved_at`
  set; session still `active`; can subsequently edit + submit.
- **Failure safety:** `commitShouldFail` on a *first* submit deletes the branch it
  created and leaves the session usable; `commitShouldFail` on a *reuse* (B1)
  submit does **not** delete the reused branch; `approveShouldFail` leaves the
  session unchanged.

### 4.3 `test-spec.md` deltas

- **REQ-9** ("Approval/Submission") → restate as the matrix above. Submission is
  no longer terminal.
- **REQ-12** (read-only lock) → **remove/replace**: there is no post-submit lock;
  the session stays editable.
- **New REQ-18 — Same-PR re-submission:** B1/B2/B3 branch/PR selection.
- **New REQ-19 — Approve posts a GitHub review** on the original PR; no branch/PR.
- **New REQ-20 — Baseline advance (D3):** after a commit-submit, committed files
  are no longer dirty and re-approving (no new edits) opens no PR.

---

## 5. P2 — dynamic button + review-PR link (`public/review.html`)

### 5.1 GET payload additions (`routes/review.js`, `GET /api/:token`)

Add to the response:
- `submitted_pr_number`, `submitted_pr_url`, `submitted_branch` (so the UI can
  render the review-PR/branch link — req 2).
- `approved_at` (so the UI can show an "Approved" affordance).
- Per file: include a `dirty` boolean (from `file_edits.dirty`) **in addition to**
  the existing `edited` flag, so the client can compute "are there pending edits".
  (Today `edited` means "has an edit row ever"; `dirty` means "uncommitted".)

### 5.2 Button label logic (req 4)

The `#approve-btn` becomes mode-aware. Add `function refreshSubmitButton()`:

```
hasPendingEdits = (any file in sessionData.files with dirty === true)
                  || editorHasUnsavedChanges   // local, set on Toast UI 'change'
if hasPendingEdits:  btn.textContent = 'Submit changes'
else if approved_at: btn.textContent = 'Approved ✓'   // still clickable to re-approve
else:                btn.textContent = 'Approve'
```

- Call `refreshSubmitButton()` in `init()`, after every autosave
  (`markFileEdited`), after each file open, and after a submit completes.
- The single click handler stays `submit()`. The **server** decides Approve vs
  Submit-changes by whether dirty rows exist — the client label is cosmetic but
  must match. (Save pending editor changes **before** POST, as today, so the
  server sees the dirty rows for a "Submit changes" click.)

### 5.3 Submit handling — no terminal lock

- **Remove** `showSubmittedState()`'s locking behavior. After a `submitted`
  response: keep the editor editable, show a **persistent banner** linking
  `submitted_pr_url`. The business reviewer doesn't know what a "PR" or branch
  is, so the banner avoids that vocabulary and instead explains the action in
  plain terms, e.g. `Your changes have been committed — saved permanently and
  sent to the development team for review. [View on GitHub]`. Then
  `refreshSubmitButton()` (baselines advanced ⇒ reverts to "Approve").
- After an `approved` response: toast "Approved on GitHub", set `approved_at`
  locally, `refreshSubmitButton()` → "Approved ✓".
- The confirm modal copy that says *"Once you submit, you will not be able to edit
  any files."* is now **false** — replace with copy that names no GitHub
  jargon ("PR", branch) and instead explains what "commit" means for a
  non-technical reviewer, e.g. *"Your edits will be committed — saved
  permanently and sent to the development team for review."* for the edits
  case; *"This posts your approval on GitHub with no changes."* for the
  approve case (title: "Approve this review?", not "Approve this PR?"). The
  unopened-files warning can stay for both cases.
- `init()`: drop the `status === 'submitted'` terminal branch; always wire up the
  editable controls. Surface the review-PR banner if `submitted_pr_url` is present.

### 5.4 e2e (`tests/e2e/review.spec.js`)

- Button reads **"Approve"** on a fresh session with no edits; flips to **"Submit
  changes"** after typing in the editor.
- Submitting edits shows the review-PR banner and the editor **stays editable**;
  a second edit flips the label back to "Submit changes" and a second submit
  reuses the same PR (assert via the fake/admin or a stubbed response).
- Clicking **"Approve"** (no edits) shows the approved toast and the
  `approvePullRequest` call is recorded.

---

## 6. P3 — admin + polish

- `routes/admin.js` `GET /sessions`: already selects `submitted_pr_*`. Add
  `approved_at`. Drop any `edits_count`-as-terminal assumptions.
- `public/admin.html`: show the **current** review PR link (it may change across
  re-submissions) and an "Approved" badge when `approved_at` is set. Remove any
  "submitted/locked" status string (sessions are `active` or `revoked`).
- Sweep `test-spec.md` for stale "approved"/"submitted-terminal" language.

---

## 7. Acceptance checklist (definition of done)

- [ ] First edit-submit creates `review/pr<N>-<token>` off `head_branch`, commits
      once, opens one PR → `head_branch`; session stays editable. *(req 1,2)*
- [ ] Re-submit with the review PR **open** adds a commit to the **same** branch
      and opens **no** new PR. *(req 3, B1)*
- [ ] Re-submit after the review PR **merged** opens a new PR — reusing the branch
      if it still exists, creating a fresh branch off `head_branch` if it was
      deleted. *(req 3, B2/B3)*
- [ ] "Approve" (no pending edits) posts an APPROVE review on the **original** PR
      and creates no branch/commit/PR; the link stays usable. *(req 4, D1)*
- [ ] The button reads "Approve" with no pending edits and "Submit changes" once
      the business edits. *(req 4)*
- [ ] After a commit-submit, committed files are no longer "dirty" and the next
      no-edit submit approves rather than re-commits. *(D3)*
- [ ] A GitHub failure during submit leaves the session editable and removes only
      a branch created in that same call. *(D5)*
- [ ] The UI surfaces the review branch/PR URL once it exists. *(req 2)*
- [ ] `npm test` and `npm run test:e2e` pass; `test-spec.md` reflects REQ-9/12
      changes and adds REQ-18/19/20.

---

## 8. Explicitly out of scope (note, don't build)

- Merge-conflict resolution between developer pushes and the review branch — the
  developer handles these on GitHub (D5).
- Posting reviewer comments as GitHub **inline review comments** (unchanged from
  the prior design — comments are summarized into the review PR body).
- Auto-merging or closing the review PR from the tool.
- Multiple distinct reviewer identities within one session.
</content>
</invoke>
