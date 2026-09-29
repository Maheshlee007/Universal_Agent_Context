# UAC 0.6.0: session chapters (design)

Date: 2026-09-30. Decided with a review panel (Fable, Opus), both independently choosing option A; the user delegated the choice.

## Problem
Every save replaced the session's one card, and the compressor (Haiku) had to rewrite the whole session from the previous card plus the new events. Recent events always win that rewrite. Evidence: this repo's own 4-day, 5-save session has a current card of 799 characters covering only the last hour. The older cards sit unused in `summaries`. `fmtCard` also clipped the body to 700 characters.

## Decision: chapters (option A)
- **A chapter = one LLM save** (a `summaries` row plus its checkpoint). It describes only the events that save covered. It is never rewritten or replaced.
- **Open items are carried by code, not by the LLM.**
  - The digest sends the session's current open items numbered (`open_items`).
  - The compressor returns `checkpoint.closed: [numbers]` plus only the NEW `next_steps`.
  - `save()` stores the new next steps plus every open item not closed, tagged `(open since chN)`. An item can only disappear by being closed explicitly.
- **Start context**, for a session with 2 or more chapters:
  - The card header gives `chapter N/N` and the session goal (chapter 1's goal, never rewritten).
  - The latest chapter is shown in full (its body clip is raised to 1200 characters).
  - Earlier chapters get one line each, at most 5: `s-id · date range · "title" · files: a, b`. `+N earlier` points to `uac_get {ids:["#n"]}`.
  - One rule line: "Earlier chapters are titles only: if your task touches their files, uac_get the chapter first."
  - All of this counts inside the existing 45% card budget.
- **Drill-down.** `uac_get {ids:["s-xxxxxx"]}` returns one chapter (summary plus checkpoint). `uac_get` on a session lists all of its chapters.
- **Pagination replaces truncation.** When the unsaved events exceed 60K characters, the digest stops at the page boundary (`upto_event_id`) and returns `more: <n events left>`. The next save covers the rest. Nothing is cut out of the middle, so the 0.5.1 head+requests+tail code is removed.
- **Old cards** (saved before 0.6.0, no event range) are shown as chapters labelled "pre-chapter card, overlaps later ones". No migration and no re-summarising.
- `events_n` counts this chapter's events only. The checkpoint-supersede query no longer supersedes the session's own earlier chapters.
- `.context/PROJECT.md` "Recent sessions" shows the latest chapter per session (not 3 chapters of one session).

## Schema
`summaries` gets `checkpoint_id TEXT` and `from_ts TEXT` (ADD COLUMN, idempotent like the other migrations). The chapter's time range is `from_ts` to `created_at`. Event ids are not stored: the events are deleted after a save. A save without `closed` still works: nothing is closed, and everything open carries forward.

## Compressor contract (agent file + HOW_TO_SAVE)
- Summarise ONLY the events in this digest, as a chapter of about 150–250 words.
- Return `checkpoint.closed` as the numbers of `open_items` this chapter finished.
- Put only new work in `next_steps`.
- The "cover the WHOLE session" rule, `previous_card` and the digest's `instructions` are removed. The digest instead sends `previous_chapter: {title, goal}` for continuity.

## Deferred (YAGNI, both reviewers)
- **Raw transcript slice per chapter:** add it when someone asks for a transcript segment. Today `raw:true` on the session works, as long as the host transcript exists.
- **An LLM-written whole-session overview (option B):** only if the title index proves to be ignored.
- **Merging tiny saves into the previous chapter:** saves come about every 40 events, so tiny chapters are rare.

## Error handling
- `invalidCard` is unchanged.
- An unknown or out-of-range `closed` number is ignored and reported in `warnings`.
- `uac_get` of an unknown `s-` id returns the not-found error, with the session's chapter ids listed.

## Tests
One test that covers the whole contract:
1. Two saves in one session give two chapters, with the start context showing the latest chapter in full and the first chapter as a title line.
2. An open item not closed carries forward verbatim with `(open since ch1)`, and a closed one disappears.
3. The digest pages at the limit, with `more` > 0 and no events cut.
4. `uac_get` on the `s-` id returns the chapter.

It replaces the 0.5.1 "large session digest" test.
