# Reference Functional Spec: Reviewer Workflow

**Status:** Reference specification of the desired end-state functionality.
**Audience:** Engineers / AI agents working on the reviewer workflow, and anyone
who needs the single authoritative description of *what the system does*.
**How this was produced:** This is the overlay of two design specs —
`nagendra-review-workflow.md` (the base reviewer workflow) with
`business-same-pr-resubmission.md` (the later re-submission / Approve model)
layered on top. Where the two conflict, the later spec wins (see
[§9 Conflict resolution log](#9-conflict-resolution-log)); everything else is
united here. This document describes desired functionality only — not the
phased implementation history.

**Glossary:**
- **Business / Reviewer** ("Nagendra") — the person reviewing a PR's markdown
  through a tokenized review link. A single anonymous identity per session (the
  token *is* the identity).
- **Developer** — the author of the original PR.
- **Original PR** — the developer's PR the session was opened from
  (`sessions.pr_number` / `sessions.head_branch`).
- **Target branch** — the original PR's head branch (`sessions.head_branch`).
- **Review branch / Review PR** — the branch + PR the business's edits land on.

---

## 1. Functional overview

The reviewer opens a review link for a PR and works on its markdown. The system
guarantees the following behavior:

1. **Non-blocking review.** The reviewer's work never overwrites the developer's
   branch directly. Edits land on a separate review branch via a review PR.
2. **Change awareness.** When the reviewer reopens a file, they see what changed
   since the last time they looked at it.
3. **Comments.** The reviewer can leave explanatory comments, either anchored to
   a specific paragraph or as a free / general note.
4. **Edits become a review PR.** Submitting edits commits to a review branch and
   opens (or reuses) a review PR that targets the developer's head branch.
5. **Three-way reconciliation.** When upstream moved while the reviewer had
   unsent edits, they see a three-way view: the base they started from, the new
   upstream content, and their own unsent edits.
6. **Iterative, non-terminal review.** The session is never locked. The reviewer
   can keep editing and re-submitting; re-submissions land on the *same* review
   PR. A no-edit submission posts a formal GitHub **approval** on the original PR.

The session ends only by being **revoked**. There is no terminal "submitted"
state.

---

## 2. Submit / Approve behavior (the core flow)

The single submit control is **mode-aware**, decided by whether the reviewer has
pending (uncommitted/dirty) edits:

- **No pending edits → "Approve".** Clicking posts a formal **approving review on
  the original developer PR** (GitHub `event: 'APPROVE'`), unblocking GitHub's
  merge button. It writes no branch, no commit, and opens no review PR. Records
  `approved_at` on the session. The session stays active and editable.
- **Pending edits → "Submit changes".** Clicking commits the reviewer's edits to
  a review branch and opens or reuses a review PR per the matrix below.

### 2.1 Re-submission matrix

"Submit changes" picks its branch / PR per the prior review PR's state. We always
commit off the **live head** of whichever branch we target — we never merge or
rebase; divergent developer work surfaces as a normal GitHub merge conflict that
the **developer** resolves.

| Prior review PR state | Review branch | "Submit changes" does | What the reviewer sees on reopen |
|---|---|---|---|
| **None (first submit)** | — | create branch off **target branch** → commit → open new PR | their edits |
| **Open** + commits exist | still active | commit to the **same** branch (same PR) | **diffs** (two-/three-way view) |
| **Open** + no commits yet | still active | commit to the **same** branch (same PR) | their **last edit** |
| **Merged** + branch still alive | active | commit to existing branch → open **new** PR | target branch content |
| **Merged** + branch deleted | deleted | create branch off **target branch** → commit → open **new** PR | the **target branch** content |
| **Open** + branch deleted (edge) | deleted | create new branch off target → commit → open new PR | their edits |

Rules:
- A new **branch** is created only on (a) the first submit, or (b) the prior
  review PR was **merged AND** its branch was **deleted** (or the edge case where
  an open PR's branch was deleted).
- A new **PR** is created on first submit and whenever the prior review PR is
  **merged** (the branch may still be alive — reuse it).
- When the prior review PR is **open** with an alive branch, reuse **both** branch
  and PR — just add a commit.

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
- **`two_way`** — the file changed upstream since the reviewer last looked at it.
  Payload includes the prior seen content, the upstream content, and a
  `lineDiff(seen, upstream)`. *(req 2)*
- **`three_way`** — the reviewer has a dirty local edit **and** upstream differs
  from the edit's base (`original_content`). Payload includes `{ base, upstream,
  mine }` and a `threeWay(base, upstream, mine)` alignment with conflict rows
  flagged. *(req 5)*

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
- **Persistence & travel.** Comments are stored locally and **summarized into the
  review PR body** so they travel with the PR. Posting them as GitHub *inline
  review comments* is out of scope.

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
- `two_way` → a collapsible reference pane **above** the editor showing
  `lineDiff(seen, upstream)` (GitHub-style: added lines green `#dcffe4/#22863a`,
  removed red `#ffeef0/#cb2431`), informational "here's what moved since you last
  looked." Editor mounts on `upstream`.
- `three_way` → reference pane **beside** the editor (reference left, editor
  right) for compare-while-editing. The reference is a **2-column** view
  **Original | Your edits** with a role-based left-gutter marker on each changed
  row: `✎` green = you edited this line; `</>` blue = it came from the developer's
  commit (the editor on the right has the new version); `⚠` amber = conflict, both
  sides changed it. A legend explains the markers so the view survives grayscale /
  colorblindness. The editor mounts on `upstream` and **editing always continues
  from upstream** — the reviewer re-applies their own changes (left column) into
  the editor by hand, and the result autosaves. (Rationale: committing a
  mine-based version would revert other lines the developer changed upstream;
  re-applying onto upstream cannot.)

The reference pane is collapsible (Hide/Show).

### 5.3 No terminal lock; review-PR banner

The session is **never read-only**. After a submit, the editor stays editable.

- After a **submitted** response: show a **persistent banner** linking the review
  PR, then refresh the button (baselines advanced ⇒ reverts to "Approve"). The
  banner uses **no GitHub jargon** ("PR", "branch", "commit", "GitHub") — the
  business reviewer doesn't know those terms. Example: *"Your edits have been sent
  to the development team for implementation. [View details]"*.
- After an **approved** response: toast *"Approval sent to the developers"*, set
  `approved_at` locally, refresh button → "Approved ✓".
- The confirm modal names no GitHub jargon and states the outcome plainly:
  - edits case (title "Submit these changes?"): *"Your edits will be sent to the
    development team for implementation."*
  - approve case (title "Approve this review?"): *"This sends your approval to the
    developers with no changes."*
  - The unopened-files warning modal stays for both cases.

The UI surfaces the review branch / PR URL once it exists. *(req 2 of the
re-submission spec)*

---

## 6. Admin surface

- `GET /sessions` returns each session's **current** review PR
  (`submitted_pr_number` / `submitted_pr_url`) and `approved_at`. The review PR
  may change across re-submissions.
- `admin.html` shows the current review-PR link and an **"Approved"** badge when
  `approved_at` is set.
- Sessions are displayed as **`active`** or **`revoked`** only — there is no
  "submitted/locked" status.
- Revoke is unchanged (`active` → `revoked`).

---

## 7. Data model

`server/db.js` — SQLite, additive `ALTER TABLE … ADD COLUMN` migrations wrapped in
`try{}catch{}`.

**`sessions`** (review-PR / branch are "current", overwritten across
re-submissions):
- `submitted_pr_number INTEGER`, `submitted_pr_url TEXT`, `submitted_branch TEXT`
- `approved_at INTEGER` — timestamp of the last GitHub approval

**`file_edits`**:
- `original_content` — the **base**: content the reviewer first started editing
  from (first-write-wins via `COALESCE`); the base leg of the three-way diff.
  Advanced to the committed content after a commit-submit.
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
  auto-suffixes on name collision; returns the actual name created.
- `createPullRequest(owner, repo, head, base, title, body)` → `{ number, html_url }`.
- `deleteBranch(owner, repo, branch)` — used to clean up a branch created in a
  failed submit call.
- `getPRState(owner, repo, prNumber)` → `{ state, merged }` — drives the
  re-submission matrix.
- `branchExists(owner, repo, branch)` → bool (404 → false).
- `approvePullRequest(owner, repo, prNumber, body)` → posts `event: 'APPROVE'`
  review on the **original** PR; returns `{ id, html_url }`.

Supporting server libs:
- `server/lib/diff.js` — `lineDiff(oldText, newText)` and
  `threeWay(baseText, upstreamText, mineText)`, both line-based on `lcsIndices`.
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

United without conflict from both specs: non-blocking review, change-aware file
view (two-way), three-way reconciliation, comments (anchored + general, panel,
re-anchoring, summarized into PR body), server-side line diffing, the comments
table / `file_edits.base_sha` / `file_visits` seen-snapshot data model, and the
GitHub adapter surface.

---

## 10. Acceptance checklist (definition of done)

- [ ] The reviewer never writes to the developer's own branch; submitting edits
      lands them on a review branch via a review PR targeting `head_branch`.
      *(req 1, 4)*
- [ ] First edit-submit creates `review/pr<N>-<token>` off `head_branch`, commits
      once, opens one PR; the session stays editable.
- [ ] Re-submit with the review PR **open** adds a commit to the **same** branch
      and opens **no** new PR. *(B1)*
- [ ] Re-submit after the review PR **merged** opens a new PR — reusing the branch
      if alive, creating a fresh one off `head_branch` if deleted. *(B2/B3)*
- [ ] "Approve" (no pending edits) posts an APPROVE review on the **original** PR
      and creates no branch/commit/PR; the link stays usable.
- [ ] The button reads "Approve" with no pending edits and "Submit changes" once
      the reviewer edits.
- [ ] After a commit-submit, committed files are no longer dirty and the next
      no-edit submit approves rather than re-commits.
- [ ] Reopening a file that moved upstream shows a diff **by default**; an
      unchanged file opens straight into the editor. *(req 2)*
- [ ] A file with unsent local edits **and** upstream drift opens in a three-way
      Original / Your-edits reconcile view with conflicts flagged; the reviewer
      resolves and the result autosaves. *(req 5)*
- [ ] Hovering a paragraph reveals a comment button that anchors a comment; the
      top-right button creates a general comment; both list, resolve, delete.
      *(req 3)*
- [ ] A GitHub failure during submit leaves the session editable and removes only
      a branch created in that same call.
- [ ] The UI surfaces the review branch / PR URL once it exists, in plain
      non-GitHub language.
- [ ] `npm test` and `npm run test:e2e` pass; `test-spec.md` reflects the current
      semantics (REQ-9 matrix, REQ-12 removed, REQ-15/16/17 change-aware /
      three-way / comments, REQ-18/19/20 re-submission / approve / baseline
      advance).

---

## 11. Explicitly out of scope

- Merge-conflict resolution between developer pushes and the review branch — the
  developer handles these on GitHub.
- Posting reviewer comments as GitHub **inline review comments** (paragraph →
  diff-line mapping). Comments are summarized into the review PR body.
- Auto-merging or closing the review PR from the tool.
- Multiple distinct reviewer identities within one session.
- Real-time collaboration / live cursors.
- Auth changes to the admin surface.
</content>
</invoke>
