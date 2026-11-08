# Live integration suite

End-to-end tests against a **real iCloud account**: real clones, real pushes
and pulls, checked against both an independent second clone and what Apple's
own web client actually shows.

These tests perform real writes. They are off unless `ICLOUD_MD_ITEST=1`, so
`npm test` stays hermetic and offline.

## Why two oracles

A test that only compares one clone against another has a blind spot: a bug
where this tool encodes something wrongly and then decodes its own wrongness
back reads as a pass. So every push is also checked against the iCloud web UI
via Playwright — an observer entirely outside this project's own code.

The cheap check (a second clone) carries the routine load; the web oracle is
used at the points that matter, since a web read costs 15–20 seconds.

## How the web oracle works

Worth knowing before changing `webOracle.ts`, because none of it is obvious:

- icloud.com/notes runs inside an iframe served from `/applications/notes3/…`.
  Everything must be queried through that frame.
- A note is addressable directly at
  `/notes/note/<base64("Private::Notes::currentUser::<UUID>")>`, so the oracle
  jumps straight to a record id instead of scraping the sidebar.
- **The note body is rendered to a `<canvas>`.** It is not in the DOM, and the
  accessibility tree does not mirror it. There is nothing to scrape.
- The way in is the clipboard: focus the editor, select all, copy. Apple's own
  client then serialises the note as `text/plain` *and* as a `text/html` whose
  every span carries a `data-tt` attribute holding Apple's native paragraph
  style enum. That is what lets the oracle assert formatting, not just text.
- The oracle never types into a note. The only keys it sends are select-all
  and copy.

It decodes the style enum with its own copy of the mapping rather than
importing `noteFormat.ts`'s — if it shared ours, a wrong mapping would cancel
itself out and the test would pass anyway.

## Negative controls

Two of the merge tests are a matched pair. One pushes a correctly restamped
deletion and proves an open client *adopts* it; the other pushes the same
deletion with the tombstones left at their original style timestamp and proves
the client *discards* it. Same edit, opposite outcomes, the clock discipline
being the only difference — which is what makes the first test evidence about
our restamping rather than about deletions in general.

The wrong shape cannot be produced through the normal write path (`applyTextEdit`
always restamps), so `tiedAnchorDeletion.ts` builds it by letting the production
codec do the correct edit and then reverting only the stamps, and writes it back
through the ordinary `records/modify` call. That file is test-only on purpose:
nothing in `src/` should be able to author a document that loses a merge.

`tiedAnchorDeletion.test.ts` covers it offline, on captured bytes, and runs under
plain `npm test` — a helper that silently emitted a *correct* deletion, or a
malformed one, would make the live test pass for the wrong reason.

## Tables

`push` can only *edit* a table that already exists, and the oracle never
types, so for a long time nothing in the harness could put a table in front of
a test — leaving the one write path with two live corruption incidents behind
it with no live coverage at all.

`plantTable.ts` closes that by planting one. The obvious objection is that a
fixture we author with our own codec and read back with our own codec proves
nothing, so none of it is ours:

