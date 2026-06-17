# Test Specification — md-collaborator

**Scope:** Functional correctness only. Out of scope: security, performance, code quality, UX.

**Approach:** Tests are organized by **business requirement**, not by code structure. Each test asserts *observable behavior* a stakeholder would recognize ("the reviewer cannot edit an approved session"), never an implementation detail (field names, SQL clauses, helper-function internals). This keeps the suite meaningful and refactor-resistant: every test traces to a rule the product must honor.

**Suggested level** per test: **U** = pure-logic unit · **I** = API/integration · **E** = end-to-end browser. This is guidance for whoever implements them, not part of the assertion.

**Total: 32 tests.**

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

## REQ-9 — Submission opens a pull request and closes the session

The reviewer never writes to the PR's own branch: edits land on a fresh branch
and a new PR targets the original PR's head branch (non-blocking review).

| # | Type | Lvl | Behavior |
|---|------|-----|----------|
| R9.1 | happy | I/E | Submitting with edits creates one fresh branch, one commit, and one PR targeting the PR's head branch, then locks the session as submitted |
| R9.2 | happy | I | Several edited files are delivered as one commit, not many |
| R9.3 | edge | I/E | Submitting with no edits still closes the session cleanly, opening no branch or PR |

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

## REQ-12 — A submitted session is read-only

| # | Type | Lvl | Behavior |
|---|------|-----|----------|
| R12.1 | unhappy | I/E | Editing a submitted session is refused |
| R12.2 | unhappy | I | Re-submitting an already-submitted session is refused |

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
| R9 Submit & open PR | R9.1–R9.3 | ✓ | ✓ |
| R10 Minimal diff | R10.1–R10.3 | ✓ | ✓ |
| R11 Conflict safety | R11.1–R11.3 | ✓ | ✓ |
| R12 Read-only lock | R12.1–R12.2 | — | ✓ |
| R13 Revoked link | R13.1 | — | ✓ |
| R14 Diagrams | R14.1 | ✓ | — |

Every requirement has at least one test; every requirement with a meaningful failure mode has a negative test; the highest-risk business logic (approval, commit integrity, conflict safety) carries its edge cases.

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
| Sessions seeded in active / submitted / revoked states | R12, R13, and state-dependent checks |
