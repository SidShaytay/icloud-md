# Rename a drawing note with a Mac

This experimental companion connects a Vega filename rename to the drawing's custom title and the Mac's native note name. It is disabled by default. The native Mac name operation has passed a supervised preservation and restart check; the complete filename-to-both-devices workflow still needs its two supervised tests before automatic use.

It currently accepts only explicitly listed, private drawing-only notes (`com.apple.paper`), with one drawing, an unchanged body, and a filename change within the same folder. Ordinary `icloud-md push` keeps its existing refusal. Frontmatter title edits, shared notes, folder moves, surrounding prose, and other attachment types remain unsupported.

## Prerequisites

Use the tested Mac profile: Apple Silicon, macOS build **25G83**, with Notes already running. Vega needs Node.js 20 or later and SSH access to the Mac account that owns the Notes store. SSH must already trust the host key; the companion will not accept new keys or ask for passwords.

The Mac account needs permission to read its Notes store and automate Notes through its public scripting interface. The worker reads SQLite in read-only mode and never edits the database, loads private frameworks, launches Notes, or inserts a typed heading.

## Configure a supervised test

Build from the project root:

```bash
npm run build
```

Create a private JSON file outside the vault. Replace every angle-bracketed value before using it, and restrict the file to your account with `chmod 600`:

```json
{
  "version": 1,
  "enabled": false,
  "sshTarget": "<mac-user>@<known-mac-host>",
  "storeUuid": "<MAC_STORE_UUID>",
  "macBuild": "25G83",
  "accountDsidSha256": "<SHA256_OF_VAULT_ACCOUNT_DSID>",
  "allowedNoteIds": ["<APPLE_NOTE_ID>"],
  "journalDirectory": "/absolute/private/path/outside/the/vault"
}
```

`APPLE_NOTE_ID` is the drawing note's `apple-note-id` frontmatter value. Obtain the store UUID on the Mac with this read-only query:

```bash
sqlite3 -readonly "$HOME/Library/Group Containers/group.com.apple.notes/NoteStore.sqlite" 'SELECT Z_UUID FROM Z_METADATA;'
```

Compute the account hash on Vega without printing account credentials:

```bash
node --input-type=module -e 'import fs from "node:fs"; import crypto from "node:crypto"; const s=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); console.log(crypto.createHash("sha256").update(s.account.dsid).digest("hex"));' "/path/to/vault/.icloud-md/state.json"
```

A disabled configuration returns `{"status":"disabled"}`. For a supervised test, change `enabled` to `true`, rename the note's file on Vega, and preview without `--apply`:

```bash
node dist/macTitleBridge/cli.js --vault "/path/to/vault" --config "/path/to/private-config.json"
```

`preview` reports the requested file without publishing a title. A test that publishes changes adds `--apply` to that command. Run it under the same lock as pull/status/push; do not run competing sync processes. Keep the normal automatic service disabled for a separately approved experimental test.

## What happens during a rename

The companion first verifies the local identity and unchanged body, current cloud records, drawing/preview bytes, and the Mac's imported record versions. If the Mac is unavailable, it leaves the filename request pending and sends no title changes.

It then publishes the drawing's custom title, waits for the Mac to import that update, assigns the native Mac note name if necessary, and finally publishes the containing note's display title and modification date. That ordering is intended to prevent a native reader from deriving the note name from the previous drawing title. It never rewrites note text, formatting, drawing assets, or the legacy attachment title.

Completion requires unchanged document and drawing data plus the requested name in both the Mac's public API and its saved note row. It can remain pending while Notes imports or saves. After completion, run an ordinary pull to adopt the matching filename; the companion never rewrites the local note or clone state. Refuse any remaining move of a managed drawing instead of pushing it: an ordinary move can echo document and asset fields.

The private journal must stay outside the vault. It contains the before-state and durable operation records needed to avoid repeating uncertain writes; keep it private and retain it while a rename is pending. Do not delete an operation record to force a retry or edit the configuration during a pending rename.

## Read the result

- Exit **0**: `disabled`, `preview`, `skipped`, or `completed`; inspect the JSON status before treating it as a completed rename.
- Exit **3**: `pending`; leave the filename and journal in place. A later checked cycle can continue after the Mac becomes ready.
- Exit **4**: `ambiguous`; an operation may have happened. Stop and inspect the private evidence. The companion does not repeat the uncertain operation or restore old records.
- Exit **1**: validation or preservation failed. Resolve the reported conflict before continuing.

A changed local file, another title choice, an unsupported Mac build, or changed drawing data stops the operation. An uncertain final note-title event remains ambiguous even if its title already matches; an equal title does not prove that event happened.

Before enabling this in everyday sync, verify two successive Vega renames in both native Notes lists, with one unchanged drawing after reopening the apps and another sync cycle. Automatic use must call this companion before accepting the ordinary push preview, pull again after completion, refuse any remaining move of a managed drawing, and stop on pending or ambiguous results. During supervised tests, require an empty preview before any subsequent normal push.