- the table document is a **real captured `MergeableDataEncrypted` payload**
  (`realFixtures.ts`'s `TABLE_REV_BASELINE`), copied through untouched;
- the `Attachment` record's field set is **Apple's own create**, from entry 39
  of the 2026-07-16 note-lifecycle capture;
- the only part this project authors is the U+FFFC wiring in the note body, and
  the suite asserts nothing about any *edit* until Apple's client has rendered
  the planted table with the cells it should have.

Reading the result back needed a different route from the rest of the oracle.
A table is not on the clipboard — it copies as the bare U+FFFC placeholder,
marked `data-tt-replacement="true"`, with none of its cells — and it is not in
the DOM either, being canvas-rendered like the body. So the oracle reads
`icTableManager` instead: the sibling of the `topoTextManager` whose merge
traces the suite already uses, holding the live `CRTable` the client decoded
from the attachment's bytes, keyed by attachment record id. Walking its
`_rows`/`_columns` and reading each cell's `.string.UTF16String` is Apple's own
view of the grid, from Apple's own decoder.

That is a stronger second opinion than scraped markup would have been: it needs
no merge to have happened and no UI to be driven, and it is keyed by attachment
id, so an LRU still holding a table from an earlier note can't be mistaken for
this one.

`plantTable.test.ts` covers the planter offline, on captured bytes, under plain
`npm test`: a planter that quietly produced a malformed body would make the
live tests fail for a reason unrelated to the write path.

## Carriage returns

Apple Notes keeps the bare CRs in pasted text (issue #34), but `push` can
never write one: every local file is normalized to LF before it is parsed. So
`plantSeparators.ts` plants them. It pushes an ordinary LF note, then swaps
chosen LFs for CR or CRLF through the production codec (`applyTextEdit`) and
the ordinary `records/modify` call, the way `tiedAnchorDeletion.ts` writes
its negative control.

The LF original is the control at every step. The planted note must pull as
the same markdown, stay untouched by a push with no edit, and survive a real
edit, which stores it as LF and shows in Apple's web client with every
paragraph and style intact.

Apple's own clients disagree about bare CR. macOS and iOS Notes draw it as a
paragraph boundary, which is the model this tool decodes with. The web client
draws nothing for it, so "ALPHA\rBETA" reads "ALPHABETA" (observed
2026-10-08). The planted-note oracle check therefore requires CRLF to split
exactly like LF, and pins the web client's bare-CR behaviour as observed, so
a change on Apple's side shows up as a failure.

`plantSeparators.test.ts` covers the planter offline under plain `npm test`.
To run only this block:

```bash
npm run build && ICLOUD_MD_ITEST=1 npx tsx --test --test-name-pattern="carriage-return" integration/live.test.ts
```

## Independent attachment titles

The focused attachment-title test plants a captured Apple table, keeps its
entire document behind an object-only first line, and sets an independent
display title. It verifies the pull filename and that both local renames and
`apple-note-title` requests are refused without writing the note. The compressed
note and table payloads must remain byte-identical, and Apple's web client must
still render the original table. This covers reading an independent title and
refusing unsupported retitles; it does not establish native scan/drawing edits.

Native iPhone testing on 2026-11-05 showed why that distinction matters:
CloudKit title updates could change the inside-note label without updating the
note list, and an experimental edit-stamp workaround produced a duplicated
drawing on the device despite passing local round-trip checks. That workaround
is not part of the CLI. Keep attachment retitles refused until native-client
behavior is understood and verified independently.

It runs with the full suite, or alone:

```bash
npm run build
ICLOUD_MD_ITEST=1 npx tsx --test integration/attachmentTitles.live.ts
```

The experimental `attachmentTitleProbe.ts` helper isolates two CloudKit-only
metadata phases: A changes the drawing's `UserTitle`; a separate invocation of B
changes the containing note's title and modification date. Both use Linux/cloud
state only. Neither calls, waits for, or accepts acknowledgements from a Mac.
Preview is offline by default; applying a phase requires an explicit option and
a private operation journal. Uncertain writes are never automatically replayed.

The alternative terminal phase `BA` sends one explicit atomic batch containing
the note's title/date followed by the drawing's `UserTitle` reassertion, using
the [CloudKit records/modify request contract](https://developer.apple.com/library/archive/documentation/DataManagement/Conceptual/CloudKitWebServicesReference/ModifyRecords.html).
`B` and `BA` are mutually exclusive: a shared durable terminal claim prevents
using one as a retry of the other. Server-side atomicity and operation order do
not establish native import order. The separate A/B trial passed with a connected
Mac but left its list title stale when Notes was closed during the writes and
reopened afterward. The BA trial also imported both latest versions while leaving
the list title one rename behind; neither metadata-only sequence is a supported fix.

The alternative `BD` phase tests a content-neutral causal revision. It computes
the new document internally by inserting then deleting only a fresh trailing
character before any upload. It requires identical visible text, complete
formatting spans, original atom/style metadata and original replica counters,
with graph contraction recovering the old structure. Only the computed payload
is allowed; an arbitrary document blob cannot be supplied. It does not restamp
the drawing's original formatting. **Serialized document bytes change**, while
drawing/preview bytes and references must remain identical. `B`, `BA` and `BD`
share a terminal claim and cannot be used to retry each other. Native rendering
and the preservation of an unseen client-local newline still require external
verification; this diagnostic is not a supported rename fix.

The first BD trial updated the native title but duplicated the drawing because
the document codec confused timestamp-row indexes with sorted UUID ranks. Both
character and style references now translate through sorted UUID rank at the wire
boundary, with independent wire-identity regressions. The accidental atom was removed by a verified forward causal repair; correcting
the codec alone does not
delete copies already merged by a client. Do not replay its journal or restore an
older raw document. The corrected BD trial preserved
visible content and formatting but still left the native title one rename behind after closed-client
catch-up; it is rejected as an end-to-end rename fix.

The `BR` alternative tests a physical character replacement. It uses the ordinary
editor to tombstone the old drawing character and generate a fresh live character
referencing the **same attachment ID and UTI**, with identical serialized formatting.
Only the final one-drawing document is uploaded. The fresh character precedes the
old tombstone, retaining unseen native descendants such as a local trailing newline.
Character coordinates, the old character's style timestamp and causal document bytes
change intentionally; asset bytes, references and note identity must not change.
All four terminal alternatives share a durable claim. The closed-client BR trial
preserved the drawing, formatting, unrelated history and local newline, but the
native title still stayed one rename behind. It is rejected as a rename fix.

A later one-shot Linux reassertion of **only** the already-current Note title
advanced the cloud version and, after a subsequent native fetch, corrected the
name. The modification date, compressed document and all five assets were unchanged.
This supports investigating ongoing Linux reconciliation; it does not prove a
finite completed rename will work for a device that remains offline until afterward.
No periodic reassertion service is installed, and unproven workflows are not
exposed through the shipped CLI. The internal push coordinator remains a research
seam tested against the offline SDK, not an end-to-end fix.

The checked experimental caller is `attachmentTitleRunner.ts`, launched through
`integration/runAttachmentTitleProbe` on Linux. It verifies the unchanged local
filename request, account/private-folder scope, exact expected compressed document
(including the explicitly planned revision for BD or BR), and all drawing/preview bytes.
It captures private evidence before and after a
write. Its approved preview digest binds those inputs, executable source,
deadline, journal path and the actual held sync-lock descriptor. A different
request, stale plan, changed local file or uncertain earlier phase stops it.

Read the invocation flags without connecting to an account:

```bash
node --import tsx integration/attachmentTitleRunnerCli.ts --help
```

For a separately approved live trial, pause normal automatic sync, wait for its
current run to finish, and set `ICLOUD_MD_PROBE_LOCK_PATH` to that writer's exact
lock file before invoking the wrapper. Keep automatic sync paused throughout:
systemd can remove a runtime lock directory when its service exits. Preview is
the default and performs only cloud reads; applying requires the matching
`--expected-plan` digest and `--apply`. Keep one fixed private journal per
rename; never substitute a fresh journal to replay an uncertain operation.

This is test tooling, not a supported rename command. Native list refresh,
including after an offline device reconnects, remains unproven. Results explicitly
say native verification is outstanding, and ordinary `push` continues to refuse
these renames. Native devices may only observe the independent Linux write path.

## Containment

Fixtures are confined to a dedicated Notes folder, and two independent keys
must both turn before anything is deleted:

1. the record is inside that folder, **and**
2. either it appeared during this run, or its title carries this run's
   `(itest-<runId>)` prefix.

A prefix-only rule would let a mistyped folder name delete something else in
the account; a folder-only rule ("empty the folder") would delete anything a
human filed there. The suite also refuses to start if the folder holds a note
without a fixture prefix.

The suite never creates or deletes the folder itself. `push` cannot create
folders at all, which is a useful accident: the suite is structurally unable
to invent a container outside the sanctioned one.

Those two keys turn on notes and folders — everything `push` can make. A test
that reaches CloudKit directly can create records the walk doesn't see (the
table fixture's `Attachment` record is the only one today), so it registers
them with `RunContext.disposeAfterTeardown`, which removes them once teardown
has taken the notes referencing them.

Note the prefix uses parentheses, not square brackets: `[` and `]` are
homoglyph-substituted on the way into a file name, so a bracketed prefix would
collide with the very projection under test.

## Setup

One-time, and only once per machine:

```bash
# 1. Sign in, if you haven't already
icloud-md clone ~/some-vault

# 2. Create the containment folder (or make it by hand in Apple Notes)
ICLOUD_MD_ITEST_DSID=<dsid> npm run itest:setup
```

Find your dsid under `~/.config/icloud-md/accounts/`. If exactly one account
is signed in, `ICLOUD_MD_ITEST_DSID` can be omitted everywhere.

## Running

```bash
ICLOUD_MD_ITEST=1 npm run test:integration
```

A full run takes roughly three minutes and prints the account, folder and run
id before touching anything.

Clones happen unattended thanks to `clone --account <appleId|dsid>`, which
reuses that account's stored session — the same one `push`/`pull` use — and
so needs no browser at all in the ordinary case.

That matters because relaunching the account's browser profile is what has
actually been seen to fail here. On 2026-08-02 a mid-run clone could not
complete a silent sign-in, fell back to a visible window with nobody there to
close it, and cost 5.5 minutes for every remaining cloning test — while the
stored session it never tried was serving every push and pull in the same run.
That lapse was never explained: the obvious suspect, the web oracle holding
the same profile for the whole run, does not reproduce it (a second Chromium
opens a held profile fine, and a silent sign-in still succeeds after 17
minutes of contention).

Every clone the suite makes also passes `--non-interactive`, so if both the
stored session and a silent profile relaunch fail, the run fails immediately
and says so rather than waiting on a window. Re-authenticate
(`icloud-md reauthenticate <a clone>`) and run again.

## Environment variables

| Variable | Meaning |
| --- | --- |
| `ICLOUD_MD_ITEST=1` | Required. Enables the suite. |
| `ICLOUD_MD_ITEST_DSID` | Which account to use. Optional when only one is signed in. |
| `ICLOUD_MD_ITEST_FOLDER` | Containment folder name (default `icloud-md-itest`). |
| `ICLOUD_MD_ITEST_WORKROOT` | Where clones are made (default a tmpdir). |
| `ICLOUD_MD_ITEST_HEADED=1` | Show the oracle's browser window. |
| `ICLOUD_MD_ITEST_KEEP=1` | Keep clone directories after the run, for debugging. |

## When a run leaves debris

A run killed partway through can leave fixtures behind, and an untitled
leftover will block later runs at the guard. Clear the folder with:

```bash
ICLOUD_MD_ITEST=1 npm run itest:sweep
```
