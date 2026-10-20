# KamsClouds (formerly TDrive) — Telegram cloud drive with a Google Drive UI

A Perchance generator *and* GitHub-Pages-ready app that turns one Telegram
chat into a personal cloud drive, with a Google Drive–style interface: sidebar,
grid/list views, folders, starring, trash, sharing, previews, per-account
sign-in, optional **client-side encryption**, **file version history**, an
**activity log**, **resumable / pausable transfers**, **folder → .zip**
downloads, plus **license selling (one-time + monthly via GCash)** and a
**customer-service chat** with an owner-only admin app.

**Public page:** `https://perchance.org/<generator-name>` (the generator name is chosen/renamed
in the editor settings; the code always links via `window.generatorName`, never a hard-coded name).

---

## 1. Where everything lives

| Path | Purpose |
| --- | --- |
| `main.pjs` | Plugin imports (`superFetch`, `kv`) + `$meta`. No app logic. |
| `index.html` | Shell markup, all CSS, one `<script type="module" src="src/tdrive/app.js">`. |
| `src/tdrive/config.js` | Tuning constants + storage keys. **No credentials** — the bot token / chat id are entered at runtime (see §6). |
| `src/tdrive/tg.js` | Telegram Bot API client (retries, 429 backoff, timeouts, multipart upload, file download). |
| `src/tdrive/vault.js` | Data layer: index + per-account drive documents, auth (PBKDF2), encryption keys, versions, activity log, mutations, auto-purge, **share links**. |
| `src/tdrive/transfer.js` | Chunked parallel upload/download engine: pause/resume, retries, resume records, encryption, zip archives, thumbnails, speed/ETA. |
| `src/tdrive/resume.js` | Device-local storage for interrupted transfers (IndexedDB records, source `File`s, `FileSystemFileHandle`s) + the download "sinks" (disk / OPFS / memory). |
| `src/tdrive/zip.js` | Streaming ZIP writer (STORE + deflate-raw, data descriptors, ZIP64), CRC-32. |
| `src/tdrive/crypto.js` | PBKDF2, AES-GCM helpers, master-key wrapping, ids/colors. |
| `src/tdrive/ui.js` | Pure render functions (sidebar, toolbar, browser, details, transfers). Includes the view model (`computeOrdered`), search filters, windowed rendering. |
| `src/tdrive/app.js` | State, event wiring, modals, toasts, viewer, drag & drop, keyboard navigation, settings, auth screen, connect screen, **share dialog + guest share mode**, **copy-to-drive**, boot. |
| `src/tdrive/icons.js` | Inline SVG icon set (no external font/CDN). |
| `src/tdrive/util.js` | Formatting + small helpers. |
| `src/tdrive/platform.js` | **KamsClouds:** Perchance↔GitHub compat — kv (kv-plugin → IndexedDB/localStorage) + fetch (superFetch → native/proxy). All app code must use this, never `window.root` directly. |
| `src/tdrive/brand.js` | **KamsClouds:** visible brand constants (internal keys stay `tdrive.*`). |
| `src/tdrive/license.js` | **KamsClouds:** lifetime/monthly keys, trial gate, GCash activation logic (Telegram-index backed). |
| `src/tdrive/commerce.js` | **KamsClouds:** license dialog, trial banner, upload gate UI. |
| `src/tdrive/support.js` | **KamsClouds:** support-chat data logic (`supportMsgs` in index). |
| `src/tdrive/support-ui.js` | **KamsClouds:** floating 💬 widget + reply polling. |
| `src/support-admin.html` | **KamsClouds (owner only):** support inbox, GCash approve/reject, key generator. Keep private; password-gated. |
| `src/license-generator.html` | **KamsClouds (owner only):** focused license-key generator — generate/copy/revoke lifetime & monthly keys. Keep private; password-gated. |
| `src/github-deploy-index.html` | **KamsClouds:** GitHub Pages `index.html` — rename to `index.html` when copying to GitHub. |
| `src/github-deploy-worker.js` | **KamsClouds:** Cloudflare CORS relay for api.telegram.org. |
| `src/github-deploy.md` | **KamsClouds:** full GitHub/selling deploy guide. |

Everything under `src/` ships with the generator. `scratch/` never ships.

---

## 2. Storage model (how Telegram is used as a drive)

There is **no server**. The Telegram Bot API is the only backend, reached from the browser
through `superFetch` (the bot API has no CORS headers, so a direct `fetch` fails).

