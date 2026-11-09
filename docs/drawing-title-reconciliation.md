# Rename drawing-only notes

This opt-in workflow renames a private Apple Note containing one drawing and no
typed text. Rename its Markdown file within the same folder, leaving the contents
unchanged. The note keeps its identity, drawing, formatting and preview files.
It requires an account-bound vault created with `clone --filename-as-title` and
no `apple-note-title` frontmatter key on the note.

The first push changes the drawing title and the note title. Apple Notes can
receive those changes in an order that leaves the list name stale. Later pushes
send the note title again when at least five minutes have passed. These refreshes
leave the modification date, document, drawing files and local Markdown alone.

Keep periodic sync running. A device returning from offline may need to receive
the drawing title followed by a later note update before its list name changes.
The writer does not use Notes.app, SSH or a native-device acknowledgement.

## Setup

Use the same options for preview and push:

```sh
icloud-md status /path/to/vault --reconcile-drawing-titles /private/state/drawing-titles \
  --drawing-title-folder FOLDER-UUID --drawing-title-note NOTE-UUID
icloud-md push /path/to/vault --reconcile-drawing-titles /private/state/drawing-titles \
  --drawing-title-folder FOLDER-UUID --drawing-title-note NOTE-UUID
```

The examples use shell line continuations. In PowerShell, put each command on
one line and use Windows paths.

Keep the state directory outside the vault, private to your user account, and at
one stable location. It holds bounded rename progress, not raw cloud records or
signed asset URLs. Changing or deleting it is not a safe way to force a retry.

Existing progress records are converted when a title push opens them for writing.
Preview leaves them untouched. Conversion preserves pending requests and refresh
deadlines; older development builds cannot read the new format. Keep the previous
store backup when upgrading, and do not alternate old and new builds.

Folder and note filters are optional and repeatable. A note must match both
filter groups when both are supplied; alternatives within each group are allowed.
The note UUID is in its `apple-note-id` frontmatter. Its folder UUID is the
`notes[NOTE-UUID].folderRecordName` value in `.icloud-md/state.json`. Read these
values without editing the state file. Start with a disposable test note.

Only same-folder filename changes qualify. Other attachment types, shared notes,
folder moves, body edits and frontmatter title requests retain their restrictions.
`status` may exit with code 3 when work is pending; that is a preview result.

## Avoid overlapping commands

The feature prevents two title pushes using the same operation store from running
at once. It does not coordinate ordinary push, pull, restore or editor saves.
Avoid overlapping commands against the same vault. The broader local-writer
problem is being studied separately; this feature does not claim to fix it.

A busy store causes the second title push to stop. Normal completion and errors
release the store lock. A killed process can leave a `writer.lockdir` directory in
the operation store. There is no automatic timeout-based takeover. Stop all
commands using that store before manually removing an abandoned lock; never
remove a lock to bypass a running command.

On Windows, put the store in a directory protected by your user account’s access
permissions; Node cannot verify Windows ACLs through Unix permission bits. The
writer flushes request files before sending cloud changes. Platforms that cannot
flush directory entries do not have the same sudden-power-loss guarantee as
POSIX platforms with directory flushing. Keep backups; an ordinary process crash
and a machine losing power are different failure cases.

## Interrupted requests and conflicts

The writer saves a request before sending it and checks the cloud version before
updating a record. If a reply is lost, it keeps the outcome uncertain instead of
blindly repeating the request or restoring an old note. A later fresh observation
can establish the current state without proving which writer caused it.

A later scheduled title refresh is a new request with a new cloud version and its
own rate limit. Restarting cannot reset that limit. A newer filename supersedes
an older request only when pending work can be handled safely. Conflicting body,
attachment, folder or sharing changes stop the old request rather than overwrite
the edit. Temporary lookup failures leave the request unresolved.

The CLI reports cloud progress, not completion on every native device. To disable
the feature, remove its options from both status and push. Keep pending state for
inspection rather than deleting it to retry.
