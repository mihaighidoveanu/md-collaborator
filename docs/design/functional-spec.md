# Reference Functional Spec: Reviewer Workflow

**Status:** Reference specification of the desired end-state functionality.

**Audience:** Engineers / AI agents working on the reviewer workflow, and anyone
who needs the single authoritative description of *what the system does*.


**Glossary:**
- **Business / Reviewer** ("Nagendra") — the person reviewing a PR's markdown
  through a tokenized review link. A single anonymous identity per session (the
  token *is* the identity).
- **Developer** — the author of the original PR.
- **Original PR** — the developer's PR the session was opened from
  (`sessions.pr_number` / `sessions.head_branch`).
- **Target branch** — the original PR's head branch (`sessions.head_branch`).
- **Current PR / current branch** — the PR + branch the business's edits land on
  *right now*. It starts out as the **original PR** / `head_branch` itself — there
  is no separate review branch while the original PR is open. It only changes if
  the current PR is merged or closed: a new branch (off that PR's own base/target
  branch) and a new PR are opened, and that pair becomes the new "current" PR.

---

## 1. Functional overview

The reviewer opens a review link for a PR and works on its markdown. The system
guarantees the following behavior:

1. **Direct commits to the original PR.** While the original PR is open, the
   reviewer's edits commit straight onto its own branch (`head_branch`) — there
   is no separate review branch or review PR in the common case. Only if that PR
   gets merged or closed does the tool fall back to opening a new branch + PR
   (see §2.1).
2. **Change awareness.** When the reviewer reopens a file, they see what changed
   since the last time they looked at it.
3. **Comments.** The reviewer can leave explanatory comments, either anchored to
   a specific paragraph or as a free / general note.
4. **Edits commit to the current PR.** Submitting edits commits directly to the
   branch of whichever PR is currently "current" (the original PR, or its
   merged-PR fallback successor — see §2.1).
5. **Edit-vs-upstream diff.** When upstream moved while the reviewer had unsent
   edits, they see their own unsent edits diffed directly against the
   developer's latest upstream content. The base they started from is not part
   of the comparison — once an edit exists, what matters is how it differs from
   what's current now, not a reconciliation against the original.
6. **Iterative, non-terminal review.** The session is never locked. The reviewer
   can keep editing and re-submitting; re-submissions land on the *same* current
   PR. A no-edit submission posts a formal GitHub **approval** on the current PR
   instead.

The session ends only by being **revoked**. There is no terminal "submitted"
state.

---

## 2. Submit / Approve behavior (the core flow)

The single submit control is **mode-aware**, decided by whether the reviewer has
pending (uncommitted/dirty) edits:

- **No pending edits → "Approve".** Clicking posts a formal **approving review on
  the current PR** (GitHub `event: 'APPROVE'`), unblocking GitHub's merge button.
  It writes no branch, no commit, and opens no PR. Records `approved_at` on the
  session. The session stays active and editable.
- **Pending edits → "Submit changes".** Clicking commits the reviewer's edits
  directly onto the branch of the **current PR** per the matrix below.

### 2.1 Re-submission matrix

"Submit changes" always targets the **current PR** — initially the **original**
developer PR (`sessions.pr_number` / `head_branch`), so the very first submit
already commits straight onto `head_branch`. There is no separate review branch
or review PR while that PR stays open. The current PR only changes if it gets
merged or closed, in which case a new branch + PR is opened and *that* becomes
the new current PR for all subsequent submits. We always commit off the **live
head** of whichever branch we target — we never merge or rebase; divergent
developer work surfaces as a normal GitHub merge conflict that the **developer**
resolves.

| Current PR state | "Submit changes" does | What the reviewer sees on reopen |
|---|---|---|
| **Open** (original PR, first submit) | commit directly onto `head_branch` (live head) — no new branch, no new PR | their edits |
| **Open** (current PR, later submits) | commit directly onto its branch (live head) — no new branch, no new PR | **diffs** (two-way view) |
| **Merged or closed** | create a new branch off the **live head of that PR's own base/target branch** → commit → open a **new** PR targeting that base branch; this new PR becomes the current PR | the target branch content |