```
pinned message (text)          →  pointer: { head: { mid, fid } }
  └─ head document (JSON)      →  { accounts: [ {id,name,salt,hash,it,enc,wrapSalt,wrapped,drive:{mid,fid}} ] }
       └─ per-account drive doc (JSON, one Telegram document)
            { folders:[…], files:[ { …, parts:[{mid,fid,size,csize}], versions:[…], thumb, thumbMid, enc } ],
              log:[ {at,kind,name,size,by} ] }
                 └─ file chunk documents (sendDocument, 4–8 MB each)
                 └─ thumbnail (sendPhoto, largest size file_id)
```

* **Discovery**: `getChat` returns the newest pinned message. Its text starts with
  `PERCHANCE_DRIVE_INDEX` and holds a tiny JSON pointer to the head document, so the pinned
  text stays far below Telegram's 4096-char limit no matter how many accounts exist.
* **All index writes** upload a fresh document and delete the previous one, so the chat stays
  tidy (one head doc + one drive doc per account + one message per file chunk).
* **Local cache**: `kv-plugin` (`kv.tdrive` folder) caches the index, each account's drive doc,
  the session and UI settings, so the drive paints instantly on reload and still shows cached
  data offline; the Telegram copy is authoritative and is re-fetched in the background.
* The format is compatible with the pre-existing `perchance-drive-index` v1 layout: a v1 index
  (accounts inline) is migrated automatically into the v2 head-document layout.

### Auth

* Accounts are per-chat, not per-device: `PBKDF2-SHA256`, 120 000 iterations, 16-byte salt,
  32-byte hex hash (WebCrypto `deriveBits`). Create an account on one device and sign in with
  the same name/password on another.
* Sessions are **device-local** (kv) — nothing token-like is ever written to the shared chat.
* Passwords never leave the browser; only salt+hash go to Telegram (and anyone in the chat can
  read them, so use a real password).

### Client-side encryption (optional, chosen at account creation)

Envelope scheme, so that a password change never requires re-uploading files:

```
masterKey        = 32 random bytes, generated once per account
KEK              = PBKDF2(password, wrapSalt, it)      (never stored)
wrappedMasterKey = AES-GCM(KEK, masterKey)             (stored in the public index)
chunk ciphertext = AES-GCM(masterKey, plaintextChunk)  (fresh 12-byte IV per chunk)
```

* `parts[i].size` is the **plaintext** size and `parts[i].csize` the ciphertext size
  (+28 bytes per chunk), so file sizes and stream offsets stay correct.
* Thumbnails are skipped for encrypted files; previews/text extraction decrypt on the fly.
* The unwrapped master key lives only in `sessionStorage`, so a reload keeps working but
  closing the tab (or Settings → *Lock now*) re-locks the drive. Uploading/reading while locked
  is refused with a clear message; the app prompts for the password after an automatic
  session restore (`askUnlock()`).
* Encryption protects file **contents** from other members of the Telegram chat. It does not
  hide file names, sizes, or that a drive exists.
* **Key rotation** (Settings → *Rotate key*, `vault.rotateEncryptionKey`) generates a brand-new
  master key and re-encrypts every file with it, deleting the old chunk messages and all version
  history. Because shares wrap the *master key*, a leaked link password would otherwise stay
  valid forever — rotating is the only real way to revoke access to ciphertext already handed
  out, so rotation also **revokes every share** owned by the account. Files are skipped (and
  counted in the returned `failed`) if a chunk can't be re-read; the account key is still rotated.

### Conflicts, offline edits and tombstones

* `scheduleSave()` writes the drive document into `kv` immediately and records a `pending`
  marker, so an offline session (or a refresh in the middle of an edit) is never lost:
  `openAccount()` prefers that cached copy over the server one and re-publishes it.
* Before every save, `reconcileBeforeSave()` (throttled to 15 s) re-reads the pinned index and
  the account's remote drive doc; if the remote revision is ahead it merges node-level
  (`mergeDrives` / `mergeIndexes`: additions are unioned, same-id nodes resolve to the newer
  `modifiedAt`). This prevents two devices from clobbering each other.
* **Tombstones** (`tdrive.tombstones.v1`, device-local) record deleted account ids and revoked
  share tokens, and the merger refuses to re-add them — otherwise a stale index copy could
  resurrect a deleted account or a revoked link.
* Each chunk stores a **CRC-32 of the plaintext** (`parts[i].crc`); a mismatching download drops
  the cached `getFile` path and retries, self-healing a truncated/mangled chunk.

---

## 3. Share links (Viewer / Editor — Google-Drive style)

Every item can be shared by an **unguessable public link** that needs no account:

```
https://perchance.org/<generator-name>#share=<token>
```

