# feat: Review UI consistency and last-activity tweaks

**Created:** 2026-06-21

## Summary

Three small UI fixes to the reviewer interface (`public/review.html`): rename the "Removed upstream" diff legend label to "Developer removed" for consistency with "Developer added"; rename the collapsed reference-panel toggle from "Show" to "See history"; and add a single color-coded relative timestamp to each file in the sidebar showing whichever happened more recently — the reviewer's own last save, or the last visible upstream update.

## Problem Frame

Two legend/button labels are inconsistent or unclear ("Removed upstream" doesn't match "Developer added"'s phrasing; "Show" doesn't communicate what reopening the panel does). Separately, the file sidebar gives no sense of *when* something last happened to a file — neither the reviewer's own edit activity nor upstream drift — so a reviewer returning to a session has to open each file to find out what's stale.

## Requirements

Traced to `test-spec.md` REQ-21 (new):

- R21.1 — The two-column diff legend reads "Developer removed" instead of "Removed upstream", matching "Developer added"'s phrasing.
- R21.2 — When the reference panel is collapsed, its toggle button reads "See history" instead of "Show".
- R21.3 — Each file in the sidebar shows a relative timestamp for whichever of (reviewer's last saved edit, last visible upstream update) is more recent, colored green for a reviewer edit and the sidebar's default text color for an upstream update. A file with neither shows no timestamp.

## Key Technical Decisions

**KTD-1: Compute "most recent" timestamp server-side, in the existing file-list endpoint.**
`GET /api/:token` (`server/routes/review.js:100`) already joins `file_edits` and `file_visits` per file to derive `edited`/`dirty`/`visited` flags. Extend the same query to read `file_edits.updated_at` and `file_visits.visited_at`, take the max of the two per file, and return it alongside a `source` of `'mine'` or `'upstream'`. Computing this server-side avoids shipping raw timestamps from two tables to the client and re-deriving "most recent" there — the comparison only needs to happen once, and the server already has both rows in hand from the existing queries.

**KTD-2: Reuse `relTime()` for formatting; reuse the existing GitHub-style color palette for the color cue.**
`relTime()` (`public/review.html:744`) already produces the "2h ago"/"3d ago" style used elsewhere in the file. No new formatting logic is needed. For the color, reuse the existing green used for additions/the approve button (`#2da44e`/`#22863a`) for "mine," and the sidebar's existing default text color (`#24292e`) for "upstream" — both already appear in the stylesheet, so no new palette entries are needed.

**KTD-3: No backfill for `visited_at`/`updated_at` on existing sessions.**
Files with neither an edit nor a recorded visit (e.g., never opened) show no timestamp rather than a fabricated one. This matches existing optional-field handling elsewhere in the file list payload (e.g., `dirty`, `visited`).

## Scope Boundaries

**In scope:** the two label renames; one color-coded most-recent timestamp per file in the sidebar.

**Out of scope:**
- Showing both timestamps simultaneously, or any tooltip/hover surfacing the non-displayed one.
- An exact upstream commit timestamp for the file (the existing `visited_at` proxy — which only advances when the PR branch's head SHA has moved since the reviewer last opened the file — is accepted as good enough; see origin discussion).
- Any other changes to the diff panel header or legend beyond the one rename.

## Implementation Units

### U1. Rename diff legend label

**Goal:** Change "Removed upstream" to "Developer removed" in the two-column diff legend.

**Requirements:** R21.1

**Dependencies:** None

**Files:**
- `public/review.html` (legend array at line 655)

**Approach:** Single string literal change in the `buildTwoColumnDiff` legend array: `['deletion', 'Removed upstream']` → `['deletion', 'Developer removed']`.

**Patterns to follow:** Matches the existing `['addition', 'Developer added']` entry in the same array.

**Test scenarios:**
- Test expectation: none — pure copy change with no behavioral branch; covered visually, not worth a dedicated assertion.

**Verification:** Open a file with a two-way diff containing a deletion; the legend chip reads "Developer removed".

---

### U2. Rename collapsed reference-panel toggle

**Goal:** When the reference panel is collapsed, the toggle button reads "See history" instead of "Show".

**Requirements:** R21.2

**Dependencies:** None

**Files:**
- `public/review.html` (toggle handler at line 1208)

**Approach:** Change the ternary's collapsed-branch string: `collapsed ? 'Show' : 'Hide'` → `collapsed ? 'See history' : 'Hide'`. The initial HTML markup at line 455 (`<button id="reference-toggle">Hide</button>`) is unaffected since the panel starts expanded.

**Patterns to follow:** Existing toggle-label pattern in the same handler (`'Hide'` branch is unchanged).

**Test scenarios:**
- Test expectation: none — pure copy change with no behavioral branch.

**Verification:** Open a file with a reference panel, click the toggle to collapse it; the button reads "See history". Click again; it reads "Hide".

---

### U3. Expose most-recent activity timestamp per file from the file-list endpoint

**Goal:** `GET /api/:token` returns, per file, the most recent of the reviewer's edit timestamp and the upstream-visit timestamp, plus which one it was.

**Requirements:** R21.3

**Dependencies:** None

**Files:**
- `server/routes/review.js` (file-list handler, `~line 100-118`)
- `tests/integration/review.test.js` (new test)

**Approach:** Extend the existing `file_edits` query (`server/routes/review.js:104`) to also select `updated_at`, and the existing `file_visits` query (`server/routes/review.js:107-111`) to also select `visited_at`, keyed by `file_path` (matching the existing `Set` construction pattern for `editedPaths`/`dirtyPaths`/`visitedPaths`). Build a `file_path → updated_at` map and a `file_path → visited_at` map. When building the `files` array (`server/routes/review.js:112-118`), for each file compare the two timestamps (treating a missing one as absent, not zero) and add:
- `last_activity_at`: the larger of the two, or `null` if neither exists
- `last_activity_source`: `'mine'` if the edit timestamp won, `'upstream'` if the visit timestamp won, `null` if neither exists

**Test scenarios:**
- Happy path: a file with only a saved edit (no visit recorded) → `last_activity_source: 'mine'`, `last_activity_at` equals the edit's `updated_at`.
- Happy path: a file with only a recorded visit (opened, never edited) → `last_activity_source: 'upstream'`, `last_activity_at` equals the visit's `visited_at`.
- Happy path: a file with both an edit and a visit, edit timestamp newer → `last_activity_source: 'mine'`.
- Happy path: a file with both an edit and a visit, visit timestamp newer → `last_activity_source: 'upstream'`.
- Edge case: a file with neither an edit nor a visit (never opened) → `last_activity_at: null`, `last_activity_source: null`.

**Verification:** `GET /api/:token` response's `files` array includes `last_activity_at`/`last_activity_source` matching the above scenarios for seeded sessions.

---

### U4. Render the most-recent-activity timestamp in the sidebar

**Goal:** Each file item in the sidebar shows the relative timestamp from U3, colored green for `'mine'` or default text color for `'upstream'`, and nothing when `last_activity_at` is `null`.

**Requirements:** R21.3

**Dependencies:** U3

**Files:**
- `public/review.html` (`renderFileList` at line 592, plus a new CSS rule near the existing `.file-item` styles at line 73-80)

**Approach:** In `renderFileList`, after appending the existing `name` span, conditionally append a small timestamp span when `f.last_activity_at` is present: `relTime(f.last_activity_at)` as text, with a CSS class reflecting `f.last_activity_source` (e.g. `activity-mine` / `activity-upstream`). Add two CSS rules: `.file-item .activity-mine { color: #2da44e; }` and `.file-item .activity-upstream { color: #6a737d; }` (reusing the muted gray already used for secondary text like `#pr-label`, rather than the primary `#24292e`, so the timestamp reads as secondary metadata next to the filename).

**Patterns to follow:** Existing `dot`/`name` span construction in `renderFileList` (lines 599-604); existing secondary-text color `#6a737d` used for `#pr-label` (line 24) and similar muted UI text.

**Test scenarios:**
- Test expectation: none for the rendering logic itself — this is a thin DOM-construction layer over data already covered by U3's test scenarios, and the project has no frontend unit-test harness for `review.html`'s inline script. Manually verify via the dev server (see Verification).

**Verification:** Start the app, open a review session with at least one edited file and one merely-opened file; confirm the edited file's sidebar entry shows a green relative time and the opened-only file shows a gray one, and a never-opened file shows no timestamp.

---

### U5. Record the new requirement in `test-spec.md`

**Goal:** Add REQ-21 to the project's canonical requirement spec, following its established format, and update the traceability table.

**Requirements:** R21.1, R21.2, R21.3

**Dependencies:** U1, U2, U3, U4

**Files:**
- `test-spec.md`

**Approach:** Add a `## REQ-21 — ...` section after REQ-20 (`test-spec.md:233-242`), following the existing `| # | Type | Lvl | Behavior |` table format. Mark R21.1/R21.2 as `Test expectation: none` equivalents (no `I`/`E` test, since they're copy-only) or omit them from the testable table and note them in the requirement's prose — match whichever convention reads more naturally given REQ-12's "(removed)" precedent for non-testable entries. Add a `R21 Last-activity timestamp | R21.3 | ✓ | —` row to the Traceability Summary table (`test-spec.md:246-269`).

**Test scenarios:**
- Test expectation: none — this unit is documentation only.

**Verification:** `test-spec.md` REQ-21 section and Traceability Summary both reference the new behavior; format matches surrounding REQ entries.

## Verification Strategy

- U3 is covered by an integration test in `tests/integration/review.test.js` against the real file-list endpoint with seeded `file_edits`/`file_visits` rows, following the existing `setup()` helper pattern in that file.
- U1, U2, and U4 are verified manually via the dev server (`npm run dev`) since they're presentation-only changes to a single-file vanilla-JS frontend with no existing component test harness.
- Run `npm test` after U3 to confirm no existing integration tests broke from the file-list query change.
