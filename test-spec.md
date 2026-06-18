# Test Specification — md-collaborator

**Scope:** Functional correctness only. Out of scope: security, performance, code quality, UX.

**Approach:** Tests are organized by **business requirement**, not by code structure. Each test asserts *observable behavior* a stakeholder would recognize ("the reviewer cannot edit an approved session"), never an implementation detail (field names, SQL clauses, helper-function internals). This keeps the suite meaningful and refactor-resistant: every test traces to a rule the product must honor.

**Suggested level** per test: **U** = pure-logic unit · **I** = API/integration · **E** = end-to-end browser. This is guidance for whoever implements them, not part of the assertion.

**Total: 45 tests.**

> ⚠️ Two tests encode *intended* behavior that the current implementation does not yet satisfy (marked **[drives fix]**). They are expected to fail until the code is corrected.

---

## REQ-1 — Only an authenticated admin can manage sessions

The developer-facing controls (create, list, revoke) are gated by a shared secret.

| # | Type | Lvl | Behavior |
|---|------|-----|----------|
| R1.1 | happy | I | With the correct secret, an admin can reach the management endpoints |
| R1.2 | unhappy | I | With a wrong or missing secret, every management action is refused |

---

## REQ-2 — An admin can open a review session from a pull request

A session turns an open PR into a shareable review link.

| # | Type | Lvl | Behavior |
|---|------|-----|----------|
| R2.1 | happy | I/E | Given an open PR containing markdown, creating a session yields a working review link and an active session |
| R2.2 | unhappy | I | A closed or merged PR is refused — you cannot review a PR that can no longer receive the commit |
| R2.3 | unhappy | I | A PR with no markdown files is refused — there is nothing to review |
| R2.4 | unhappy | I | A reference that is not a valid GitHub PR URL is refused before any external call |

---

## REQ-3 — A session exposes exactly the PR's reviewable markdown

Reviewers see all of the PR's markdown and nothing else.

| # | Type | Lvl | Behavior |
|---|------|-----|----------|
| R3.1 | happy | U | Non-markdown files in the PR are not part of the session |
| R3.2 | edge | U | Markdown files *deleted* by the PR are excluded — you cannot review a file the PR removes |
| R3.3 | edge | U/I | Every markdown file appears even on a large PR; none are silently dropped |

---

## REQ-4 — An admin can oversee all sessions

| # | Type | Lvl | Behavior |
|---|------|-----|----------|
| R4.1 | happy | I | The listing shows each session's status, how many files were edited, and a link that actually opens that session **[drives fix]** |

---

## REQ-5 — An admin can revoke a link

| # | Type | Lvl | Behavior |
|---|------|-----|----------|
| R5.1 | happy | I/E | Revoking an active session immediately cuts off the reviewer's access |
| R5.2 | unhappy | I | Revoking a session that is not active has no effect and reports as much |

---

## REQ-6 — A reviewer can read the files under review

| # | Type | Lvl | Behavior |
|---|------|-----|----------|
| R6.1 | happy | I/E | With a valid link, the reviewer sees the file list and can open each file's current content |
| R6.2 | happy | I | A reviewer who has edited a file sees their own latest version, not the stale original |
| R6.3 | unhappy | I | A request for a file outside the session's file set is refused **[drives fix]** |

---

## REQ-7 — A reviewer's edits are saved and durable

| # | Type | Lvl | Behavior |
|---|------|-----|----------|
| R7.1 | happy | E | An edit is saved automatically and is still there after a page reload |
| R7.2 | edge | I | The file's pre-edit content is remembered from the first save onward, so later saves never lose the baseline used for diffing |

---

## REQ-8 — The system tracks review progress and guards submission

| # | Type | Lvl | Behavior |
|---|------|-----|----------|
| R8.1 | happy | I/E | Opening a file marks it as reviewed |
| R8.2 | unhappy | E | Submitting while some files are still unopened warns the reviewer before proceeding |

---

## REQ-9 — Submission approves or commits, and never locks the session

With no pending edits, "Submit" posts a formal GitHub approval on the
**original** developer PR. With pending edits, it commits them to the
**current** review branch/PR — creating either as needed (REQ-18) — and the
session stays open for further rounds (no terminal "submitted" status).

