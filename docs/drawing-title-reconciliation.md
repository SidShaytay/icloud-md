# Drawing-note title reconciliation

Use an existing account-bound vault cloned in filename-as-title mode
(`clone --filename-as-title`). This opt-in Linux workflow handles same-folder
filename renames for private notes
containing one Apple drawing and no typed heading. It keeps the existing note,
attachment, document, formatting and drawing/preview assets.

Apple Notes may import a Note before its drawing's new title, leaving the device's
list name stale. The first push changes the drawing title and Note title, then
records an ongoing reconciliation policy. Later pushes reassert only the Note
title when its five-minute interval is due. These refreshes preserve the Note's
modification date, document and assets, and do not touch the Markdown file.

Keep the ordinary Linux sync workflow running. A device may need to fetch the
attachment title and a later Note update before its list name catches up. This is
not a promise that one completed push will repair a device that stays offline
until after Linux stops syncing. No Mac helper, SSH access, native Notes API or
native-device acknowledgement is used by the writer.

## Enable the mode

Use the same options on `status` and `push`:

```sh
icloud-md status /path/to/vault --reconcile-drawing-titles /private/state/drawing-titles \
  --drawing-title-folder FOLDER-UUID --drawing-title-note NOTE-UUID
icloud-md push /path/to/vault --reconcile-drawing-titles /private/state/drawing-titles \
  --drawing-title-folder FOLDER-UUID --drawing-title-note NOTE-UUID
```

The state directory must be private, outside the vault, and remain at the same
location. The mode pins its identity to prevent changing directories to bypass an
uncertain request. It stores bounded per-note state, not signed asset URLs or raw
cloud records. Preview does not claim a request or create reconciliation state.

Folder and note filters are optional and repeatable. Multiple folder filters are
alternatives; multiple note filters are alternatives. When both are supplied, a
note must match both groups. Filters select existing IDs, so renaming a folder
does not silently select a different folder. Start with a disposable test note.
Other attachment types, shared notes, body edits and folder moves retain the
ordinary refusal rules.

Find the note UUID in its Markdown `apple-note-id` frontmatter. For its folder
UUID, read the matching `notes[NOTE-UUID].folderRecordName` entry in
`.icloud-md/state.json`. These are lookups; do not edit the state file.

## Hold the normal writer lock

Linux and the `flock` command from util-linux are required. The commands above
require the actual exclusive lock used by the normal Linux
sync writer, inherited as a file descriptor. A flag or open file alone is not
sufficient. Pause the scheduled writer before a manual run and use its existing
lock path. For example, in Bash:

```bash
umask 077
notes_lock="/path/to/the/normal/sync.lock"
exec 9<>"$notes_lock"
flock --nonblock 9
export ICLOUD_MD_PROBE_LOCK_PATH="$notes_lock"
export ICLOUD_MD_PROBE_LOCK_FD=9
# Run pull, then status and push with the same reconciliation options.
```

The `PROBE` variable names are retained from the diagnostic interface; they carry
only Linux lock authority. A scheduler wrapper that already holds the lock should
forward that descriptor rather than open another lock. Python wrappers must use
`subprocess.run(..., pass_fds=(lock_fd,), env=...)`; otherwise the CLI loses the
inherited descriptor. The mode also holds its own vault lock through cloud writes
and local bookkeeping, and per-note locks through individual dispatches.

`status` can exit with status 3 when changes are pending. It remains a preview,
not a failed upload. A scheduled workflow should handle that exit as usual.

## Conflicts and uncertain writes

A newer filename request supersedes an older managed title once pending requests
are safely fenced. A changed body, drawing reference, metadata, folder relationship,
sharing state or deletion stops the old policy rather than restoring an old title.
Transient lookup errors leave the outcome uncertain instead of treating missing
information as a safe overwrite.

Every dispatch has a unique durable request and a fresh conditional record version.
An uncertain request is not called an acknowledgement or blindly replayed. Fresh
cloud observations can establish a postcondition without proving which writer
caused it. A later due, same-value refresh may use a new request and fresh version;
its predecessor remains recorded as uncertain. Restarting cannot reset the rate
limit. No old cloud document is restored to recover a title operation.

The CLI reports cloud intent and ongoing reconciliation, not completion on every
native device. To disable the mode, remove its options from both preview and push
in the Linux workflow. Keep pending state for inspection; do not delete it to
force a retry.
