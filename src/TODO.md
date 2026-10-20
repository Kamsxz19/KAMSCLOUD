# TDrive — ideas / TODO

Nothing here is required for the app to work; it is a list of what could come next, roughly in
order of value.

## Sharing
- **Last-seen stamp on links** — deliberately *not* implemented: a guest must not write anything
  back into the owner's index (it would let a view-only guest publish to the index). Would need a
  separate, append-only "open log" document the owner polls.
- **Crypto-enforced links** (partly done): key *rotation* + auto-revoke now invalidates an old
  link password for real (§2 in the README), but every link still wraps the same master key. A
  per-link key the master key does not open would let revoking one link cut off that link only.
- **Editor links with an approval step** (owner sees a request before write access is granted).
- **Embedded share iframe** (`?share=<token>`) for dropping a shared folder into another page.
- **Per-recipient links** — link *names* exist now; a named list of tokens plus role defaults per
  recipient would be the next step.

## Transfers
- **Resume uploads across reloads for every size** — currently only files ≤ `persistUploadMax`
  (192 MiB) are kept as a persisted `File`. Could instead keep a `FileSystemFileHandle` from
  `showOpenFilePicker` and re-read slices from disk on resume (no size limit).
- **Parallel download of a whole folder as separate files** with one "save directory" handle
  (`showDirectoryPicker`) instead of one picker per file.
- **Stronger checksums** — each chunk now carries a CRC-32 (`parts[i].crc`) that self-heals a
  mangled chunk, but it is corruption detection, not a cryptographic guarantee. A per-file
  SHA-256 (of the whole plaintext) verified after download would also catch a truncated file.
- **Persist the source `File` for encrypted uploads too** (today encrypted uploads can't resume
  after a reload because the plaintext source isn't kept).

## Storage / data model
- **Folder sharing between accounts** (a folder owned by one account but visible to another,
  with an ACL list in the drive doc).
- **Chunk-level dedupe** by content hash, so re-uploading the same bytes reuses `fid`s.
- **Garbage collection**: sweep Telegram chunks that no drive doc references (would need a
  manifest of all known `mid`s).
- **Compression at upload time** for text-ish files (pre-deflate before chunking).

## UI / UX
- **Right-click → "Move to…" menu on a folder card** (drag-onto-folder already works).
- **Group-by** in list view ("modified by me / type") on top of the existing header sorting.
- **Thumbnails for encrypted files** (encrypt a small thumbnail with the same master key).
- **Preview paging** for text files larger than the 512 KiB head (fetch + decrypt more on scroll).
- **Grid density slider** (comfortable/compact) and persisted per folder.
- **Search filters**: `type:` / `size:` / `modified:` / `starred:` / `trashed:` exist — could add
  `owner:` (once accounts can see each other) and saved searches.
- **Thumbnails/avatars in the account switcher** and a proper "recently opened" list.

## Platform
- **Verified live-progress events** during `getFile`/`sendDocument` (the relay buffers, so
  per-chunk is the finest granularity today).
- **Self-hosted Bot API preset that also patches `chunkSizeFor` automatically** when the API
  base changes (today it is a manual Settings choice).
- **A service worker for the app shell** — impossible at the moment (see README §9).