* **Create**: select an item → *Share* (or the details panel / right-click → *Share*). Pick a
  role — **Viewer** or **Editor** — optionally an expiry (never / 1 / 7 / 30 / 90 days), then
  *Create link*. Multiple links per item are allowed, each with its own role and expiry, and can
  be re-roled or revoked from the same dialog (`vault.createShare` / `updateShare` /
  `revokeShare`).
* **Viewer**: opens the shared item in a scoped, read-only view — preview, navigate inside a
  shared folder, download single files, or *Download as .zip* for folders. Editing UI is hidden
  and mutation actions are refused (`ctx.readOnly` + an allow-list in `handleAction`).
* **Editor**: the same scoped view but with upload, new folder, rename, move, star and trash
  enabled. Changes are written to the **owner's** drive document (the guest acts on the owner's
  drive doc via the same save pipeline). Move is limited to the shared subtree.
* Navigation, keyboard shortcuts and the context menu are all clamped to the shared subtree
  (`vault.inSharedScope`); guests never see the owner's other files, storage stats or settings.
* Viewer links **auto-refresh** every 30 s (while visible and idle) so newly added files appear.
* Shares live in the public index document as `{ token, accId, nodeId, perm, expiresAt, label,
  name, enc, wrapSalt, wrapped }`. Purging an item revokes any shares that pointed at it.
* A link can carry an optional human **name** (the *Link name* field, e.g. "For the design
  team") shown in the share list, and the dialog offers *Share your entire drive instead* to
  re-open against the drive root.
* Revoking a link writes a **tombstone** for its token, and `refreshShared()` treats a revoked or
  expired link as *gone* on the guest's next tick (the guest sees a "Link unavailable" screen
  instead of stale content). For an encrypted drive, revocation alone does not change the key —
  use Settings → *Rotate key* to truly invalidate an old link password (§2).

### Copying a shared item into your own drive

While viewing a share, *Save to my drive* (share banner, or right-click → *Save to my drive*)
copies the selection — or the shared item / current folder if nothing is selected — into one of
your **own** accounts (`copyToMyDrive` in `app.js`):

* Only files (recursively, keeping the folder structure) are copied; source bytes are read once
  with the **share's** key and re-uploaded with the **target account's** key, so an item can move
  between plain and encrypted accounts.
* The target account is chosen from the index and requires its **password** (`vault.checkPassword`
  — verified even for plain accounts) so a guest can't write into someone else's drive.
* `vault.withAccount(id, password, fn)` swaps the whole session into the target account, runs the
  uploads (creating folders as needed), flushes the save, then restores the exact previous state
  (account, drive, key, guest/share view, session and pending markers). A blocking progress
  overlay covers the UI while it runs and a re-entrancy guard prevents concurrent copies.
* Capped at `COPY_MAX_BYTES` (512 MiB) per copy, with the size shown in the confirmation.

### Encrypted drives

A link to an **encrypted** account must carry a **link password** (asked for at creation). The
link stores only the master key wrapped by that password (`wrapped` / `wrapSalt`, PBKDF2 + AES-GCM);
the account password is never exposed and the raw master key is never written to the index.
Guests are prompted for the link password on open (`vault.unlockShare`); the unwrapped key is
cached in `sessionStorage` for the tab only. If a link is view-only, the key can decrypt but the
guest still cannot modify anything.

### Caveat

The backend is reachable by anyone who has the bot token + chat id, and whoever enters them can
see every account's file tree (the index is readable). The link tokens are 128-bit random, so
they are not guessable, and the roles enforce correct behaviour in the app; treat a link like
"anyone with the link can read this". For an *encrypted* account, a link additionally requires the
link password, so the ciphertext is the real boundary there — but see §6.

---

## 4. Transfers

Measured in the live preview (through the Perchance proxy, mid-range connection):

| Mode | Throughput |
| --- | --- |
| 1 connection | ~1.3–1.6 MB/s |
| 4 connections | ~4.3 MB/s |
| 8 connections | ~9.1 MB/s |
| upload (any concurrency) | ~1.3–1.9 MB/s (relay-bound) |

* Files are split into chunks at upload time (`targetChunks` + a 4–8 MiB clamp by default, or a
  fixed size from Settings → *Chunk size*, for self-hosted Bot API servers).
* Uploads run `uploadConcurrency` chunks in parallel, interleaved round-robin so small files
  finish early. Failed chunks are retried in place (`chunkRetries`), and a job only fails after
  its last chunk keeps failing.
* Downloads run `downloadConcurrency` chunks in parallel. `getFile` paths are prefetched in
  parallel (a single `getFile` costs ~2.5 s) and de-duplicated.
* **Pause / resume** (per transfer and "pause all") uses a per-job gate; in-flight chunks are
  allowed to finish, then the job parks.