| # | Type | Lvl | Behavior |
|---|------|-----|----------|
| R9.1 | happy | I/E | Submitting with edits creates one branch, one commit, and one PR targeting the PR's head branch on a first submit; the session stays active and remains editable afterward |
| R9.2 | happy | I | Several edited files are delivered as one commit, not many |
| R9.3 | edge | I/E | Submitting with no pending edits approves the original PR instead, opening no branch or PR |

---

## REQ-10 — Committed changes keep the PR diff minimal

The reviewer's commit must touch only the lines they actually changed; untouched lines stay byte-for-byte identical so the PR diff is clean and trustworthy.

| # | Type | Lvl | Behavior |
|---|------|-----|----------|
| R10.1 | happy | U | A single changed line produces a commit that differs from the original only on that line |
| R10.2 | edge | U | Files with repeated identical lines are reconstructed without duplicating or reordering content |
| R10.3 | edge | U | Very large files are committed correctly (fallback path) without corruption |

---

## REQ-11 — Submission never overwrites newer work on the branch

| # | Type | Lvl | Behavior |
|---|------|-----|----------|
| R11.1 | happy | I/E | If the branch advanced since the session was created, submission still succeeds by branching off the live head SHA — never clobbering newer work |
| R11.2 | unhappy | I | If the commit to GitHub fails, the session stays open — never left half-submitted |
| R11.3 | unhappy | I | If opening the PR fails, the session stays open — never left half-submitted |

---

## REQ-12 — *(removed)*

There is no post-submit lock: a session never transitions to a terminal
"submitted" status, so it stays editable through any number of submits. See
REQ-9 and REQ-18–20 for the replacement behavior.

---

## REQ-13 — A revoked link grants no access

| # | Type | Lvl | Behavior |
|---|------|-----|----------|
| R13.1 | unhappy | I/E | A revoked link cannot read, edit, or submit — the reviewer sees an error, not the editor |

---

## REQ-14 — Diagrams render for the reviewer

| # | Type | Lvl | Behavior |
|---|------|-----|----------|
| R14.1 | happy | E | A markdown file containing a mermaid block shows the rendered diagram, not raw code |

---

## REQ-15 — The reviewer sees what changed since the last time they looked

Each time a reviewer opens a file, the system remembers what they saw. If the
file's upstream content has moved on a later visit, that file opens to a diff of
what changed rather than dropping them straight into the editor.

| # | Type | Lvl | Behavior |
|---|------|-----|----------|
| R15.1 | happy | I/E | A file whose upstream is unchanged opens directly (no diff) |
| R15.2 | happy | I/E | After a file has been seen, an upstream change opens a two-way diff of what moved; once seen, it settles back to the direct view |

---

## REQ-16 — The reviewer can reconcile their unsent edits against drifted upstream

When the reviewer has edited a file and the upstream content has *also* moved
since their edit baseline, the file opens to a three-way view — original,
upstream (author), and their own unsent edits — with clashing lines flagged so
they can reconcile rather than silently clobber.

| # | Type | Lvl | Behavior |
|---|------|-----|----------|
| R16.1 | happy | I/E | An edited file whose upstream drifted opens a three-way view; a line both sides changed is flagged as a conflict |
| R16.2 | edge | I | Non-overlapping edits (reviewer and author touched different lines) open three-way with no conflicts |
| R16.3 | edge | I | An edited file whose upstream has not moved stays a direct (plain) view — no reconciliation needed |

---

## REQ-17 — The reviewer can leave explanatory comments

Comments may be anchored to a paragraph or left free (general). They are listed,
can be resolved and deleted, travel with the resulting PR, and are scoped to
their own session.

| # | Type | Lvl | Behavior |
|---|------|-----|----------|
| R17.1 | happy | I/E | An anchored comment and a free comment can be created and are listed back |
| R17.2 | unhappy | I | A comment requires a non-empty body; a comment can be resolved and deleted |
| R17.3 | unhappy | I | A session cannot read, resolve, or delete another session's comments |
| R17.4 | edge | I/E | After submission, existing comments stay readable but no new comment can be added |

---

## REQ-18 — Same-PR re-submission reuses the current review branch/PR