Rules:
- A new **branch + PR** is created **only** when the current PR is no longer
  open (merged or closed). Otherwise, every submit is a plain commit onto the
  current PR's existing branch.
- The new branch's base is the *current PR's own base branch* (e.g. the branch
  it targeted, such as `main`) — not necessarily `sessions.head_branch`, since
  that branch may itself be gone after a merge.
- After this fallback runs once, `submitted_pr_number` / `submitted_pr_url` /
  `submitted_branch` are updated to the new PR/branch, and all further submits
  follow the **Open** row against *that* PR — until/unless it, too, gets merged
  or closed.

### 2.2 Baselines advance after a commit-submit

After a successful commit-submit, every committed file's edit row is reset to a
clean baseline: not dirty, `original_content` becomes the committed content, and
`base_sha` becomes the new commit SHA. The next editing round starts clean, and
the button reverts to "Approve" until the reviewer edits again.

### 2.3 Failure safety

Any GitHub failure during submit leaves the session **active and editable** —
never half-submitted. Only a branch created *in that same call* is cleaned up on
failure; a reused branch is never deleted. An approve failure leaves the session
unchanged.

---

## 3. Change-aware file view

When the reviewer opens a file (`GET /api/:token/files/<path>`), the server
fetches the current upstream content (off the live head of `head_branch`, falling
back to `session.head_sha` if that lookup fails) and decides a `view`:

- **`plain`** — no prior "seen" snapshot differs and no dirty edit with drift.
  Loads the content straight into the editor; no reference pane.
- **`two_way`** — something needs to be diffed against the current upstream.
  `diffSource` says which side it's diffed from:
  - `diffSource: 'seen'` — no pending edit; the file changed upstream since the
    reviewer last looked at it. Payload includes the prior seen content, the
    upstream content, and `lineDiff(seen, upstream)`. *(req 2)*
  - `diffSource: 'edit'` — the reviewer has a dirty local edit **and** upstream
    differs from the edit's base (`original_content`, used only to detect that
    drift happened — never displayed). Payload includes the reviewer's edit
    (as `seen`), the upstream content, and `lineDiff(mine, upstream)`. *(req 5)*

After computing the response, the **seen snapshot advances** (the upstream
content becomes the new "seen" watermark) — but only for active sessions, so
read-only reads don't move the watermark.

The diff view **opens by default** when there is something to show; the editor is
never gated behind a button.

All diffing is **line-based** and **computed server-side** (built on the existing
`lcsIndices` LCS helper). The browser only renders the server-provided `diff`
arrays — no client-side diff computation, no npm diff library.

---

## 4. Comments

- **Anchored comment.** Hovering a paragraph in the editor reveals a small
  comment-icon button at the paragraph's right edge; clicking it anchors a comment
  to that paragraph. Stored with both `paragraph_index` (fast path) and
  `anchor_text` (the paragraph text, for re-anchoring when paragraphs shift).
- **General / free comment.** A button with the **same comment icon**, placed
  top-right next to the editor (left of the submit button), creates an unanchored
  comment (`file_path = currentFile` when a file is open, else `null`).
- **Re-anchoring on render.** Try `paragraph_index`; if that paragraph's text no
  longer **exactly** matches `anchor_text`, locate the paragraph whose text equals
  `anchor_text`; if neither matches, render the comment as **"detached"** (still
  visible, just not pinned). This logic lives in the browser.
- **Comments panel.** A right-hand collapsible panel lists comments for the
  current file (anchored ones near the top with the quoted `anchor_text`) plus
  general comments. Each row shows body, relative time, a resolve toggle, and a
  delete action. Clicking an anchored comment scrolls to / highlights its
  paragraph.
- **Persistence & travel.** Comments are stored locally and travel with the
  **current PR**. When a new PR is opened (the merged/closed fallback in §2.1),
  the existing comments are **summarized into its body**; a plain commit onto an
  already-open current PR does not touch that PR's body. Posting comments as
  GitHub *inline review comments* is out of scope.