* **Resumable downloads**: chunks are written with random access into an OPFS staging file (or
  straight into the file the user picked with `showSaveFilePicker`). Progress + the staging
  descriptor are persisted to IndexedDB, so after a reload an interrupted download appears in
  the transfers panel as *paused → restored* and only the missing chunks are re-fetched.
  Staged files are garbage-collected on boot (`sweepOpfs`) and 10 minutes after a successful
  save.
* **Resumable uploads**: the source `File` is kept in IndexedDB for files up to
  `persistUploadMax` (192 MiB) and for non-encrypted accounts, so an interrupted upload can also
  resume after a reload. Cancelling or discarding deletes the orphaned Telegram chunks.
* If the OPFS/disk path is unavailable the engine falls back to an in-memory blob (no
  cross-reload resume, but pause/retry still work) and then triggers a normal download.
* **Folder → .zip**: folders are streamed into a ZIP (deflate-raw for compressible kinds,
  STORE otherwise) using data descriptors, so nothing is buffered in memory; ZIP64 records are
  emitted automatically past 4 GiB. The archive is staged in OPFS and handed to the browser.
* Live speed (EMA), ETA, per-chunk progress, pause/resume/cancel/retry/discard are shown in the
  transfers panel.
* **Up to 2 GB per file** (`maxFileSize`).

### Chunk size vs. Telegram's limits

The public Bot API can only download files ≤ 20 MB (`getFile`) and upload ≤ 50 MB, and the
Perchance relay rejects request bodies above ~17 MiB. Chunks are therefore kept at ≤ 8 MiB,
which keeps large files working on the public API. If you host a
[self-hosted Bot API server](https://github.com/tdlib/telegram-bot-api) (that's what `apiId` /
`apiHash` in the config are for), set the API base and pick a fixed chunk size in Settings —
a single 2 GB chunk then works.

---

## 5. Version history, activity log, trash

* Re-uploading a file with an existing name **replaces** it and pushes the previous content into
  `versions` (capped at `maxVersions`, oldest versions have their Telegram messages deleted).
  The details panel gets a *N versions* action with Download / Restore / Delete per version.
  Toggle the behaviour in Settings → *Version history*.
* Every mutation writes an entry to `drive.log` (uploads, downloads, zip, trash/restore, rename,
  move, deletes, password changes), viewable in the **Activity** section; capped at
  `maxLogEntries`.
* Settings → *Auto-empty trash* purges trashed items older than N days on login
  (`vault.autoPurgeTrash`). Emptying trash deletes every chunk, thumbnail and old version
  message for the purged files.

---

## 6. Connection credentials (shared default, no connect screen)

The bot token + chat id are hard-coded in `config.js` as the shared backend for
ALL visitors. Boot goes straight to the login screen — anyone who creates an
account / signs in uses that one Telegram chat. `kv` per-device credentials, if
present, are ignored while the config holds real values.

Public-source warning: anyone viewing the generator source can read the token,
so use a dedicated bot + private chat.

Keep the chat invite link private. The backend chat stores password **hashes**
and the **wrapped master key** (useless without the password, but the wrapper
enables offline guessing of weak passwords).

---

## 7. Changing configuration

`src/tdrive/config.js`:

* `apiBase`, `botToken`, `chatId` — the shared backend (§6).
* `targetChunks`, `minChunkSize`, `maxChunkSize` — chunking window (Settings can override).
* `uploadConcurrency`, `downloadConcurrency` — parallelism (also exposed in Settings).
* `maxSpeedMBps` — global upload/download throttle (0 = unlimited; Settings → *Speed limit*).
* `maxFileSize` — per-file cap (default 2 GiB).
* `maxAccounts`, `pbkdf2Iterations` — auth limits/strength.
* `shareTokenBytes`, `maxShareDays`, `maxVersions`, `maxLogEntries`.
* `chunkRetries`, `persistUploadMax`, `defaultTrashDays`.

Settings are stored in `kv` under `tdrive.settings.v1`.

---

## 8. Performance notes

* Child counts per folder are precomputed once per render (`buildChildCounts`) instead of
  walking the tree per card.
* Views with more than `VIRTUAL_THRESHOLD` (160) items are **windowed**: only the visible rows
  are in the DOM, with container padding (grid) / spacer rows (list) preserving the scroll
  height. The window is driven by `state` + `ctx.metrics` (measured card height/columns).
* Scroll events are not delivered reliably inside the embedded preview, so the window is also
  polled every 240 ms; `render()` additionally falls back to a timer in case `requestAnimationFrame`
  is throttled.
* `computeOrdered()` is the single source of truth for the item list, so the toolbar, window and
  browser all agree with each other.