Re-submissions land on the **same** review branch/PR rather than spawning a
new pair every time. Selection follows the merge-state matrix: an open review
PR reuses both branch and PR (B1); a merged review PR whose branch is still
alive reuses the branch but opens a new PR (B2); a merged review PR whose
branch was deleted creates a fresh branch (off the target branch) and a new PR
(B3).

| # | Type | Lvl | Behavior |
|---|------|-----|----------|
| R18.1 | happy | I | (B1) Re-submitting while the review PR is open adds a commit to the same branch and opens no new PR |
| R18.2 | edge | I | (B2) Re-submitting after the review PR merged, with its branch still alive, reuses the branch but opens a new PR |
| R18.3 | edge | I | (B3) Re-submitting after the review PR merged and its branch deleted creates a fresh branch off the target branch and a new PR |

---

## REQ-19 — "Approve" posts a GitHub review on the original PR

With no pending edits, submitting posts a formal `APPROVE` review on the
**original** developer PR (not the review PR). It writes no branch/commit and
opens no PR; the review-PR link, if any, stays usable afterward.

| # | Type | Lvl | Behavior |
|---|------|-----|----------|
| R19.1 | unhappy | I | If posting the approval fails, the session is left unchanged (no `approved_at`, still active) |

---

## REQ-20 — Baseline advance after a commit-submit

Every file committed in a submit round has its dirty baseline reset, so the
next round starts clean — and a reused branch is never deleted on failure
(only a branch created in that same call is).

| # | Type | Lvl | Behavior |
|---|------|-----|----------|
| R20.1 | happy | I | After a commit-submit, committed files are no longer dirty and the next no-edit submit approves rather than re-committing |
| R20.2 | unhappy | I | A commit failure while reusing an existing review branch (B1) never deletes that branch |

---

## Traceability Summary

| Requirement | Tests | Happy | Unhappy/Edge |
|-------------|-------|-------|--------------|
| R1 Admin auth | R1.1–R1.2 | ✓ | ✓ |
| R2 Create session | R2.1–R2.4 | ✓ | ✓ |
| R3 File scope | R3.1–R3.3 | ✓ | ✓ |
| R4 Oversight | R4.1 | ✓ | — |
| R5 Revoke | R5.1–R5.2 | ✓ | ✓ |
| R6 Read files | R6.1–R6.3 | ✓ | ✓ |
| R7 Edit durability | R7.1–R7.2 | ✓ | ✓ |
| R8 Progress guard | R8.1–R8.2 | ✓ | ✓ |
| R9 Submit: approve or commit | R9.1–R9.3 | ✓ | ✓ |
| R10 Minimal diff | R10.1–R10.3 | ✓ | ✓ |
| R11 Conflict safety | R11.1–R11.3 | ✓ | ✓ |
| R12 *(removed)* | — | — | — |
| R13 Revoked link | R13.1 | — | ✓ |
| R14 Diagrams | R14.1 | ✓ | — |
| R15 Change awareness | R15.1–R15.2 | ✓ | — |
| R16 Three-way reconcile | R16.1–R16.3 | ✓ | ✓ |
| R17 Comments | R17.1–R17.4 | ✓ | ✓ |
| R18 Same-PR re-submission | R18.1–R18.3 | ✓ | ✓ |
| R19 Approve posts GitHub review | R19.1 | — | ✓ |
| R20 Baseline advance | R20.1–R20.2 | ✓ | ✓ |

Every requirement has at least one test; every requirement with a meaningful failure mode has a negative test; the highest-risk business logic (submission, commit integrity, conflict safety) carries its edge cases.

---

## Test Data

| Fixture | Used by |
|---------|---------|
| Open PR with markdown files | R2.1, most E2E |
| Closed/merged PR | R2.2 |
| PR with no markdown | R2.3 |
| PR mixing markdown, non-markdown, and a deleted markdown file | R3.1, R3.2 |
| Large PR (markdown spanning multiple result pages) | R3.3 |
| A file edited to change one line; another with repeated identical lines; a very large file | R10.1–R10.3 |
| Markdown file with a mermaid block | R14.1 |
| Sessions seeded in active / submitted / revoked states | R13, R17.4, and state-dependent checks |
| Review PR fixture (open, or merged with branch alive/deleted) | R18.1–R18.3, R20.2 |