API: `GET /comments` (visible to active and previously-submitted sessions),
`POST /comments` (`body` required, non-empty), `PATCH /comments/:id { resolved }`,
`DELETE /comments/:id`. Mutations are scoped to the owning session.

---

## 5. Reviewer UI

Single-file vanilla-JS SPA (`public/review.html`), Toast UI editor, English copy.

### 5.1 Dynamic submit button

The button label reflects pending state and is refreshed on init, after every
autosave, after each file open, and after a submit completes:

- pending edits → **"Submit changes"**
- no pending edits, previously approved → **"Approved ✓"** (still clickable to
  re-approve)
- no pending edits, never approved → **"Approve"**

The single click handler always calls submit; the **server** decides Approve vs
Submit-changes by whether dirty rows exist (the label is cosmetic but must
match). Pending editor changes are saved **before** the POST so the server sees
the dirty rows.

### 5.2 Diff / reconciliation panes

- `plain` → editor only.
- `two_way` → a collapsible reference pane **beside** the editor (reference
  left, editor right) shows a **2-column** diff: the reviewer's prior version
  on the left, the developer's current upstream on the right. Rows are paired
  by position from `lineDiff(left, upstream)`: a line present (and differing)
  on both sides is one row marked **changed** (`diffSource: 'edit'` labels this
  "Conflict" — there's a pending edit at stake; `diffSource: 'seen'` labels it
  plain "Changed" — informational only, nothing of the reviewer's is at risk);
  a line only upstream is **addition**-marked; a line only on the left is
  **deletion**-marked. A legend explains the markers so the view survives
  grayscale / colorblindness.
  - `diffSource: 'seen'` — left column is "Your last-seen version" (no pending
    edit; purely informational about what moved upstream).
  - `diffSource: 'edit'` — left column is "Your edits." The editor mounts on
    `upstream` and **editing always continues from upstream** — the reviewer
    re-applies their own changes (left column) into the editor by hand, and the
    result autosaves. (Rationale: committing a mine-based version would revert
    other lines the developer changed upstream; re-applying onto upstream
    cannot.) The original base they started from is never shown or computed —
    only `mine` and `upstream` matter once an edit exists.
  - Editor always mounts on `upstream` in both cases.

The reference pane is collapsible (Hide/Show).

### 5.3 No terminal lock; current-PR banner

The session is **never read-only**. After a submit, the editor stays editable.

- After a **submitted** response: show a **persistent banner** linking the
  current PR (the original developer PR, until/unless a merge/close fallback
  opens a new one), then refresh the button (baselines advanced ⇒ reverts to
  "Approve"). The banner uses **no GitHub jargon** ("PR", "branch", "commit",
  "GitHub") — the business reviewer doesn't know those terms. Example: *"Your
  edits have been sent to the development team for implementation. [View
  details]"*.
- After an **approved** response: toast *"Approval sent to the developers"*, set
  `approved_at` locally, refresh button → "Approved ✓".
- The confirm modal names no GitHub jargon and states the outcome plainly:
  - edits case (title "Submit your changes?"): *"Your edits will be sent to the
    development team for implementation."*
  - approve case (title "Approve this review?"): *"This sends your approval to the
    developers with no changes."*
  - The unopened-files warning modal stays for both cases.

The current-PR banner (and its link) only appears once the session has
produced a **submitted** response — there is no banner, and no PR link in the
header, before the reviewer's first submit, even though the original PR
exists from session creation. *(req 2 of the re-submission spec)*

---

## 6. Admin surface

- `GET /sessions` returns each session's **current** PR
  (`submitted_pr_number` / `submitted_pr_url`) and `approved_at`. This is the
  original PR until/unless a merge/close fallback opens a new one.
- `admin.html` shows the current PR link and an **"Approved"** badge when
  `approved_at` is set.
- Sessions are displayed as **`active`** or **`revoked`** only — there is no
  "submitted/locked" status.
- Revoke is unchanged (`active` → `revoked`).

---

## 7. Data model

`server/db.js` — SQLite, additive `ALTER TABLE … ADD COLUMN` migrations wrapped in
`try{}catch{}`.

**`sessions`** (PR / branch are "current" — initialized to the original PR /
`head_branch`, overwritten only when a merge/close fallback opens a new PR):
- `submitted_pr_number INTEGER`, `submitted_pr_url TEXT`, `submitted_branch TEXT`
- `approved_at INTEGER` — timestamp of the last GitHub approval

**`file_edits`**:
- `original_content` — the **base**: content the reviewer first started editing
  from (first-write-wins via `COALESCE`). Used only to detect whether upstream
  has drifted since (`upstream !== base`); never displayed or diffed itself —
  the edit-vs-upstream diff (`diffSource: 'edit'`) compares `mine` directly
  against `upstream`. Advanced to the committed content after a commit-submit.
- `base_sha TEXT` — `session.head_sha` at first save; advanced to the new commit
  SHA after a commit-submit.
- `dirty` — whether the row has uncommitted edits (reset to 0 after commit).

**`file_visits`** (memory of what was seen, for change-awareness):
- `seen_content TEXT`, `seen_sha TEXT`, `visited_at` (updated on every open).

**`comments`**:
```sql
CREATE TABLE IF NOT EXISTS comments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id      TEXT NOT NULL,
  file_path       TEXT,            -- NULL = session-level free comment
  anchor_text     TEXT,            -- snapshot of paragraph text; NULL = unanchored
  paragraph_index INTEGER,         -- 0-based index at creation; NULL = unanchored
  body            TEXT NOT NULL,
  resolved        INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  FOREIGN KEY(session_id) REFERENCES sessions(id)
);
```

---

## 8. GitHub adapter

`server/github.js` exports (every method mirrored in
`tests/helpers/fakeGithub.js` with a `calls.<name>` record):

- `getPR`, `getPRFiles`, `getFileContent`, `commitChanges`, `getCurrentHeadSha`
- `createBranch(owner, repo, newBranch, fromSha)` — creates `heads/<newBranch>`;
  auto-suffixes on name collision; returns the actual name created. Used **only**
  in the merge/close fallback (§2.1) — never on a normal submit against an open
  current PR.
- `createPullRequest(owner, repo, head, base, title, body)` → `{ number, html_url }`.
  Used only in the same fallback.
- `deleteBranch(owner, repo, branch)` — used to clean up a branch created in a
  failed fallback submit call.
- `getPRState(owner, repo, prNumber)` → `{ state, merged }` — checked on every
  submit to decide whether the current PR is still open or needs the fallback.
- `approvePullRequest(owner, repo, prNumber, body)` → posts `event: 'APPROVE'`
  review on the **current** PR; returns `{ id, html_url }`.

Supporting server libs:
- `server/lib/diff.js` — `lineDiff(oldText, newText)`, line-based on
  `lcsIndices`. Used for both `diffSource` cases (`seen`/`edit`).
- `server/lib/minimalDiff.js` — `reconstructMinimalContent(original, content)`
  turns a stored edit into the bytes to commit; `lcsIndices(a, b)`.

---

## 9. Conflict resolution log

Where the two source specs disagreed, the later
(`business-same-pr-resubmission.md`) wins:

| Topic | Older spec (Nagendra) | Resolution (this doc) |
|---|---|---|
| **Submit creates branch/PR** | Always a brand-new branch **and** new PR every submit. | Re-submission **reuses** the existing review branch + PR; new branch/PR created only per the matrix (§2.1). |
| **Session lifecycle** | `active → submitted` (terminal) or `→ revoked`; "approved" renamed to "submitted". | Session **never locked**; stays `active` through any number of submits; ends only via `revoked`. No `submitted` status. |
| **Read-only after submit** | Editor locked, no reference pane, composer hidden post-submit (REQ-12). | **Removed** — editor stays editable; review-PR banner shown instead. |
| **"Approve" action** | Removed entirely; replaced by the PR/submit model (no direct-commit path). | **Reintroduced** as a *GitHub approval review* on the original PR for the no-edits case. (Still no direct-commit-to-branch path.) |
| **Submit button** | A single static "Submit for PR" button. | **Mode-aware** "Approve" ⇄ "Submit changes" by pending-edit state. |
| **Conflict handling on submit** | Don't 409; branch off the live head so we never clobber. | Same intent, generalized: always commit off the live head of the targeted branch; conflicts are the **developer's** problem (no merge/rebase). |
| **Baselines** | Base captured first-write-wins; not advanced. | Baselines **advance** after a successful commit-submit so the next round starts clean. |
| **Submit destination** | `business-same-pr-resubmission.md` describes a dedicated review branch + review PR, separate from the original PR, created on first submit and reused/recreated per its own matrix. | **Overridden by direct instruction**: there is no separate review branch/PR while the original PR is open. Submits commit straight onto the original PR's own branch (`head_branch`). A new branch + PR is opened **only** as a fallback once the current PR is merged or closed (§2.1). `business-same-pr-resubmission.md` is left as-is (historical) and is now superseded on this point by this document. |

United without conflict from both specs: change-aware file view (two-way,
including the edit-vs-upstream diff), comments (anchored + general, panel,
re-anchoring, travel with the current PR), server-side line diffing, the
comments table / `file_edits.base_sha` / `file_visits` seen-snapshot data
model, and the GitHub adapter surface.

---

## 10. Acceptance checklist (definition of done)

- [ ] First edit-submit commits **directly onto `head_branch`** of the original
      PR — no new branch, no new PR; the session stays editable. *(req 1, 4)*
- [ ] Re-submit while the current PR is still **open** adds a commit straight
      onto its existing branch — no new branch, no new PR.
- [ ] Re-submit after the current PR is **merged or closed** opens a fresh branch
      off that PR's own base/target branch and a new PR, which becomes the
      current PR for subsequent submits.
- [ ] "Approve" (no pending edits) posts an APPROVE review on the **current** PR
      and creates no branch/commit/PR; the link stays usable.
- [ ] The button reads "Approve" with no pending edits and "Submit changes" once
      the reviewer edits.
- [ ] After a commit-submit, committed files are no longer dirty and the next
      no-edit submit approves rather than re-commits.
- [ ] Reopening a file that moved upstream shows a diff **by default**; an
      unchanged file opens straight into the editor. *(req 2)*
- [ ] A file with unsent local edits **and** upstream drift opens a two-column
      diff of **Your edits | Developer's version** (no base/original shown)
      with conflicting lines flagged; the reviewer re-applies their edits onto
      upstream and the result autosaves. *(req 5)*
- [ ] Hovering a paragraph reveals a comment button that anchors a comment; the
      top-right button creates a general comment; both list, resolve, delete.
      *(req 3)*
- [ ] A GitHub failure during submit leaves the session editable and removes only
      a branch created in that same call (the merge/close fallback only).
- [ ] The UI surfaces the current PR's URL via the persistent banner once a
      submit has produced one — not before the reviewer's first submit — in
      plain non-GitHub language.
- [ ] `npm test` and `npm run test:e2e` pass; `test-spec.md` reflects the current
      semantics (REQ-9 matrix, REQ-12 removed, REQ-15/16/17 change-aware /
      edit-vs-upstream diff / comments, REQ-18/19/20 re-submission / approve /
      baseline advance).

---

## 11. Explicitly out of scope

- Merge-conflict resolution between developer pushes and the reviewer's commits
  on the current PR's branch — the developer handles these on GitHub.
- Posting reviewer comments as GitHub **inline review comments** (paragraph →
  diff-line mapping). Comments are summarized into the new PR's body only when
  the merge/close fallback opens one.
- Auto-merging or closing the current PR from the tool.
- Multiple distinct reviewer identities within one session.
- Real-time collaboration / live cursors.
- Auth changes to the admin surface.
</content>
</invoke>