---

## 9. Offline behaviour

* Booting offline works: `loadIndex()` falls back to the cached index and `openAccount()` to the
  cached drive doc, so the app opens read-only with an "offline" banner. Mutations queue in
  memory and flush when the connection returns.
* A full offline **app shell** is not possible here: a service worker can only be registered
  from a script inside the generator's own file tree, which caps its scope at `/src/…`, and the
  platform already runs its own service worker to resolve (unsaved) `src/` files — registering
  ours would break that. So the app relies on the browser HTTP cache + the kv cache instead of a
  PWA service worker.

---

## 10. Testing notes

* `getChat` → newest pinned message is the whole discovery mechanism: if another app pins over
  it, TDrive re-publishes its own index from the local cache on the next load.
* That cache-recovery republish is **last-writer-wins**: a device holding a stale cached index
  (e.g. one whose network fetch failed) can re-publish it and therefore *re-appear* an account
  that was deleted from another device. If you delete an account, reload/re-check on the other
  devices, or treat the Telegram head document as authoritative and avoid mutating from a device
  that was offline for a long time.
* Boot ordering: `vault.boot()` must finish before `enterApp()`; `enterApp()` resets to Home and
  calls `startSession()` (restore resumable jobs → unlock prompt → trash auto-purge → `#tdrive=`
  deep link).
* `window.TDrive` exposes `{ state, vault, tg, tm, cfg, doRender, render, _view, _win, metrics,
  enterApp, showAuth, onBrowserScroll, windowBounds }` for debugging from the console.
* There is no `getMessages` in the Bot API — the drive's file tree can only be read back from the
  JSON documents described above. Never delete the head/drive documents unless you intend to
  lose the tree (the actual file chunks would remain, unreferenced).
* Screenshots: the bundled `snapshot.js` helper **hangs** on this page, and drawing an
  SVG `foreignObject` to a canvas **taints** it in Chrome (`toDataURL` throws). Use
  `html2canvas` from esm.sh instead, with `ignoreElements: n => n.tagName==="IMG" || n.tagName==="IFRAME"`
  (cross-origin Telegram thumbnails would otherwise taint the canvas):
  ```js
  const { default: h2c } = await import("https://esm.sh/html2canvas@1.4.1?bundle");
  const el = document.getElementById("tdriveRoot");
  const c = await h2c(el, { width: el.offsetWidth, height: el.offsetHeight, ignoreElements: n => n.tagName === "IMG" });
  return c.toDataURL("image/png");   // pass a resultPath so it is saved as a real PNG
  ```
* End-to-end checks that were run against the real backend (and cleaned up afterwards): encrypted
  upload → decrypt; byte-exact download; pause → reload → resume (byte-exact); folder zip
  validated with `@zip.js/zip.js`; ZIP64 records; bulk rename; version restore; lock/unlock;
  password change round-trip; trash auto-purge; blob fallback with OPFS disabled.
* Share-link checks (also cleaned up): create Viewer + Editor links; open each via
  `#share=<token>` (hash boot and `hashchange`); scope clamping (`openFolder` to `root` refused);
  read-only enforcement (toolbar/details show only preview/download, `Delete` refused);
  editor mutation (create folder → persisted into the owner's Telegram drive doc); file share
  shows text-only; a 42 MB download from a Viewer link completed byte-exact; an **encrypted**
  account's link: wrong password rejected with "Incorrect password", correct password unlocked,
  and a guest download decrypted to the exact original bytes (40 000 B, pattern-checked); an
  encrypted Editor link uploaded a file that was stored as ciphertext (`csize = size + 28`).
* Later-session checks (all cleaned up): search filters (`type:`, `size:>10mb`, `size:1mb-100mb`,
  `modified:<7d`, bare text — folders count as size 0) and clickable sort headers; `?` shortcut
  help; undo-purge; Storage → *Reclaim space*; share *Link name* + *Share your entire drive*;
  **copy-to-drive** into a plain account (byte-exact new file) and into an **encrypted** account
  (`enc:true`, decrypts byte-exact) with the guest session correctly restored afterwards;
  **key rotation** (old chunks deleted — a later `deleteMessage` on the old mid reports
  "message not found" — file still decrypts, shares revoked, old token resolves as `missing`);
  runtime-credentials gate (blank config + cleared `kv` shows the Connect screen).
* `$meta.image` is a generated product mock-up
  (`https://user.uploads.dev/file/00f63089bf3094cd6e616e861090b848.jpg`) because a live
  screenshot of the app would only ever show the sign-in / connect screen. Re-generate and
  re-upload if the UI changes materially.
