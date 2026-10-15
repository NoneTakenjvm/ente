# Ente Photos — Custom Frontend Plan

## Agent Progress Report

> **Instructions for agents:** Update this section at the start and end of every work session. Do not skip it — the next agent depends on it.

| Field | Value |
|---|---|
| **Last updated** | 2026-10-15 |
| **Last agent / session** | Relative sort made progressive/cancellable/faster; viewer slideshow (`0.3.206`, uncommitted) |
| **Current milestone** | Post-M8 UX / upload performance |
| **Blockers** | ffmpeg WASM still heavy when VideoEncoder is unavailable; test-account password must be rotated (was in prod chunks + git history) |
| **Next recommended action** | Phone QA of `0.3.206` (list below), then the `0.3.195`–`0.3.203` lists. Watch the first CI run on push. Rotate the test-account password. |

**This session (uncommitted, `0.3.206`): relative sort + slideshow**
1. **Relative sort** — it worked but the O(n²) walk ran for tens of seconds on large views with no feedback, and superseded jobs queued in the one worker. `sortIdsByRelativePacked` now keeps remaining rows contiguous (swap-remove, ~1.6× faster) and reports the chain head at 200, 400, 800… files; the worker posts those as `partial` replies (`createWorkerClient` routes them to `onPartial`), so the gallery reorders progressively. A "Sorting by similarity…" toast shows while it runs; a stale or unmounted job terminates the worker (`cancelRelativeSortInWorker`).
2. **Slideshow** — Play/Pause button in the viewer top bar (`hooks/use-slideshow.ts`). Photos advance after Settings → Slideshow seconds (3–30, default 5); videos autoplay unlooped and advance on end. Paused while zoomed, while the crop editor, tag picker or a confirm dialog is open, or mid-swipe; the photo timer then resumes with its remaining time, but at least 1 s. Loops back to the first item after the last. Holds a screen wake lock. Follows the viewer's current list (album, tag filter, sort).
3. **QA** — relative sort on a large library (toast, head appears fast, switching sort mid-run cancels); slideshow on photos and videos, manual swipe during play, zoom pauses / unzoom resumes (never sooner than 1 s), last item loops to the first, seconds setting persists, screen stays on.

**Previous session (committed locally, not pushed, `0.3.203`): knip**
1. **knip** — `mobileapp/knip.json` (entries: pages, `sw.ts`, workers, scripts; ignores only CSS-imported/config-only deps and the system `ffmpeg` binary); `npm run knip` runs in the deploy workflow after the type checks.
2. **Cleanup** — `export` dropped from 59 file-local symbols; dead `flushDerivedReplaceOutboxPersist`, `flushFavoriteOutboxPersist`, `countKitPresenceInWorker` and a duplicate `findUserFavoritesCollection` re-export deleted. No crypto/metadata behaviour touched.
3. **QA** — none beyond a smoke run (no behaviour change); covered by the `0.3.195`–`0.3.202` lists.

**Previous session (committed locally, `0.3.202`): simplification plan Phase 5 + follow-ups**
1. **Crop UI** — react-image-crop removed. `components/CropBox.tsx` (pointer drag, corner handles, edge handles in the full editor, `lockedRatio`, 32 px minimum, stays inside the media) is shared by QuickCropOverlay and MediaEditorOverlay; crop state is one normalized rect. Lock on shrinks the box to the viewport aspect about its centre; video stays free-form. `maxAspectRatioCrop`, `encodeBakedCrop` and `pixelCropToSourceRect` deleted.
2. **Quick crop decode** — `encodeNormalizedCroppedJpeg` sends the normalized rect to the compress worker, which resolves it against its single decode (the size-probe `createImageBitmap` is gone).
3. **Type checks and CI** — `tsc --noEmit` now has 0 errors (test fixtures fixed); `scripts/tsconfig.json` lib ES2022 + WebWorker and the global electron types, so `typecheck:scripts` passes; new `npm run typecheck`. The deploy workflow runs lint, typecheck, typecheck:scripts and tests before the build (Linux runner untested; `@napi-rs/canvas` is the likeliest snag).
4. **Sort menu** — `SortMenu.tsx` 947 → 196 lines; `sort-menu/` holds SortPanel (one table-driven direction section), NearnessSection, KitPicker (+ `KitPickerList`) and ViewportTargetInputs; data hooks in `hooks/use-sort-menu-data.ts`.
5. **QA** — full editor: default box at the viewport aspect, move, corner/edge resize locked and unlocked, re-lock snaps, rotate resets the box, save gives the boxed region; video editor crop + trim + save; quick crop on tiles (incl. HEIC) applies the boxed region; Options menu every sort, viewport W/H edit + Use device, nearness kit/tags flows, None with shuffle active, deleting the active nearness kit drops the ordering.

**Previous session (committed locally, `0.3.201`): simplification plan Phase 3 §3.1 + rest of Phase 4**
1. **Jobs** — `hooks/use-job.ts` (`useJob`: status, progress, start/pause/reset, supersede check, abort on unmount; partial results still applied after pause) and `manage/JobControls.tsx`; `jobPercent` in job-utils. `usePhashJobStore` / `useCompressJobStore` deleted, plus the unused `shouldPause` / `waitIfPaused`. Auto-crop scan/apply loops moved to `lib/auto-crop-job.ts`. Scans with nothing pending toast "already complete" without starting. Similar now applies a paused scan's partial results (like Settings).
2. **Manage pieces** — `useGridSelection` (Trash, Archived), `TagPickerSelect`, `NumberToggleField`, video switches as a config array. Trash's restore target follows the default until picked. Tune cancel toasts from the button, not on unmount.
3. **Grid and cards** — `useGridMarquee`, `useListScrollController`, shared `useThumbnailEntry` / `ThumbnailImage`, `TileFrame`, `MediaListCard` for album and session cards. Covers and dedup thumbs now retry after a failed thumbnail.
4. **Editor** — `MediaEditorOverlay` replaces CropEditorOverlay + VideoEditorOverlay (`kind: "image" | "video"`).
5. **Session and pages** — one `ensureSessionRestored()` (shares an in-flight restore); `LOGIN_PATHS` exported once. AppShell owns the session gate and `SyncBanner`; gallery renders FilteredMediaView, which renders the tool footers and freezes the viewer list; `useLibraryFiles`, `useLibraryLoading`, `GallerySortToggle`; filter-change tool reset lives in the display pipeline.
6. **PhotoViewer** — 2413 → 724 lines: `useSlideMedia` (all loads via `loadMediaBytesForEdit` with abort, one `setSlideUrl`), `useViewerGestures` (one tap recognizer, root pointer-down chrome reset), `useViewerTagDraft`, `photo-viewer/ViewerChrome` and `SlideParts`; edit and revert share `applyDerivedEdit`.
7. **QA** — viewer: single tap toggles chrome, double-tap zoom on image and video, pan/pinch, tap while zoomed, swipe edges, swipe-down dismiss and snap back, chrome auto-hide resets on button press, fast swiping (no stuck Downloading), video session cache, Retry, crop/video edit save then upload (incl. HEIC in Chrome, forced upload failure), revert last edit, delete neighbour/last, tag sheet save on close, Escape/arrows, Safari edge-back. Editor: image crop + lock aspect, rotate, video rotate + trim + save progress. Manage: Settings CLIP and thumbnail scans start/pause/resume/leave mid-scan, Similar scan, Compress select/compress/stop/reset, Auto-crop scan/crop/cancel, Tags nearness tune + cancel, Trash and Archived select/restore/delete, settings toggles persist. Pages: cold load and logout→login on gallery/albums/recents/manage (loader, SyncBanner), album view tools and footers, gallery sort toggle, marquee select in the gallery and the upload grid, album/session cards.

**Previous session (committed locally, `0.3.200`): simplification plan Phase 3 §5.4 + Phase 4 §2.1b–f, §1.3/§1.7, §2.6**
1. **Merged scan** — the phash worker also scores quality (`analyze-thumbnail`); `runThumbnailAnalysisJob` in `similarity-job.ts` decodes each thumbnail once and fills whichever index is missing or stale. `image-quality-job.ts` and `image-quality.worker.ts` deleted; `lib/quality-index.ts` holds hydrate/persist. Both index formats and versions are unchanged. Known gap until §3.1: the Settings scan does not abort on unmount.
2. **Tag filter UI** — 9 files → 5: `SortMenu` (one Options dropdown with Sort/Filter tabs), `ScopeFilterMenu`, `TagFilterControls`, `TagFilterEditor`, plus `use-scope-counts`. `TagFilterBar` 686 → 281 lines; `GalleryToolsMenu` is a `tools` array. Binding and draft hooks share `tagFilterActions`; tag-store's 12 per-op filter setters are replaced by one `updateTagFilter(target, update)`.
3. **Footers** — `ToolFooter` shell and `PendingBatchFooter`; Crop and Rotate are thin wrappers; Stamp shares the kit list/chips; SelectionActionFooter has one busy state and toasts errors.
4. **Upload** — `core/upload/run-upload-batch.ts` owns the worker pool, cancel and teardown (tested); `UploadPanel` holds one `PanelState` union. Upload store lost the unused cancel flag.
5. **QA** — Manage → Similar and Settings scan each fill both phash and quality (quality sort works after either); Options menu Sort/Filter tabs and active dot, None keeps the shuffle, nearness kit picker and custom filter; scope counts in gallery, album bar, compress panel and album editor; tag include/exclude/groups/kits in gallery and album view; crop/rotate apply, discard and a failed apply; Stamp kit list; selection actions show a toast on error; upload progress, cancel, a failing file, success, and closing the panel mid-upload.

**Previous session (committed locally, `0.3.199`): simplification plan Phase 3 wave 2a**
1. **Gallery ordering** — ui-store holds one `ordering: GalleryOrdering | undefined` (viewport fit, uploaded at, image size, quality, tag fit, relative, nearness, shuffled) with `setOrdering`; the per-kind fields, setters and `clearOrderings` are gone. One `sortFilesByScore` in `lib/sort-files.ts`; `image-size-sort.ts` and `uploaded-at-sort.ts` deleted.
2. **Selection tools** — selection-store has `mode: "none" | "select" | "stamp" | "rotate" | "crop"` and one `applyBusy`; switching mode clears pending rotations/crops.
3. **Job helpers** — `lib/job-utils.ts` (`workerCount`, `eligibleImageFiles`, `runWithConcurrency`, `waitIfPaused`, `progressReporter`); copies in image-quality-job and kit-embedding removed.
4. **Manage router** — `pages/manage.tsx` is a 150-line section router; sections derive from ManageHub's category arrays. New `ManageDuplicatesPanel`, `ManageSimilarPanel` and shared `DedupGroupReview` (dry-run is local state). Leaving Similar mid-scan now pauses the phash scan.
5. **QA** — each Sort menu option replaces the previous one and None resets; shuffle on/off (None in Sort keeps the shuffle); relative closest/furthest keeps the start, New start reshuffles, Set Relative from the viewer; kit likeness starts Stamp, rival penalty/exclusion rebuild the order; Select/Stamp/Rotate/Crop are mutually exclusive, Apply locks then exits, a tag-filter change exits Select/Rotate/Crop but not Stamp; bottom nav hides with any tool; Manage → Exact duplicates (stats, keeper, Show more, dry run, cleanup); Manage → Similar (scan, pause/resume, leave mid-scan and return shows Resume, threshold, cleanup); back navigation from tools and `/manage?section=tags`; logout resets the ordering.

**Previous session (committed locally, `0.3.198`): simplification plan Phase 3 wave 1**
1. **Library store** — file patches are copy-on-write (`commitFilePatches`); `filesRevision`, `patchFileInPlace` and the gallery remap are gone. Single-file favourite/archive go through `batchSetFavorite` / `batchSetArchived`. Trash, duplicate prune and compress-replace share `removeFilesFromLibrary` (prune now clears the same outbox state as trash). Bootstrap and sync share `applyOrganizerConfig`, so cold start also hydrates tag types, registered tags and query albums from the cached config. The visibility drain writes on a clone of the file.
2. **Tag store** — one `typeConfig` field and one rewrite path for rename/delete/merge; filter-tree helpers delegate to lib. Renaming an included tag onto an excluded one now leaves it included (same OR rule as merge).
3. **Index stores** — embedding, phash and quality stores are `createIndexStore` instances with `ensureHydrated`.
4. **Workers** — `createWorkerClient` (lazy pool, round-robin, idle/timeout, crash rejects all pending) for relative-sort, border-scan (recycles every 80), quality, compress, kit-margins and phash. CLIP worker returns normalized `Float32Array`s (persisted format unchanged) with chunked prefetch. Stage-1 dHash progress throttled to 100 ms.
5. **QA** — archive/unarchive and favourite from the viewer and in bulk; unarchive several in Manage → Archived; tag edits in viewer and bulk, then wait for the flush (grid should stay smooth); compress, crop, rotate and video edit a favourited file (stays favourited); trash and prune duplicates; cold reload (tag types, registered tags, albums match cloud); Manage → Settings CLIP scan start/pause/abort/resume and logout mid-scan; similar/phash scan, quality scan, auto-crop border scan of >80 thumbs and cancel; compression; relative sort and kit-nearness counts; tag filter include/exclude and rename a tag used in an active filter.

**Previous session (committed locally, `0.3.197`): simplification plan Phase 2 part 2**
1. **Outbox runner** — `lib/tag-outbox-runner.ts` → `lib/outbox-runner.ts` (`startOutboxRunner`); the store-wired context moved out of `use-library-bootstrap` into `lib/library-outbox-context.ts` (by-id lookups, one trash-id set per chunk). Favourite and visibility drains run in parallel; derived-replace stays after them because it remaps their file ids.
2. **Tag rewrites** — `lib/tag-batch.ts` deleted; `queueTagMutation(files, mutator, { wait })` in tag-outbox; library-store rename/delete/merge share one `rewriteTags` path (query-album rewrite order unchanged). Tag and visibility overlays share `overlayFiles` (private metadata spread unchanged).
3. **§4 findings** — favourite derive builds the hash map once; `authFetch` has one 401 path; one shard write transaction and parallel shard decrypt; pull-files batches phash invalidation, loads trash ids once per pull and saves cursors in parallel; view sessions keep only `views` in memory (cloud payload still writes the aggregates); one `normalizeTagNameList`; site wipe steps in parallel.
4. **QA** — rename, merge and delete a tag in Manage → Tags (gallery, query albums and tag counts update; works offline then syncs); favourite + archive several files quickly, then reload; Recents shows view counts and last-viewed thumbnails; cold start with a large library (shard decrypt); pull after editing files in the official app (changed thumbnails refresh, near-duplicate state recomputed); logout → login.

**Previous session (committed locally, `0.3.196`): simplification plan Phase 2 part 1**
1. **Outboxes** — `lib/outbox.ts` `createOutbox` (hydrate dedupe, coalesced persist, ack-if-unchanged by entry identity, remap) backs the tag, favourite, visibility and derived-replace outboxes; `favorite-membership` uses its `createCoalescedWriter`. `lib/session-lifecycle.ts` owns the single pagehide/visibilitychange flush and the logout reset registry (`registerFlush`/`registerReset`); per-module listeners and `resetDependentStores` are gone. `lib/debounced-persist.ts` replaces three store-local debouncers. Logout now also resets sort/nearness/shuffle ordering and view sessions.
2. **HTTP** — core throws ente-base `HTTPError`; one `retryWithBackoff` (honours `Retry-After`) for downloads, uploads and tag writes. Tag writes are two layers: transport retry (429/5xx/network) and `retryOnConflict` (409). The verify-refetch double PUT is gone (D3). `core/metadata.ts` no longer imports `@/lib`; `putMetadata` + `encryptPubMagic` share the merge/version path.
3. **Blob store** — `db/blob-store.ts` `createLruBlobStore` backs thumbnails and file ciphertexts (cached byte total, cursor-only eviction, internal touch coalescing). Thumbnails are stored as ArrayBuffer; dbVersion 10 clears the thumbnail cache.
4. **Tags** — `lib/tag-filter.ts` split out of `tags.ts`; one `SCOPES` table drives describe/reserved/active/scope filtering; evaluation takes a `ctx`; Album editor counts in one pass; query-album serialize/hydrate use spreads (persisted JSON unchanged, round-trip tested).
5. **QA** — first open re-downloads thumbnails (dbVersion 10); tag add/remove/rename on several files, including offline then online; favourite and archive toggles survive an immediate tab close; logout → login resets gallery sort; album editor scope counts; download of a full-size photo on flaky network.

**Previous session (committed `f41698ef32`, `0.3.195`): simplification plan Phases 0–1**
1. **Deleted** — ~45 research/GA/debug/probe scripts and one-shot smokes; eval modules, the dHash kit-nearness path, corpus export and the tile pilot (+ Manage Developer card); dead store actions, exports and worker messages listed in the plan; `/tags` and `/favourites` redirect pages; `@ffmpeg/util`, `vaul`, `m0-spike`.
2. **DB v9** — drops the tile-embeddings store, legacy kv `"files"`, shards meta, and clears thumbnails + file ciphertexts (LRU fields / file header now required). Outboxes untouched; the `bytesBase64` derived-replace shim stays until a drained build is confirmed (D4).
3. **Shared helpers** — `lib/format.ts` (`plural`, `formatFileSize`, `errorMessage`), `components/ConfirmDialog.tsx` (replaces 5 modals + 5 inline dialogs), `db/kv.ts` `loadKv`/`saveKv` keyed by `KvValues` (wrappers gone; chunk decrypts in parallel), `lib/image-format.ts`, `lib/embedding-vector.ts`, `src/test-utils/fixtures.ts`, `scripts/e2e/lib.ts` + one `e2e-smoke.ts` suite; ente-utils `batch`/`wait`/`mergeUint8Arrays` replace local copies.
4. **Docs** — research record trimmed to `mobileapp/docs/research/`; root audits archived to `mobileapp/docs/archive/`; test-account credentials now read from `.env.local` (password still needs rotating).
5. **Known limits** — kit centroid now rounds to 1e-5 (shared normaliser); `withTimeout` and `arrayBufferFromUint8Array` kept (ente-utils semantics differ); `appendPhashChunk` still re-reads meta per append; `packStage1Embeddings` kept (not equivalent).

**Previous session (local only, `0.3.193`):**
1. **Derived-replace payloads** — lock/logout no longer wipes the encrypted payload store, so queued edits survive a lock (panic still wipes); a missing payload is logged before the entry is dropped.
2. **Trash** — `emptyTrash` syncs first and uses the server's trash cursor (max with persisted) instead of the client clock; refuses with "Trash is not synced yet" when items exist but no cursor does.
3. **In-place replace** — `updateImageBytesInPlace` spreads the source file's private metadata, so unknown keys survive.
4. **Sync** — pull checkpoints per batch (files saved, then cursors committed; Favourites cursor held until membership commit). A tombstone in one collection re-points the row to a copy in another known collection instead of deleting it.
5. **Tags** — rename/delete/merge rewrite saved query albums (`lib/album-tag-rewrite.ts`); emptied child groups are dropped from filter trees and an empty non-root group matches nothing instead of everything.
6. **Thumbnails** — load tokens stop stale loads writing state; failed loads retry up to 3 times (on remount after 10s and on `online`); invalidate resets failures.
7. **Compress worker** — a 45s timeout terminates the worker and rejects all pending requests (no cascade of 45s waits); crop rethrows it instead of falling back to the main thread.
8. **Compute jobs** — tile-embedding coverage counts only the current model/layout; image-quality worker errors reject pending scores; tile job has a controller (stop → "paused"); WebCodecs transcode honours the abort signal (ffmpeg fallback still not abortable).
9. **Network** — upload retries 7 attempts (1/2/4/8s backoff, ~31s); full-file download retries 429/5xx/network errors 3 times, abort-aware.
10. **Rotate** — in-place rotate drops the file's phash entry and index row so near-duplicate state is recomputed.
11. **UI** — masonry order key includes pixel dimensions; viewer: pointercancel handling, synthesized-dblclick dedupe, tracked nav timer, `initialIndex` applied only on change, revert path revokes URLs after await; crop/video editors reload on file id change and guard against unmount/replace races.
12. **Known limits** — `Retry-After` not honoured; tile coverage walks all records (~30KB each) per call; tombstone mitigation only covers memberships already loaded (a file in A and B where B has no new diff is still dropped by A's tombstone); query-album tag merge can leave duplicate clauses; rotate clears only the phash cache (quality/CLIP/kit-tile caches stay); viewer zoom `onPointerCancel` still maps to pointer-up.
13. **Deferred (by decision)** — tag-delta outbox redesign, near-dup bucketing, per-collection membership redesign, double-rotate hardening, ffmpeg abort.

**Previous session (local only, `0.3.192`):**
1. **Outbox ack races** — favourite/visibility drains remove an entry only if it is unchanged since the save (`removeFavoriteOutboxEntriesIfUnchanged`, `removeVisibilityOutboxEntryIfUnchanged`); derived-replace entries carry a strictly increasing `enqueuedAt` token and are removed only if still current. Persist chains no longer wedge after one failed write.
2. **Derived-replace queue** — the latest enqueue owns completion; a failed later save no longer resolves its waiters with the earlier upload (they reject, `onFailed` re-keys the entry and override to the upload that replaced the source). `moveFilesToTrash` clears derived-replace entries; `retryDerivedReplace` drops entries whose bytes are gone or whose file is trashed.
3. **409 retry** — `updatePublicMetadata` refetches the remote public metadata and re-merges on version conflict (up to 4 attempts), which also covers the in-place upload path.
4. **Job status** — compress and phash jobs capture their own controller; Stop/Resume/unmount no longer let a stale run set status or progress; pause mid-file aborts compression between stages (`signal` plumbed through `compressAndUploadMedia`); a file interrupted by pause is not recorded as a failure.
5. **Selection** — trash/archive/filtered selections prune ids that left the library (derived, no effect).
6. **Hygiene** — `urlForLog` strips query strings (presigned URL/token leak), upload-URL fetch retries on 5xx/network errors, ffmpeg load failure is no longer cached, portrait video scale filter uses a square long-edge fit with even sides, XHR upload/download abort is honoured.
7. **Deferred (by decision)** — wrap key in localStorage design change; duplicate-on-lost-finalize, trash-before-commit orphans, drain early return, hydrate races, stale grid metadata after tag touch, ffmpeg.exec timeout, large main-thread copies, dead crypto worker, probe `<video>` disposal, GIF width/height.
8. **Known limits** — a late enqueue keyed to the original id after the first replace completed still gets "File not found"; the active drain reuses the first enqueue's `save` closure; a missing but not-trashed file stays queued as a no-op.

**Previous session (local only, `0.3.191`):**
1. **Location kept on derived uploads** — crop/rotate/compress copies and in-place rotate/crop now carry `latitude`/`longitude` (`upload-image.ts`, `upload-compressed-media.ts`); they were dropped before.
2. **Favourite batch revert** — `batchSetFavorite` reverts the optimistic UI if the outbox write fails.
3. **Upload commit** — buffered uploads are de-duplicated against files a sync already pulled, and `reset()` clears the commit timer and buffer.
4. **Sort tiebreak** — equal sort times fall back to newest id so order is stable across syncs.
5. **Thumbnail cache** — `clearThumbnailCache` no longer zeroes `inFlight` (started loads still finish).
6. **Video thumbnails after compress** — the canvas poster-frame path waits for a decoded frame (`preload=auto`, `loadeddata`) and rejects an all-black frame so the ffmpeg fallback runs.
7. **"Manual rotate" filter** — `rotatedScope` mirrors `croppedScope` end to end (store, presets, saved queries, dropdown); matches the `rotated` system tag, which only the rotate tool stamps (a crop made while rotated is not tagged). No count badges on its radios.
8. **Not done** — outbox ack race, derived-replace queue, persist chains, pause/resume "done" status bugs, 409 retry for the in-place metadata write after upload.

**Previous session (local only, `0.3.190`):**
1. **`uploadedAt` is stamped on first write** — `putPublicMetadata` and `prepareFilesTagMetadata` (`core/metadata.ts`) freeze `uploadedAt` from `fileUploadSortTime` when a file has none, so official-app uploads stop drifting with `updationTime` once touched here.
2. **Derived uploads carry history** — crop/compress/rotate-as-new keep the source's `uploadedAt`, `editedTime` and `editedName`; in-place rotate re-stamps `uploadedAt` too. Fresh uploads use `modificationTime = creationTime` (was upload-now).
3. **"Updated At" sort → "Uploaded At"** — `lib/uploaded-at-sort.ts` sorts by `fileUploadSortTime`; store/filter-bar/dropdown/pipeline identifiers renamed to `uploadedAt…`.
4. **Known limits** — legacy files freeze at their first-write `updationTime` (true original upload time is not recoverable); `editedAt` on derived copies is still reset; if the official app replaces rather than merges `pubMagicMetadata`, custom keys are lost (outside this repo).

**Previous session (local only, `0.3.189`):**
1. **Bulk Apply concurrency** — `RotateToolFooter` runs 3 rotations at a time, `CropToolFooter` 2 crops at a time (each still waits for its own upload, bounding memory). Both were strictly one file at a time end to end.
2. **`mapBatched` is a sliding pool** — each runner picks the next item as soon as it finishes, instead of lock-step slices waiting on the slowest item. All existing callers catch inside `op`.
3. **No second download for crop undo** — `cropAndReplaceFileOptimistic` takes `options.sourceBytes`; quick crop and auto-crop pass the bytes they already decrypted, so finalize no longer re-downloads the original just to record edit history.
4. **Deferred** — quick crop still decodes once on the main thread only to read dimensions (worker could take a normalized rect); crop encode is mozjpeg WASM in the single shared compress worker (native `convertToBlob` JPEG would be faster but larger files); rotate uses main-thread canvas + main-thread upload crypto and a separate `updatePublicMetadata` round trip; crop replace trashes one file per API call.

**Previous session (committed `5ad6ca0e94`, `0.3.188`):**
1. **Thumbnail cache** — session budget 96 MB; Map insertion order is the LRU (no sort on evict); newest requests decode first (LIFO); decrypt and show before the IDB write; LRU touches written in one transaction.
2. **Viewer** — downloads abort when a slide leaves the window (fetch `signal` through `core`); only ±1 videos preload; video elements release `src` on unmount; progress re-renders only for the active slide; no extra byte copies when building Blobs.
3. **Workers** — compress/crop share one worker; compress, relative sort and kit nearness workers terminate when idle (`worker-idle-timer.ts`; CLIP stays resident by choice); WebCodecs H.264 loaded on demand.
4. **Bundle** — SRP login and image/video upload modules are dynamic imports (out of `_app`); one `zod` copy; `.wasm`/`.mjs` dropped from the precache (runtime-cached on first use, so offline needs one online use within 24 h).
5. **Tag index / library** — upload, replace, prune, trash and restore update the tag index incrementally (copy-on-write buckets, debounced persist) instead of rebuilding; slot-only commits skip the rebuild; `patchFilesInLibrary` uses `fileIndexById`; `batchSetArchived` is one commit; bootstrap hydrates in one `Promise.all`.
6. **Sync** — a no-op sync (no pulled changes, empty outboxes) skips the library recompute and full save; `pullFiles` groups files by collection once; post-sync CLIP merge no longer force-hydrates the embedding index (merges only when already hydrated — the pull is in IDB either way).
7. **Pages** — albums compute counts/covers once and only in list mode; Manage dedup shows 50 groups at a time ("Show more"); Similar-only counts skip in Exact mode; tag rows memoized; upload staging grid decodes ≤320 px previews two at a time.
8. **Deferred** — crypto decrypt on a worker (crypto is main-thread via `crypto-shim`; worker path needs iOS testing); thumbnail IDB schema (raw bytes + separate LRU metadata store); rAF gestures via refs; editor overlays double-decrypt; masonry scroll quantize; `public/icons/icon-512.png` is 1536×1024 (1.35 MB in precache, declared 512×512) — needs a properly sized asset.

**Previous session (committed `32db8e4492`):**
1. **MD5 (`md5.ts`)** — incremental, word-at-a-time MD5 (~4 ms/MB vs ~29 ms/MB desktop); was the main "1 s per second of video" wait before upload started.
2. **Streaming encrypt (`encrypt-upload-file.ts`)** — one pass over 4 MB slices of the picked `File`: Blake2b hash, secretstream encrypt, ciphertext MD5; ciphertext kept as a Blob of per-chunk Blobs. Videos are no longer read whole (`prepareLocalVideo` returns the `File`; probe uses `preload="metadata"`), so peak memory is ~one chunk instead of ~4× the file.
3. **Upload path** — image/video uploads use the slot's crypto (`getUploadCryptoWorker`, workers off iOS, main thread on iOS with a yield per chunk); file and thumbnail PUTs in parallel; PUT timeout scales with size (`putFileTimeoutMs`).
4. **Library commits** — finished uploads within 500 ms share one `allFiles` commit + tag rebuild, and the encrypted cache write uses the normal debounce (was a full-library rebuild + persist per file).
5. **Gallery memory** — `decryptFileCiphertext` no longer copies ciphertext element-by-element (`Uint8Array.from`).
6. **Deferred** — upload staging grid shows full-res `<img>` previews (lazy) — heavy on iOS for big batches; could use small decoded previews.

**Previous session (committed `9c6df6a747`):**
1. **Kit nearness (A1/A6/B11/B12/B13)** — ranking ids as `Float64Array`; files with no kit evidence stay unassigned; presence job only runs while the UI needs it; scores computed once per sort; seeds come from tag posting lists.
2. **Similar keeper (A4/A5)** — keeper choice keyed by sorted fileIds (stable across re-runs) and ranked consistently across exact/similar/prune.
3. **Stage-1 (A2/B8)** — CLIP mode also unions tight dHash pairs (≤2); symmetric j>i top-K scan over packed, transferred `Float32Array` with raw-dot reject; result cache key fingerprints vectors (not just count).
4. **Hashing (A3/B10)** — one `getImageData`, box-averaged grids, 8 rotation/mirror variants by permutation (fixes clipped rotations); one `onmessage` per worker with Map dispatch; in-flight cap ~2× workers; thumbnail bytes transferred.
5. **Phash persistence (B9)** — chunked encrypted `phashChunks` store (dbVersion 8, meta v4) — appends + tombstones, prune of deleted ids, compaction; old index reads as absent → one rescan.
6. **CLIP sync (A7)** — cursor, backoff, batched `markUploaded`.
7. **Scan stalls (`0.3.181`)** — thumbnail cache eviction now frees down to 320 MB (was: just enough for one row), and puts queued behind an eviction skip the rescan; before, every fetched thumbnail past the 400 MB budget re-read the whole store, so bulk scans crawled after a few thousand files. A phash pool worker error now rejects pending hashes instead of holding in-flight slots forever.
8. **Deferred** — persisted incremental CLIP top-K (B8 follow-up); Batch C (14–17) and item 14 pending discussion.

**Previous session (committed `5cbf953cd4`):**
1. **Security** — dev test credentials only load under `NODE_ENV=development` (absent from `out/`); pending crops/edits and derived-replace payloads encrypted at rest (old plaintext entries dropped on read); SW no longer caches cross-origin responses; 2FA/SRP/http error handling; wrong 2FA code shows an error instead of logging out.
2. **Reliability** — serialised shard saves; panic/wipe closes DB first; uploads made during sync kept; logout/lock await durable flush (organizer upload capped at 5 s); CLIP job/worker no longer hang on batch failure or worker crash; relative sort runs in the worker (no gallery freeze).
3. **Viewer** — bounded load retries, stall (not total) timeout, no download leaks after unmount, preloads don't seek the active video, undecodable media shows an error, Escape safe in crop mode, >120 MB videos not kept in session cache, native non-passive wheel (trackpad pinch no longer zooms the page), zoom-out resets pan.
4. **Selection / perf** — mobile highlight-scroll (marquee) fixed; stable Manage grid selection; Set lookups in bulk favourite/archive/trash/delete-forever; thumbnail eviction skips the sort under budget; bulk tag undo is one commit (`setTagsOnFiles`).
5. **Tag consistency** — kits, pinned tags and album-view filter follow tag rename/delete/merge.
6. **Deferred** — M5 poison outbox; UploadPanel remount/concurrency; `_app` bundle split; worker decrypt; rAF gestures; undo delta model; Manage virtualization; upload previews use full-res; binary embedding packing; `video.src` release; ±1 preload window; `kv.ts` cursor chunks; `organizer-clip-sync` H5/H6/H7/M14; ffmpeg timeout.

**Previous session (local only — not pushed):**
1. **Agentic upload test** — login OK; upload failed with `HTTP 410` on `GET /files/upload-urls` (`"This upload API is no longer supported"`). Storage was fine (~61MB/10GB).
2. **`0.3.178`** — mint per-object URLs via `POST /files/upload-url` + MD5; PUT sends `Content-MD5`. Dropped legacy URL pool prefetch. Smoke script: `scripts/e2e-smoke.ts`.

**Previous session (local only — not pushed):**
1. **`0.3.177`** — disable CF `uploader.ente.com` proxy (direct S3 PUT again); drop dedicated crypto workers from the upload path; sequential URL take/PUT; Cancel aborts in-flight fetches. Keeps HEIC/timeouts/concurrency 4 / parallel encrypt.
2. Prior `0.3.176` iOS worker-skip was insufficient — CF proxy and/or remaining worker path still hung; cancel never aborted PUTs.

**Previous session shipped:**
1. **`0.3.174` upload stall** — HEIC/video hang timeouts; URL-pool refill mutex; off-critical-path library persist; concurrency 4.
2. **`0.3.175` upload speed** — production PUTs via `uploader.ente.com` (official CF proxy); 4 dedicated crypto workers; parallel hash∥thumbnail, encrypt, file∥thumbnail PUT; JPEG SOF dimensions.

**Previous session shipped:**
1. **`0.3.173` UX batch** — stamp tap-only; idle-lock await + `useRequireSession`; zoom chrome tap while zoomed; tool footers safe-area; toaster island offset; wheel zoom; video zoom; AppShell `visualViewport` height; select perf via store-observed cells; crop lock aspect session pref; view-session resume **30m**. Notes in `mobileapp/docs/archive/ux-bugs-investigation.md`.

**Previous session shipped:**
1. **Investigation only** — nine reported UX issues documented in [`mobileapp/docs/archive/ux-bugs-investigation.md`](mobileapp/docs/archive/ux-bugs-investigation.md).
2. Prior: **`0.3.172` production audit** — LWW-merge `viewSessions`; logout flush; 401; favourite membership validate.

**Previous session shipped:**
1. **`0.3.169`** — marquee edge / programmatic `setScrollTop` calls `noteGalleryScrollActivity()` so thumbnail cache throttles like a real fling (amplifier called out by memory investigation).
2. **`0.3.168` memory** — thumbnail / file-ciphertext IDB eviction no longer materializes every ciphertext via `getAll()` (cursor + LRU meta only). Dev-login stress: 2500 synthetic thumbs, heap stayed ~441MB / 12% limit.
3. **`0.3.168` Media tab** — optimistic bottom-nav highlight; gallery shell paints first with “Preparing media…” (+ count); heavy pipeline deferred. Fixed albums list passing a fresh `[]` into the display pipeline (infinite update loop on Media nav).
4. **Favourites audit** — membership oracle + `mergeFavoritesCollectionIntoLibrary` + tests still coherent; logout clears membership; durable flush includes membership persist.

**Previous session shipped:**
1. **`0.3.167`** — favourites reliability: durable encrypted membership set (server Favourites collection file IDs) as oracle; pull applies Favourites diffs without stealing `collectionID` / deleting library rows; patch membership after favourite API success; first-run full Favourites re-pull. UI unchanged.

**Previous session shipped:**
1. **`0.3.166`** — select marquee retract deselects: keeps pre-drag baseline and live-syncs to baseline ∪ current box (`onSetSelection` / `selectMany(..., "set")`). Stamp stays add-only.

**Previous session shipped:**
1. **`0.3.165`** — organizer-config: refetch-before-write (museum never 409s collection magic) + optional 409 retry; Recents cloud via `_organizer_app_v1.viewSessions` (cap 50 / 100 views, LWW + tombstones); parse preserves consecutive `endTime`; save-queue no tight-loop, awaitable flush before hydrate.

**Previous session shipped:**
1. **`0.3.164`** — iOS-style select drag: any-direction marquee, content-space hit testing (fixes fit false positives), live selection while dragging, edge auto-scroll grows selection. Shared `marquee-selection` + `useMarqueeSelection` in ThumbnailGrid / LocalUploadGrid.

**Previous session:**
1. **Review only (no code)** — image sharding, CLIP `mldata` sync, organizer “session” config: not fully production-hardened. View-sessions still local.

**Previous session shipped:**
1. **`0.3.163`** — tags with Effects presence off stay in the query when changing Tag presence (untagged only drops presence-counting clauses); adding those tags no longer clears tagged/untagged scope.

**Previous session shipped:**
1. **`0.3.162`** — remove full-library JSON.stringify dirty scan on tag save; explicit dirty file-id marks + cheap updationTime. (0.3.159 fingerprint was the freeze.)
2. Prior IDE-only Java LS settings in `.vscode/settings.json`.

**Previous session shipped:**
1. **`0.3.156` durability + tools** — durable flush, 401→logout, favourite local patch, IO hard-pause, tools chrome.

**Previous:**
1. Tools chrome UX landed ahead of version bump; owner decisions; audits; `0.3.155` perf pass.

**Previous session shipped:**
1. **Deep backend audit (no code)** — canvas `deep-backend-reliability-audit.canvas.tsx`.
2. **Favourite outbox durability** — batches of 100. `APP_VERSION` → `0.3.154`.

**Previous session shipped:**
1. **Quick rotate in-place** — `PUT /files/update` same file id + key; merge pub magic (dims + `rotated` tag); no trash/remap. `APP_VERSION` → `0.3.153`.
2. Earlier: replace-instead-of-append (0.3.152) — superseded by in-place.

**Previous session shipped:**
1. **AGENTS.md audit of unpushed batch** — view-sessions close uses `ViewOpenKind` (not boolean); JSDoc/`[Note:]` on remap + quality hydrate; commit + push + Deploy CI. `APP_VERSION` → `0.3.151`.

**Previous session shipped:**
1. **Image quality: content over megapixels** — thumb sharpness/grain/pixelation first; native resolution only soft ×[0.62–1.0] so crisp smaller files outrank soft large ones. Index **v3**. `APP_VERSION` → `0.3.150`.
2. **PhotoViewer size chip** — chrome overlay shows `Image: W×H` (from pub magic metadata) and `Viewport: W×H` (live device). `APP_VERSION` → `0.3.149`.

**Previous session shipped:**
1. **Image quality score retune** — ranking is now `resolution × sharpness` (product) so soft/low-res cannot float into Best; mild grain/pixelation/crush only. Index **v2** invalidates prior scores (rescan required). `APP_VERSION` → `0.3.148`.
2. **Relative sort Int32 fix** — worker used `Int32Array` for file ids; Ente ids above 2³¹−1 truncated so returned order never matched gallery files (identity passthrough). Switched to `Float64Array`, apply snake sync on main thread (no `startTransition`), worker only for ≥400. `APP_VERSION` → `0.3.147`.
3. **Relative sort hydrate/toast/Set Relative close** (0.3.146) — bootstrap hydrate gate, rebuild on embedding count, insufficient-embedding toast, Set Relative closes viewer.

**Previous session shipped:**
1. **Image quality sort** — Manage → Settings thumbnail scan persists per-file 0–1 quality scores (resolution + sharpness/grain/pixelation/bpp from thumbs). Options → Sort → Image quality (Worst / Best); unscanned last. Encrypted `qualityIndex` KV + worker job. `APP_VERSION` → `0.3.145`.

**Previous session shipped:**
1. **Configurable viewport size** — session-only W×H in Options → Viewport fit (defaults to device; Use device reset). Fit sort + crop/video seed use target aspect. PhotoViewer chrome shows live device W×H chip. `APP_VERSION` → `0.3.144`.

**Previous session shipped:**
1. **Responsive Tools chrome** — below `md` keep Gallery Tools wrench dropdown; at `md+` show individual Query / Select / Stamp / Rotate icon buttons (albums: Select / Stamp / Rotate). Restored `TagQueryBuilderPanel` for wide layout. `APP_VERSION` → `0.3.143`.

**Previous session shipped:**
1. **Recently viewed sessions** — Recents tab (Albums→Recents→Manage); encrypted local `viewSessions` store; PhotoViewer records >1s full views (gallery/album); 1h resume; session list + view-only chronological detail with deleted placeholders + duplicate carousel slots (`initialIndex` + `readOnly`). Crop/replace remaps file ids. Delete session from session view header. Unit tests + Playwright `scripts/e2e-smoke.ts` green. `APP_VERSION` → `0.3.142`.

**Previous session shipped:**
1. **Quick rotate + Tools menu** — Gallery Tools dropdown (Query builder / Select / Stamp / Rotate); draft +90° CW taps with CSS preview; Apply uploads sequentially via `rotateAndUploadFile` (now goes through `toRenderableImageBlob` so HEIC works in Chromium); Discard / 4th tap clears. Albums get Tools without query. Playwright e2e green on `/dev-login`. `APP_VERSION` → `0.3.140`.

**Previous session shipped:**
1. **Feasibility only (nothing shipped)** — Quick rotate from gallery is high-confidence: stamp-mode UX pattern + `rotateAndUploadFile` / `rotateImageBytes` / `uploadRotatedImage` already exist. Open product choice: tap-to-rotate mode vs select-then-rotate; derived copy (not in-place) matches crop editor today.

**Previous session shipped:**
1. **Query builder UX** — Add-tag submenu scrolls with wheel anywhere over the list (`stopPropagation` + flex scroll); type tabs use native `overflow-x-auto`; picker work deferred until open and kit counts ranked once; first-class `TagFilterKitNode` (Has = all tags, Not = missing ≥1) so `(NOT kitA) OR (NOT kitB)` needs no manual grouping. Lint, targeted tests, build green. `APP_VERSION` → `0.3.139`.

**Previous session shipped:**
1. **Compress video speed** — skip slow `decodeAudioData` AAC fallback; remux prefers `-c:a copy` (original audio onto hardware video), AAC only if copy fails; WebCodecs `latencyMode: "realtime"`. `APP_VERSION` → `0.3.138`.

**Previous session shipped:**
1. **Fast optimistic favourites** — `APP_VERSION` → `0.3.137`.

**Previous session shipped:**
1. **Options Filter UX** — same collapsible pattern as Sort: Clear at the top (resets all scopes to All); Tag presence / Favourites / Manual crop / Media type collapse behind title+chevron and auto-expand when that scope isn’t All. Shared `OptionsSection` helper. `APP_VERSION` → `0.3.136`.

**Previous session shipped:**
1. **Kit presence never orphans** — every shown file is assigned to the closest remaining kit by mean tag presence (known=1, else CLIP p). No AND gate. Ties: more tags, then id. Counts always partition the view. Lint, 394 tests, build green. `APP_VERSION` → `0.3.135`.

**Previous session shipped:**
1. **Compress follow-up** — WebCodecs keeps hardware H.264 when AAC fails (audio remux or skip); batch video long-edge cap 1920; independent gallery-style filters on Manage → Compress (always size-desc); per-stage progress (download/compress/upload with XHR PUT %); CRF slider removed; selection footer shows photo/video counts + size; size chips on compress thumbs only. Lint + build green; Playwright smoke OK. `APP_VERSION` → `0.3.134`. Plan: `mobileapp/scripts/compress-followup.md` (removed; see commit `81946e8e48`).
2. **Kit presence = best fit among remaining** — `APP_VERSION` → `0.3.133`.
1. **Why toggling barely moved other counts** — independent ONLY + shared sibling tags; most big-kit excludes changed zero other counts on the corpus.

**Previous session shipped:**
1. **Kit toggle recounts remaining kits** — counts are derived with `useMemo` from the exclude set (toggle no longer waits on the worker). Extra tags only veto a parent when a remaining *child* kit still uses them; the 0.4 CLIP threshold on unrelated remaining tags no longer blocks fallthrough. Unchecked kits stay 0. Lint, 391 tests, build green. `APP_VERSION` → `0.3.132`.

**Previous session shipped:**
1. **Excluded kits omitted from ONLY counts** — `APP_VERSION` → `0.3.131`.
2. **Excluded kits skip presence counts** — zeros unchecked kits in the Choose kit list. `APP_VERSION` → `0.3.130`.
3. **Kit likeness dropdown ONLY** — `countKitPresence` now fits a file only when its known + predicted tags *equal* the kit (θ=0.4). Nested parents no longer count child photos. Gallery ranking unchanged (AND). `APP_VERSION` → `0.3.129`. Lint, 389 tests, build green.

**Previous session shipped:**
1. **Kit likeness include/exclude** — checkbox per kit in Options → Sort → Choose kit; unchecked kits sort to the bottom (muted) and are skipped as rivals when scoring gallery nearness (session-only `excludedKitLikenessIds`). Still selectable as the active kit. `APP_VERSION` → `0.3.128`.

**Previous session (research only, nothing shipped):**
1. **ONLY kit likeness retune** — drowning is AND-by-construction (59/59 nested parents outrank children). GA/grid for exact membership: λ=8 τ=0.06 h=1.5 t=4 + extra-tag penalty x=2; first-screen 49→55, exclusive AUC 68→77. Dropdown visual estimator: exact-set @0.4 doubles specific-kit top-5 recall (42%→83%). Not shipped — owner decision. Notes: `mobileapp/docs/research/kit-nearness-s2-research.md`; runner `scripts/kit-nearness-s2-only-tune.ts` (removed; see commit `81946e8e48`).
2. **Exact-tag kit likeness (AND genes)** — AND vs exact with shipped λ16 τ0.02 h1.5 t4. Exact seeds do not help AND ranking. Runner `scripts/kit-nearness-s2-exact-membership.ts` (removed; see commit `81946e8e48`).

**Previous session shipped:**
1. **No-tag ignores system tags** — tagged/untagged presence skips `SYSTEM_TAGS`; compress/crop incremental index updates no longer add them; hydrate scrubs dirty persisted buckets. `APP_VERSION` → `0.3.127`.

**Previous session shipped:**
1. **Options Sort UX** — merged Filter nearness + Kit likeness into one **Nearness** section (`Choose kit` / `Choose tags`); each Sort section is collapsible (title + chevron), auto-expanded while its sort is active (or while the nearness picker/editor is open). `APP_VERSION` → `0.3.126`.

**Previous session shipped:**
1. **Gallery filter/render speed pass 2** — fit layout is one pass with columns built during placement (visible cells look up the live file by index, so tag patches don’t clone the whole layout); thumbs no longer stamp LRU time on every React snapshot; session cache bytes are a running total; library list keeps identity when a revision bump didn’t change anything; Updated At reuses frozen order like the other sorts. Lint, 387 tests, build green. `APP_VERSION` → `0.3.125`.

**Previous session shipped:**
1. **Gallery filter/render speed** — tag tap no longer builds a Set of every library id (posting-list intersect + sequential AND); masonry no longer joins every file id on each scroll frame, and visible cells are found per-column instead of scanning the whole layout. Filter bar reuses the already-filtered file list, counts photo/video/crop in one pass, and debounces kit-presence packing. Grid updates are deferred so the chrome stays responsive. `APP_VERSION` → `0.3.124`.

**Previous session shipped:**
1. **Video compress via WebCodecs H.264** — `encodeH264WebCodecs` probes hardware `VideoEncoder` (avc1), draws frames with `requestVideoFrameCallback`, muxes with `mp4-muxer`, AAC when `AudioEncoder` + `MediaStreamTrackProcessor` exist. CRF 18–32 maps to bitrate. ffmpeg libx264 `ultrafast` remains the fallback. Preview still caps long edge at 1280. GIFs and the video editor are unchanged.
2. **PhotoHoard image compress** — pixel-stat classifier (`compress-classify.ts`) routes to avif-q60 / q70 / q80 / lossless-webp. Skip floor is the existing min-size menu, default **800 KB**, persisted as `mobileapp-compress-min-size`. Worker: transferable buffers, `createImageBitmap` decode, native AVIF/WebP when the browser can, else `@jsquash/avif` / `@jsquash/webp`, JPEG fallback. Crop stays JPEG. JPEG quality slider removed.
3. **Mime / titles / thumbs** — compressed stills upload as `.avif` / `.webp`; `generateImageThumbnail` takes source mime; viewer and Manage copy updated. Lint, 384 tests, build green. `APP_VERSION` → `0.3.123`.

**Previous session shipped:**
1. **Kit presence research** — `scripts/kit-presence-s2.ts` (removed; see commit `81946e8e48`) measures how well per-photo kit scores recover which kits are in a view, against the tag labels, on views that mimic the app (whole set, tag-filtered, kit-filtered, 60-photo id windows, random) over 5 dup-safe splits. Old winner-takes-all: 12.5pp MAE, Spearman 0.14, top kit right 32%, 1.8 kits ≥30% shown <10% per view. Soft partition (softmax over medoid distances) barely helps and misses more kits — any score summing to 1 over kits splits photos between nested kits. Independent per-kit prevalence from the shipped pass-5 per-tag detectors: 5.5pp MAE, ρ 0.84, top kit right 95%, 0.06 missed; hardened to a count, ghosts fall 0.74 → 0.15 per view. Written up in `mobileapp/docs/research/kit-nearness-s2-research.md` § "Kit presence".
2. **Kit likeness list = per-kit fit counts** — `tagPresenceProbabilities` (shipped balanced tag models with the class-balance shift `log(n₊/n₋)` removed) and `countKitPresence` (a file fits when the product of its tag probabilities ≥ 0.5; known tags count as 1, unembedded files fit only through known tags; counts independent per kit) in `kit-nearness-margins.ts`; `presence` request in the margins worker sharing the cached whitening + tag models; `countKitPresenceInWorker` job; `TagFilterBar` posts the shown files per view change, dropdown shows `Kit (count)` sorted by count then tag count. Removed `rankKitsByBestFitShareEmbedding` / `formatKitFitPercent`. 3 new unit tests; lint, 368 tests, build green. `APP_VERSION` → `0.3.122`.
3. **Incident, recovered** — a `git checkout -- src/lib/kit-nearness-sort.ts` during test triage reverted that file to the 2026-09-09 commit, dropping the uncommitted `0.3.119`/`0.3.120` edits (τ 0.02 / λ 16 constants and `kitEmbeddingRivalWeights`). Reconstructed from the compiled `.next` chunk of the `0.3.121` build plus this session's reads; verified the CLIP section matches the compiled module, tests and build green. The dHash section could not be cross-checked but had no known edits since the commit.

**Previous session shipped:**
1. **S2 kit nearness pass 6, batch 2 — research only, negative result** — owner scanned 5,882 tagged photos (all succeeded, ~135 ms/photo, 108,640 tile rows); `scripts/kit-nearness-s2-pass6.ts` (removed; see commit `81946e8e48`) slots tile-aware per-tag detectors into the shipped scorer under the pass-5 leakage-free protocol (global detector on tiles, MIL from zero / warm-started, naive instance labels, tile-mean and tile-max views alone and concatenated with the global vector, 4-corner-tile ablation, per-tag hybrid, additive dual terms). Pre-registered gates failed: the 11% "inconsistent" tag 86.8 → 88.2 AUC at best, the 62% "tiny" tag 91.6 → 92.2; MIL detectors are 2–7pp *below* the global ones and the global detector applied to crops collapses (distribution shift). Best tile-augmented scorer: +0.4–0.7pp hard AUC (CIs clear of zero on 4 confirmation seeds and the reserved test), first-screen never significant — at 13–18× scan cost and, for the significant variant, all tiles stored plus in-browser MIL. Verdict: do not ship. Also found: `floor(shortEdge/3)` in the tile layout adds a near-duplicate 4th column on most photos (18.5 tiles/photo vs ~14) — harmless for the result, noted for anyone reviving tiles. No `mobileapp/` source changes; no version bump.

**Previous session shipped:**
1. **S2 kit nearness pass 6, batch 1 — tile pilot** — diagnostic first: the residual pass-5 error is concentrated on two tags (`t_0005` detector 87%, `t_0004` 91%; the rest 94–97.5%), the owner confirms both are small in frame, and the S2 preprocessor centre-crops so edge items are never seen. Shipped a dev-only pilot: `kit-tile-layout.ts` (1/3-shortest-edge square grid covering the frame, 12–15 tiles per photo), `embed-tiles` in the CLIP worker (decode once, crop, one ORT batch, transferred `Float32Array`), encrypted per-file `tileEmbeddings` object store (DB v6), `kit-tile-embedding-job.ts` (resumable, tagged photos first, Stop/Resume/Clear in Manage → Developer), corpus export v4 with `tiles` offsets + float32 sidecar download. No ranking change; phone build unaffected. 5 new tests; lint, 366 tests, build green. `APP_VERSION` → `0.3.121`.

**Previous session shipped:**
1. **S2 kit nearness pass 5 in the app** — `kit-nearness-margins.ts` (packed-array whitening, per-tag logistic models, scorer), `kit-nearness-margins.worker.ts` (off-thread, per-session cache of whitening + tag models, terminated on logout), `kit-nearness-margins-job.ts` (training sample from embedded tagged stills capped at 3000, labels from the tag index, production score reused from `kitEmbeddingDistanceCompetitive`). Gallery shows the production order immediately and swaps in the learned order when the worker answers; falls back to production for no matched kit, exclusivity off, single-tag kits, thin samples (< 8 examples), or worker failure. Parity harness on the corpus: shipped code = research pick within noise (hard AUC 93.0 / 93.3 on confirmation / reserved; +5.0pp vs pass 4, CI clear of zero). 12 new unit tests; lint, 361 tests, build green. `APP_VERSION` → `0.3.120`.

**Previous session shipped:**
1. **S2 kit nearness pass 5 (research only)** — same leakage-free protocol as pass 4. Whitened (shrunk-LDA) hard-negative margin + class-balanced logistic regression per kit tag trained in whitened coordinates, min over tags. Saved-kit hard AUC 84.5 → 93.0 (pass 4: 88.0), first-screen 56.6 → 76.4; +4.9pp / +6.0pp over pass 4 with CIs clear of zero, 0 kits hurt; confirmed on reserved test (+4.5pp) and dup-threshold 2/10 stress runs. Ablations, dead ends, production recipe, measured costs and fallbacks written up. Runner `mobileapp/scripts/kit-nearness-s2-pass5.ts` (removed; see commit `81946e8e48`) (~2 min per run). Superseded pass-4 recommendation; pass-4 integration map still applies.

**Previous session shipped:**
1. **S2 pass-4 implementation handoff (docs only)** — exact formula, reproducible protocol, privacy constraints, dead ends, integration map, fallbacks, tuner implications, remaining research and definition of done. Pass-4 runner now preserves the handoff when regenerating results.

**Previous session shipped:**
1. **S2 kit nearness pass 4 (research only)** — leakage-free global/dHash-grouped splits; full-pool retrieval metrics; 223 scoring cells; fixed 8/8 negative + weakest-tag margins confirmed on a reserved train/validation/test split. Saved-kit hard AUC 84.4% → 88.3%; full first-screen 57.8% → 71.9%. Notes: `mobileapp/docs/research/kit-nearness-s2-research.md`.

**Previous session shipped:**
1. **S2 kit nearness default** — CLIP centroid, rival λ=16, τ=0.02; gene cap 24; holdout grid tuner (no GA); old per-kit tunes dropped (`tuneVersion: 2`). Research: `mobileapp/docs/research/kit-nearness-s2-research.md`. `APP_VERSION` → `0.3.119`.

**Previous session shipped:**
1. **S2 load order** — WASM fp32 first so a failed WebGPU `InferenceSession.create` cannot poison Transformers.js `wasmInitPromise` (the identical `156035816` on every backend). WebGPU fp32 is an upgrade after ORT is up. Skip q8. Guard embedding/phash hydrate until the cache key exists. `APP_VERSION` → `0.3.118`.

**Previous session shipped:**
1. **Sort panel global None** — removed per-section None radios; one top None clears all Options sorts (including nearness/kit). `APP_VERSION` → `0.3.115`.

**Previous session shipped:**
1. **Updated At in Options → Sort** — session sort (Newest/Oldest) mutually exclusive with other Options sorts; header ArrowDownUp is upload/edit only again. `APP_VERSION` → `0.3.114`.

**Previous session shipped:**
1. **Ignore archived in analysis** — CLIP/dHash scans, similar/exact dedup, compress, kit seeds/tune/suggestions, and corpus export skip archived (`isFileArchivedLocally`); tag index + Manage rename/merge/delete still include them. `APP_VERSION` → `0.3.113`.

**Previous session shipped:**
1. **Gallery filter/sort speed** — skip full library re-sort on tag patches; freeze viewport/size/fit order across tag edits; relative CLIP snake runs packed in a worker; precompute fit/size/viewport scores; reuse masonry layout when id order is unchanged. `APP_VERSION` → `0.3.112`.
2. **Favourite + trash durability review** — seed trash on crop/compress replace and dedup prune; remap outboxes on compress replace; drop pruned files from the live library immediately; re-exclude trash at sync commit; strip favourite unsynced on trash; rebuild library from live files after trash POST. `APP_VERSION` → `0.3.111`.
3. **Favourite + trash durability** — favourite outbox persist/hydrate/pagehide + overlay on sync; missing-file drain no longer acks; trash seeded before library drop and excluded from cache/sync/pull snapshots. `APP_VERSION` → `0.3.110`.

**Previous session shipped:**
1. **Tag outbox durability** — persist chain survives IDB failure; flush outbox on pagehide; merge ahead local tag writes on sync commit; viewer enqueues before rAF. `APP_VERSION` → `0.3.109`.

**Previous session shipped:**
1. **Tag apply robustness audit** (no code) — encrypted outbox retries failed PUTs; drafts, unsynced outbox persist, and in-flight `syncRemote` snapshots can still void a change.

**Previous session shipped:**
1. **Per-kit CLIP nearness tune** — depth-biased holdout GA (pop 36 × 70 gens × 2 restarts + polish); persist `nearnessTune` on TagPreset only when lift ≥2pp; gallery uses per-kit genome; Manage → Tags progress UI. `APP_VERSION` → `0.3.108`.

**Previous session shipped:**
1. **Updated At gallery sort** — third time-sort mode; newest of tag `updatedAt`, `editedAt`, and `updationTime`. Sort button cycles uploaded → edited → updated. `APP_VERSION` → `0.3.107`.

**Previous session shipped:**
1. **CLIP skip videos harden** — gallery nearness no longer medoids from video tag matches; `stripVideoEmbeddings` on hydrate/scan (same-ref when unchanged); corpus allowlist excludes videos; dHash kit claim skips videos. `APP_VERSION` → `0.3.106`.

**Previous session shipped:**
1. **Effects presence review** — clear `lastTagTouchFileIds` on toggle/hydrate; merge of only-excluded tags into a new name stays excluded; rename onto an existing tag no longer transfers exclusion. `APP_VERSION` → `0.3.105`.

**Previous session shipped:**
1. **Tag commit audit** — preserve system tags on viewer flush; incremental gallery patch only when filter basis unchanged; register/hydrate bump `tagIndexRevision`. `APP_VERSION` → `0.3.104`.
2. **Tag commit perf v3** — `fileIndexById` / `filesRevision`; incremental filter; leaner cache encrypt. (prior in session)

**Previous session shipped:**
1. Per-tag **Effects presence** toggle in Manage → Tags (default on). Off = ignored by tagged/untagged presence filter. Persisted sparsely with tag types. `APP_VERSION` → `0.3.102`.

**Previous session shipped:**
1. **Set Relative** — when Relative (closest/furthest) is on, the photo viewer top bar shows **Set Relative** to pin that image as the CLIP snake start (`relativeStartFileId`). New start clears the pin. `APP_VERSION` → `0.3.101`.

**Previous session shipped:**
1. **CLIP skips videos** — never embed/score/seed/export videos (poster ≠ content); drop stale video vectors on scan; nearness/relative/fit sorts append videos unscored. `APP_VERSION` → `0.3.100`.

**Previous session shipped:**
1. **Tag commit perf v2** — incremental tag-index update; defer `indexFromMaps`; in-place library patch; sheet close via rAF + `startTransition`. `APP_VERSION` → `0.3.99`.

**Previous session shipped:**
1. **Tag commit perf** — sparse `patchFile(s)InLibrary`; 1.5s debounce for encrypted files + tag-index persist. `APP_VERSION` → `0.3.98`.

**Previous session shipped:**
1. **Query builder scroll** — dropdown used `overflow-hidden`, which clipped long queries; now `overflow-y-auto`. `APP_VERSION` → `0.3.97`.

**Previous session shipped:**
1. **CLIP setting rename** — `clipEmbeddingBatchSize` (was concurrency); UI “ORT batch size” with Auto / 4 / 8 / 12 / 16 only. `APP_VERSION` → `0.3.96`.

**Previous session shipped:**
1. **CLIP pipeline depth** — dual in-flight ORT batches; max batch briefly 1–16. `APP_VERSION` → `0.3.95`.

**Previous session shipped:**
1. **CLIP micro-opts** — JPEG decode overlaps ORT; dropped separate cache-check pass; chunk meta via getAll; WASM `numThreads`; desktop Auto batch 4→6. `APP_VERSION` → `0.3.94`.

**Previous session shipped:**
1. **PhotoViewer tag lag** — sheet clicks only mutate local `stagedTags`; one `updateTagsOnFile` on close. `APP_VERSION` → `0.3.93`.

**Previous session shipped:**
1. **CLIP batch ORT** — worker `embed-batch` via `extractor([imgs])`; Scan batch size 1–8 = images per forward; pipeline next batch while GPU runs.
2. **Chunked write queue** — IDB `embeddingChunks` + meta v2; flush every 64 dirty vectors (O(batch) encrypt); legacy v1 monolith ignored → one rescan. `APP_VERSION` → `0.3.92`.

**Previous session shipped:**
1. **CLIP crawl fix v2** — no mid-scan index encrypt (only on end/pause); fix prefetch waiter deadlock; single worker message router; throttle progress UI. `APP_VERSION` → `0.3.91`.

**Previous session shipped:**
1. **CLIP scan stall fix** — mid-scan full-index encrypt was chaining every 48 embeds on the main thread (matches ~45–47 cliff + pause/resume reset). Coalesce to latest snapshot, checkpoint every 256, yield between encrypts. `APP_VERSION` → `0.3.90`.

**Previous session shipped:**
1. **CLIP concurrency setting** — Manage → Kit nearness: Auto (device 2/4 WebGPU, 1/2 WASM) or 1–8 override; persisted in organizer app settings. `APP_VERSION` → `0.3.88`.

**Previous session shipped:**
1. **CLIP concurrency restore** — multi-in-flight embeds again (WebGPU 2/4, WASM 1/2); worker no longer serializes; Settings shows `WebGPU×N`. Kept proven caps (higher = OOM risk, little GPU gain). `APP_VERSION` → `0.3.87`.

**Previous session shipped:**
1. **CLIP check** — confirmed 0.3.85 serializes embeds (1 in-flight); prior was WebGPU×4. Quant: hub has fp16/q8 only; q8 on WebGPU not a free win on v3.5.

**Previous session shipped:**
1. **Gallery width** — range 2–8 (was 2–6); Manage control is a ToggleGroup like Similar max group size. `APP_VERSION` → `0.3.86`.

**Previous session shipped:**
1. **CLIP scan perf** — dedicated `clip-embedding.worker` (WebGPU fp16 / WASM q8); main-thread cached/network thumb prefetch (ready queue 8); non-blocking index persist every 48; logout tears down worker. `APP_VERSION` → `0.3.85`.

**Previous session shipped:**
1. **CLIP scan perf review** (no code) — bottleneck map + recommended wins; see chat.

**Previous session shipped:**
1. AGENTS.md audit of staged nearness/relative/outbox/CLIP batch; minor doc/import tidy; committed + pushed `4867b46`; Deploy (NTPhotos) run 41 **success**.

**Previous session shipped:**
1. Stopped local preview on `:3080`.

**Previous session shipped:**
1. Rebuilt and restarted local preview on `:3080` (`APP_VERSION` `0.3.84`).

**Previous session shipped:**
1. **Kit likeness rival toggle** — Options → Kit likeness: Switch for rival kit penalties (default on); rebuilds frozen order. Filter nearness unchanged. `APP_VERSION` → `0.3.84`.

**Previous session shipped:**
1. Rebuilt and restarted local preview on `:3080` (`APP_VERSION` `0.3.83`).

**Previous session shipped:**
1. **Kit likeness % fix** — medoids from full library, claim share over visible gallery (was 0% when the view lacked kit seed photos). `APP_VERSION` → `0.3.83`.

**Previous session shipped:**
1. **Medoid review** — confirmed CLIP medoid paths for likeness + mistag; kept full-kit rival tags (0.3.80); deterministic seed embed sample (sort by id); stale “centroid” copy cleaned. `APP_VERSION` → `0.3.82`.

**Previous session shipped:**
1. **Kit likeness** — Options → Sort second entry: kits ranked by CLIP claim % on the visible gallery; select sets nearness filter to that kit (shared CLIP sort path) and arms stamp. `APP_VERSION` → `0.3.79`.
2. **Stamp nearness sync** — entering stamp with nearness active prefills kit/tags; stamp footer Done → Close; Cancel collapses Change kit without clearing stamp.
3. **Kit likeness rivals** — exact-kit nearness builds rival medoids from full kit tag sets (no allowlist strip), so competitive penalties stay on for Kit likeness. `0.3.80`.
4. **Nearness UI split** — `nearnessSource` kit vs filter; Sort shows **Filter nearness** or **Kit likeness** (not both); full kits in likeness picker; orphaned kit cleared. `0.3.81`.

**Previous session shipped:**
1. **CLIP medoids** — kit nearness and tag-filter fit use 2–3 densest CLIP medoids (min distance), not a mean centroid; rival kits use medoid sets; singleton outliers are not adopted as prototypes. `APP_VERSION` → `0.3.78`.

**Previous session shipped:**
1. Rebuilt and restarted local preview on `:3080` (`APP_VERSION` `0.3.77`).

**Previous session shipped:**
1. **Similar review** — always keep 1-NN (closest relative) edges; mutual top-K still links piles; slider narrowed to 8–16 (CLIP 0.08–0.16, default 12); fix CLIP gate when &lt;2 overlapping embeddings; top-K insert without full neighbour lists. `APP_VERSION` → `0.3.77`.
2. **CLIP-first Similar** (earlier) — Stage-1 CLIP nearest-neighbour path; dHash fallback. `0.3.76`.

**Previous session shipped:**
1. **Crop duplicate fix** — derived-replace queue coalesces onto the intermediate upload id; outbox drain skips in-flight replaces; `onCompleted` remaps outbox before waiters resolve. `APP_VERSION` → `0.3.75`.

**Previous session shipped:**
1. Rebuilt and restarted local preview on `:3080` (`APP_VERSION` `0.3.74`).

**Previous session shipped:**
1. **Outbox patch coalesce** — `patchFiles` batches verifies into one library walk; version-only tag updates mutate in place (no gallery refilter) and use one scheduled encrypt; outbox drain calls `patchFiles`. `APP_VERSION` → `0.3.74`.

**Previous session shipped:**
1. **Relative sort review** — verified closest/furthest with geometric path tests; freeze snake on enable/New start (like nearness) so tagging does not re-run O(n²). `APP_VERSION` → `0.3.73`.

**Previous session shipped:**
1. **Investigated** gallery lag after mass tag edits that drop files out of the active filter — main-thread optimistic `allFiles` map + tag-index update → gallery refilter/masonry reflow; then deferred full-library encrypt + N× `patchFile` encrypts on outbox verify.

**Previous session shipped:**
1. **Relative sort** — Options → Sort “Relative” Closest/Furthest: random CLIP start, greedy nearest/farthest-neighbor snake through the visible set (each file once); New start reseeds; mutually exclusive with other display sorts. `APP_VERSION` → `0.3.72`.

**Previous session shipped:**
1. Rebuilt and restarted local preview on `:3080` (`APP_VERSION` `0.3.71`).

**Previous session shipped:**
1. **AGENTS.md audit (staged)** — imports-first on `tag-filter-fit-sort`, void unused `applyOptimisticBatchTags` return, JSDoc brace fix in library-store. No version bump (compliance only).

**Previous session shipped:**
1. **Persist tag-filter fit sort across filter changes** — no longer clears when clauses drop to zero; latched mode reapplies when tags return; gallery only applies while clauses exist. `APP_VERSION` → `0.3.71`.

**Previous session shipped:**
1. **Nearness rival ranking** — competitive kit penalties when the nearness filter is exactly one kit (flat AND includes); plain centroid otherwise. `APP_VERSION` → `0.3.70`.
2. **Filter-based nearness** — Options → Sort “Nearness” + Choose filter… (tags/kits/query builder) as an independent seed `TagFilterSelection`; main gallery filter still hides; CLIP centroid reorder of the visible set; Reapply/Change/Off; no kit-only picker or stamp auto-arm. `APP_VERSION` → `0.3.69`.

**Previous session shipped:**
1. **Tag apply perf** — one batched `applyFilesTags`; outbox `enqueue`/`upsert` batch; defer full-library `saveEncryptedFiles`; selection bulk no longer awaits outbox flush (Manage rename/delete/merge still does). Hardened on review: serialized library persist (no stale encrypt clobber), copy Sets in index updates, single-flight outbox hydrate. `APP_VERSION` → `0.3.68`.

**Previous session shipped:**
1. **Investigated** selection/viewer tag-apply hitch — sync full-library map + N× tag-index updates + awaited outbox encrypt/flush before paint/ack.

**Previous session shipped:**
1. Rebuilt and restarted local preview on `:3080` (`APP_VERSION` `0.3.67`).

**Previous session shipped:**
1. **Selection session scope** — exit select mode after a successful tag commit (sheet Apply/close, footer chips, kits, copy tags); exit when the gallery tag filter changes; leave Media still clears on unmount. Sorting does not exit. `APP_VERSION` → `0.3.67`.

**Previous session shipped:**
1. **Tag filter fit** — gallery sort best/worst by CLIP distance to the active tag-filter set’s centroid (mistag hunting). Shown only when tag clauses are active; clears when tags cleared. Mutually exclusive with viewport/size/kit/shuffle. `APP_VERSION` → `0.3.66`.

**Previous session shipped:**
1. Rebuilt and restarted local preview on `:3080` (`APP_VERSION` `0.3.65`).

**Previous session shipped:**
1. **Reverted** kit nearness picker “all tags required” filter (back to strip partial kits).
2. **Kit suggestions** — `suggestTagKits` skips tag sets that include any tag without kit nearness enabled. `APP_VERSION` → `0.3.65`.

**Previous session shipped:**
1. **Kit nearness picker allowlist** — only list kits whose every tag has kit nearness enabled (no more stripping partial kits). `APP_VERSION` → `0.3.64`.

**Previous session shipped:**
1. **Bulk tag draft** — selection Tags sheet stages add/remove/kit taps locally; one batch write on **Apply** or sheet close. Footer chips disabled while sheet open; no-op toggles pruned; flush lock against double-write. `APP_VERSION` → `0.3.63`.

**Previous session shipped:**
1. **CLIP Similar hybrid** — Stage-1 keeps raw dHash edges; final cluster applies CLIP **gate** (drop mid-band hash edges far in embedding space) and **rescue** (keep CLIP-near pairs above Hamming threshold). Wired through worker + Manage (`CLIP n/m` coverage). Eval helpers + grid baseline script. `APP_VERSION` → `0.3.62`. Code only (no local preview restart).

**Previous session shipped:**
1. **Scroll-friendly thumbnails** — while scrolling: concurrency 3 (else 8), no low-priority queue, skip IDB lastAccess writes, cancel off-screen decrypt during flings, rAF-batch blob URL applies (2/frame scrolling, 4 idle). Fit masonry `setScrollTop` rAF-throttled. Dropped extra `Uint8Array.from` copy. `APP_VERSION` → `0.3.61`. Preview on `:3080` not restarted; `out/` rebuilt in place.


**Previous session shipped:**
1. Restarted local preview on `:3080` from the latest `out/` build (`APP_VERSION` `0.3.60`).

**Previous session shipped:**
1. **ONLY kit population** — gallery Kits picker badges and sort use exact user-tag-set counts when match mode is ONLY (AND/OR keep superset). `APP_VERSION` → `0.3.60`.

**Previous session shipped:**
1. **PC close X for tag/stamp sheets** — `useCoarsePointer`; TagPickerSheet shows Sheet close X on fine pointer and keeps drag-down dismiss on coarse. `APP_VERSION` → `0.3.59`.

**Previous session shipped:**
1. **Tag write robustness** — real `metadataList` batch PUTs (chunks of 100); single outbox writer (debounced flush + 60s retry); ack/remove outbox on verified write; failure toasts; tag-only writes no longer bump `editedAt`. Removed dual `tag-background-sync` / `tag-save-queue`. Follow-up harden: no version-0 PUTs, clone before mutate, drain try/catch. `APP_VERSION` → `0.3.58`.

**Previous session (investigation):**
1. Tag queue verdict: unreliable — one PUT/file, dual writers, outbox never acked, silent failures, editedAt gallery jumps.

**Previous session shipped:**
1. **Sync cursor / library atomicity** — `pullFiles` defers `saveCollectionSyncTime` until after `saveEncryptedFiles`. Single-flight `syncRemote`. `APP_VERSION` → `0.3.57`.

**Previous session (investigation):**
1. Partial library after sync — cursors advanced before encrypted snapshot; Force resync clears cursors.

**Previous session shipped:**
1. **Selection survives tag edits** — while select mode is on, gallery no longer prunes selection when files drop out of the active tag filter (so bulk remove/add keeps the same set). `APP_VERSION` → `0.3.56`.

**Previous session shipped:**
1. **CLIP ViT-B/16** — switch from `clip-vit-base-patch32` to `Xenova/clip-vit-base-patch16` (WebGPU `fp16`/`q4f16`, WASM `q8`). Model-id mismatch clears stored embeddings → full rescan. `APP_VERSION` → `0.3.55`.
2. **WebGPU dtype fix** — do not load CLIP with `q8` on WebGPU (silent WASM fallback). Surface skip reason via toast + console. `0.3.54`.

**Previous session shipped:**
1. **Cleanup for commit** — removed unused CLIP exports / stale comments; Manage CLIP copy clarifies explicit scan (no background library scan); stamp compact footer = Change kit / Done only; corpus export reuses store imports.
2. About to commit/push **0.3.53** CLIP kit nearness (centroid sort, explicit Manage scan, corpus v3, compact stamp).

**Previous session shipped:**
1. **Compact stamp on kit nearness** — when a kit is already armed, hide the full kit list; **Change kit** / **Done** only. `APP_VERSION` → `0.3.53`.
2. CLIP WebGPU+concurrency `0.3.52`; explicit CLIP scan `0.3.51`; CLIP gallery `0.3.50`.

**Previous session shipped:**
1. Kit nearness tag allowlist / LAN export / resync / picker fit / dHash hybrid bake (`0.3.44`–`0.3.48`).

**Previous session shipped:**
1. **Corpus v2 + derivedKits** — exact tag-set kits in export. `APP_VERSION` → `0.3.43`.

**Previous session shipped:**
1. **Stamp Kit / Tag modes** — stamp footer toggles Kit vs Tag. Kit lists all presets sorted by library population (count badge); Tag keeps working-set chips + tag sheet (no kits tab). Kit nearness auto-arm sets Kit mode. `APP_VERSION` → `0.3.40`.

**Previous session shipped:**
1. **Kit nearness no-op fix** — selecting a kit with unhashed seeds previously did nothing (empty medoids → sort identity). Gallery now auto-hashes kit seed thumbnails, reapplies order, and toasts when no full-kit matches exist. `APP_VERSION` → `0.3.39`.
2. **Rename kits** — Manage → Tags: tap a kit name to edit. `0.3.38`.
3. **Competitive kit nearness** — soft exclusive-affinity vs other kits. `0.3.37`.

**Previous session shipped:**
1. **Kit nearness frozen until reapply** — gallery order snapshotted on apply/epoch; stamping does not rebuild medoids or reshuffle. **Reapply** (or re-pick kit) refreshes. `APP_VERSION` → `0.3.32`. Served on :3080.
2. **Options menu** — Sort/Filter tabs; kit picker; stamp auto-arm. `0.3.31`.

**Previous session shipped:**
1. **Kit nearness gallery sort** — Filter → Kit nearness → pick a kit. Seeds = library files with the full kit; up to 6 dHash medoids (farthest-first); gallery ordered by min Hamming (best first). Mutually exclusive with viewport fit / image size / shuffle. Main gallery only. `APP_VERSION` → `0.3.30`. Served on :3080.

**Previous session shipped:**
1. **Kit nearness gallery sort** — Filter → Kit nearness → pick a kit. Seeds = library files with the full kit; up to 6 dHash medoids (farthest-first); gallery ordered by min Hamming (best first). Mutually exclusive with viewport fit / image size / shuffle. Main gallery only. `APP_VERSION` → `0.3.30`. Served on :3080.

**Previous session shipped:**
1. **Softer thumbnail memory caps (verified)** — session 160 MB; disk 400 MB; heap emergency at 85%/10%; cheaper IDB; priority queue + cancel off-screen network; grid overscan 6 / masonry 800 px. Lint + production build green.

**Previous session shipped:**
1. **Similar accuracy** — Stage-2 photometric residual (gain+bias), bidirectional crop check, soft color gate, Hamming-ordered candidates (6/file), low-texture penalty. Expanded Picsum pool (16 seeds): crop 62/64, shading 69/80, offset 40/64, cross FP **0/120**. `APP_VERSION` → `0.3.29`. Served on :3080.

**Previous session shipped:**
1. **Softer thumbnail memory caps** — session budget 64→160 MB; disk 200→400 MB; heap emergency only at 85% and drops 10% (was 70%/25%); IDB `getAll` only when over budget (running byte counter); debounce `lastAccess` touches (5 min); priority load queue + cancel off-screen network fetches; grid `overscanCount={6}` / masonry 800 px. `APP_VERSION` → `0.3.28`.

**Previous session (analysis):**
1. **Gallery thumb scroll regression** — `a2e41bc167` (`0.3.13`) memory LRU caused missing thumbs / slow fill during scroll.

**Previous session shipped:**
1. **Tag filter kits + ONLY** — Gallery Tags picker and query builder include a Kits tab (Has expands kit tags). Match mode gains **ONLY**: photos whose user tags are exactly the selected Has set (system tags ignored). Persists in smart albums. `APP_VERSION` → `0.3.27`.

**Previous session shipped:**
1. **Similar max-size = hide oversized (not slice).** `trimSimilarityGroups` hides groups larger than the setting. `APP_VERSION` → `0.3.26`.

**Previous session shipped:**
1. **Similar stability** — Stage-2: 3-hex color buckets, color Hamming prefilter, `MAX_TOTAL_CROP_CANDIDATES=2000`, size-capped `tryUnion`. UI: progress-only during hash/crop. Crop-verdict cache capped at 4k. Served as `NTPhotos 0.3.25`.

**Previous session shipped:**
1. **Stamp as its own tool** — stamp icon next to select; pick tags/kit then tap (or drag) photos to apply instantly. Mutually exclusive with selection; no checkmarks while stamping. `APP_VERSION` → `0.3.23`.

**Previous session shipped:**
1. **Crop aspect lock** — image crop overlay checkbox “Lock aspect ratio” (default on). Locked resize keeps the device-viewer aspect so you can shrink without distorting the ratio; unchecked allows free resize. `APP_VERSION` → `0.3.22`.

**Previous session shipped:**
1. **Gallery Filter → Image size** — Largest / Smallest reorder by pixel area (`w×h` from pub magic metadata), not file bytes. Session-only; mutually exclusive with viewport fit and shuffle. `APP_VERSION` → `0.3.21`.

**Previous session shipped:**
1. **Similar threshold/max-size cache** — after Find similar, Stage-1 edges (up to distance 20) and crop-pair verdicts stay in a session cache. Changing threshold reclusters from edges + reapplies crop cache (sync when fully cached); max group size only re-trims display. `APP_VERSION` → `0.3.19`.

**Previous session shipped:**
1. **Gallery Filter → Viewport fit** — Best Fit / Worst Fit. `APP_VERSION` → `0.3.17`.

**Previous session shipped:**
1. **Similar max group size = display trim only** — Stage-1/Stage-2 cluster uncapped; `trimSimilarityGroups` slices cards after matching. Fixes artificial mega-fragmentation when the setting was applied during union-find. `APP_VERSION` → `0.3.16`.

**This session (in progress, other thread):**
1. Faster Stage-2 crop checks — decode-once grids, batched worker messages, packed color Hamming, throttled group rebuilds.
2. **Faster Stage-1 hash compare** — packed dHash Hamming, variant short-circuit, cheaper progress rebuilds. `APP_VERSION` → `0.3.14`.

**Previous session shipped:**
1. **Kit suggestions = exact tag sets only** — no pairwise co-occurrence; a photo with A+B+C only counts toward `A + B + C`, not `A + B`. `APP_VERSION` → `0.3.12`.

**Previous session shipped:**
1. **Kit suggestions (initial)** — Manage → Tags → View suggestions (later tightened to exact sets). `APP_VERSION` → `0.3.10`.

**Previous session shipped:**
1. **Memory audit (no code changes)** — ranked findings on runtime cache; primary risk is unbounded in-memory thumbnail blob URLs in `thumbnail-cache.ts` after long gallery scrolls.

**Previous session shipped:**
1. **Preset tags via dropdown** — Manage → Tags kits pick from existing tags (chips + select), not free-typed lists. Existing kits editable the same way.
2. **Selection Tags → Kits tab** — defaults to Kits, sorted by how many selected photos already have the full kit (`N/total`). `APP_VERSION` → `0.3.9`.

**Previous session shipped:**
1. **Fast tagging toolkit** — select-all-matching + “Tag matching…” (query→bulk, confirm when >25), tag presets (Manage → Tags, organizer config sync), sticky working-set bar (pinned/recent/presets), stamp mode, selection difference counts (`N/total`), bulk undo toast, copy tags from first selected, album Select all. `APP_VERSION` → `0.3.8`.

**Previous session shipped:**
1. **Similar max group size control** — replaced the slider with explicit **1 / 2 / 3 / 4 / 5** toggles (range was already 1–5 in code; slider UX was confusing / easy to mistake for old step-5 behavior). `APP_VERSION` → `0.3.7`.
2. **Similar grouping is manual** — Scan library then Find similar. `APP_VERSION` → `0.3.6`.

**Previous session shipped:**
1. **Similar max group size** — slider range tightened to **1–5** (default 5). Old persisted values >5 clamp down. Core default `MAX_GROUP_SIZE` matched. `APP_VERSION` → `0.3.5`.

**Previous session shipped:**
1. **Crop default = device viewer aspect** — opening crop (image/video) seeds a centered max-fit crop box matching the current device viewport aspect ratio (replaces content-bounds as the initial selection).
2. **Gallery Filter → Viewport fit** — None / Best Fit / Worst Fit. Reorders (does not hide) by aspect match vs the live viewer viewport; session-only. Shuffle clears when a fit mode is active.
3. `APP_VERSION` → `0.3.4`.

**Previous session shipped:**
1. **Similar max group size setting** — Manage → Settings → “Similar photos” slider (later tightened to 1–5). Persisted as `similarMaxGroupSize`; threaded through Stage-1 worker + crop merge.

**Previous session shipped:**
1. **Similar/Exact group list scroll** — list was a flex column so cards shrunk as groups grew; now block flow + scroll, cards `shrink-0`, thumb row `min-h-20`. `APP_VERSION` → `0.3.1`.
2. **Stage-1 runs in a dedicated phash worker** (`runStage1InWorker`) — full mutual-kNN + Kruskal, no pair skipping; main thread only paints progress/groups.
3. **Live Similar UX** — determinate progress for hash compare + crop check; provisional tight-match groups stream in as they are found (`onProgress` / `onGroups`).

**Previous session shipped:**
1. **PWA Similar Stage-1 rewrite** — mutual nearest-neighbour + Kruskal/`tryUnion` (size-capped), async yielding so the tab stays live; default threshold 8. Near-exact matches (≤2) skip mutual filter so identical piles still group. Tests + production build green. Push to `ntphotos` triggers Deploy (NTPhotos) via `mobileapp/**` paths.

**Previous session shipped:**
1. **Bottom nav first-load offset** — AppShell no longer uses `position: fixed` for the tab bar (iOS standalone leaves a gap until a route change reflows). Shell is `h-dvh` flex column; nav is an in-flow `shrink-0` child with safe-area padding; main scrolls.

**Previous session shipped:**
1. **Zoomed carousel locked** — removed edge-pan→slide (`onPanRelease`) so zoomed images pan only.
2. **Archive tucked away** — Archive/Unarchive moved into a ⋮ More menu in the viewer chrome.
3. **Upload-date sort preserved on crop/compress** — derived uploads fall back to source `updationTime` → `creationTime` when `uploadedAt` is missing.
4. **Manual crop filter** — `buildCroppedOrganizerTags` strips `auto-cropped` on manual crop.
5. **Safari edge-back absorbed** — viewer `pushState` + `popstate` re-push stays put (noop); cleaned up on close; `overscroll-none` on viewer root.

**Previous session shipped:**
1. **Manage-tab freeze fix (crop / similarity).** Similarity + crop merge no longer run on Manage hub open. Stage-2 uses size-aware `tryUnion` (cap `MAX_GROUP_SIZE`) so crop matches cannot re-chain mega-groups and freeze the UI on O(n²) `assembleGroup`. Crop merge is abortable; Similar shows Stage-1 then “refining…”. Hot-path bucket builds are O(n). Regression tests cover size cap + abort. Served at `http://192.168.0.182:3080` for phone QA.

**Previous session shipped:**
1. **Planned five UX fixes** (implemented above).

**Previous session shipped:**
1. **Diagnosed Manage-tab multi-minute freeze** (crop / similarity path). Root causes: eager Manage-mount work + Stage-2 mega-groups + main-thread O(n²) assemble — now fixed above.

**Previous session shipped:**
1. **Manual-crop filter scope** in the gallery Filter dropdown (and query builder / smart albums): All / Cropped / Not cropped. Matches files with organizer tag `cropped` but not `auto-cropped` (auto-crop results and never-cropped files fall under Not cropped). Wired through `TagFilterSelection.croppedScope`, persistence in query albums, and counts like favourites.

**Previous session shipped:**
1. **Crop matching runs on the worker pool, not the UI thread.** `mergeCropMatches` (Stage-2) previously ran `templateMatchScore` on the main thread — ~20 ms/pair × up to ~4 checks × 5k files froze the phone for minutes on every Manage open / threshold change. Now candidate pairs are batched (`batchSize = 48`) and verified by `checkCropMatchInWorkers` → `crop-check` messages on the shared phash worker pool; the UI thread only unions verdicts between batches. `PhashWorkerRequest` gained a `kind: "hash"` discriminator so the worker's `onmessage` now dispatches a proper discriminated union.
2. **Giant chained groups are capped.** Union-find is transitive (A~B, B~C ⇒ A,B,C grouped even when A≁C), so a loose 8-variant/threshold=10 graph could collapse thousands of distinct photos into one 1894-image group. Any component over `MAX_GROUP_SIZE = 40` is re-clustered by recursive strict single-linkage: exact hash-prefix buckets (no ±1 neighbor unions) × best-variant distance ≤ half threshold, recursing to a longer prefix until bounded, with a deterministic hard slice at the full 64-bit exact-identical case. Genuine duplicates (dist ~0-4) stay grouped; the "bridge" links that manufacture mega-groups are dropped. Regression tests cover both the chain-split and the intact-identical-cluster cases.
3. **Threshold recompute debounced.** The similarity slider updates live while dragging; `buildSimilarityGroups` + worker crop merging only re-run after the user pauses (300 ms debounce) instead of on every tick. `manage.tsx` drives grouping from a `debouncedThreshold`, keeping `threshold` bound to the visible slider.

**This session shipped two features (previous):**
1. **Gallery sorting by upload date** (default). Ente doesn't expose an upload date, so we stamp our own: `uploadedAt` (set once at upload) and `editedAt` (set on every pub-meta write by `withEditedAt`) live in `pubMagicMetadata.data`. Sort keys in `mobileapp/src/lib/sort-files.ts` (`fileUploadSortTime`: `uploadedAt` → `updationTime` → `creationTime`; `fileEditSortTime` likewise). A gallery toggle switches between **upload date** (default) and **edit date** (see `useSettingsStore.gallerySortBy`, wiring in `gallery.tsx`, `albums.tsx`, `AlbumEditorPanel.tsx`, `ManageArchivedPanel.tsx`, `pull-files.ts`).
2. **Similar-image detection, Stages 1 + 2**:
   - **Stage 1 (rotation/mirror)**: the phash worker now emits **8 dHash variants** per image (4 rotations × mirror), so rotated/mirrored duplicates match against the source under any orientation. Index schema widened to `PhashEntry.hashes: string[]`.
   - **Stage 2 (crops)**: `mobileapp/src/lib/crop-match.ts` — a **64-bit color-palette signature** (`colorHashFromImageData`, translation-invariant) proposes candidates; a **48×48 grayscale template match** (`templateMatchScore`, scale+offset SAD over all 8 source orientations with coarse/full tiers and early-abort) verifies them. `mergeCropMatches` in `similarity-groups.ts` runs async in chunks, capped at `MAX_CROP_CHECKS_PER_FILE = 4`, and unions crop groups into the Stage-1 union-find.
   - **Validation** (`mobileapp/scripts/crop-match-validate.ts`, real photos): rotate/crop recall **30/32**, cross-photo FP **0/28**. Cost: ~20 ms/pair on reject path, so the per-file cap keeps the async pass bounded.
   - Replaced `sortFilesNewestFirst` in `ente-core.ts` with `sortFilesByUpload`. Upload paths stamp `uploadedAt`/`editedAt` (`upload-image.ts`, `upload-video.ts`, `upload-compressed-media.ts`).
   - Dead-end exploration scripts removed (`crop-bench*`, `orb-cost*`); `@webarkit/purecv-wasm` dev-dependency dropped. Kept `crop-match-validate.ts` + `similarity-spike-real.ts` (removed; see commit `81946e8e48`) as reproducible regression harnesses.

**Key storage (M3):** Master key and `cacheKey = HKDF(masterKey)` live in memory only. Metadata, collections, tag index, and **trash items** (+ trash collection keys) persist as blobs encrypted with `cacheKey` in IndexedDB (`ente-organizer-{userId}`). Thumbnails persist as server ciphertext (CDN bytes + decryption header) — readable only with `file.key` from decrypted metadata after login. **Videos** persist in IDB (`fileCiphertexts`) as server ciphertext **additionally wrapped with `cacheKey`** (size-capped LRU), plus an in-memory blob-URL session LRU; without login there is no `cacheKey`/`file.key`, so disk blobs are opaque. Sync cursors store timestamps only (including trash `lastUpdatedAt`). Sign out clears memory; **Lock** wipes IDB + memory. Full-res **images** are never persisted.

### Milestone completion (check when **all** exit criteria + checklist items for that milestone are done)

- [x] **M0** — Crypto spike (login + decrypt one file)
- [x] **M1** — Extracted core module + crypto test suite
- [x] **M2** — Read-only gallery PWA
- [x] **M3** — Local cache + tag index + sync
- [x] **M4** — Tag system (core feature)
- [x] **M5** — Favourites view
- [x] **M6** — Dedup + similarity
- [x] **M7** — Compression
- [x] **M8** — Crop + upload/delete

### Cross-cutting (can be done inside the milestone noted, check when shipped)

- [x] Panic / re-auth + cache-wipe control _(M3)_
- [x] Incremental sync via diff endpoints _(M3)_
- [x] Two-writer conflict detection on metadata _(M4 — refetch + retry on PUT failure)_
- [x] Dry-run / confirm gates on destructive ops _(M6)_

---

## Project Summary

A custom mobile-first photo frontend for Ente Photos, built as an installable **Next.js PWA** in **TypeScript** at **`mobileapp/`** (repo root), focused on richer media organization than the official app provides. Uploads continue through Ente's native app; this frontend is for viewing, organizing, and curating an existing encrypted library.

The build reuses Ente's open-source client-side encryption core — authentication, key derivation, and libsodium decryption — extracted from their web packages (and optionally backed by the Rust `ente-wasm` crate already in this repo) and wrapped behind a small interface you control. All decryption happens client-side; the architecture preserves Ente's end-to-end encryption guarantees throughout transfer, storage, and local caching. Cryptographic integrity is locked down with a dedicated test suite (known-answer vectors, round-trip equality, tamper detection, lossless metadata round-tripping) so the crypto layer is trustworthy regardless of how loosely the surrounding UI is built.

**Core feature — a flexible tag system**, stored inside Ente's encrypted **public magic metadata**, where media can hold multiple tags at once, be filtered by intersecting multiple tags simultaneously (e.g. `selfie` ∩ `vietnam`), and be managed from a central create/rename/merge/delete screen. Filtering runs against a local tag index for instant, server-free queries.

**Supporting tools:**
- Exact duplicate detection (content hash from metadata — no download required)
- Near-duplicate / similarity detection via client-side perceptual hashing over cached thumbnails, with user-driven deletion
- User-driven media compression with minimal quality loss, auto-tagged as compressed to prevent double-processing
- Basic image editing (cropping required; other adjustments optional)
- A dedicated favourites view, wired to Ente's native favourites collection
- Deletion; upload optional if the native app remains the primary ingestion path

**Cross-cutting concerns:** an encrypted local cache for offline use and performance, deliberate handling of where decryption keys live in a browser context, efficient and batched server calls that respect rate limits, and safe coexistence with the official app as a second writer to the same metadata.

The work is sequenced so the load-bearing foundation comes first (crypto spike → extracted core → read-only gallery → local cache + sync), then the tag system as the central payoff, then the supporting tools — each reusing machinery from prior milestones. Finishing through M4 alone delivers the project's primary goal.

### Tech stack

Everything is **TypeScript** — the M1 core module (`mobileapp/src/core/`), the Next.js app, tests, and scripts.

| Layer | Choice | Notes |
|---|---|---|
| Framework | Next.js + React 19 | Existing skeleton at **`mobileapp/`** (repo root) |
| Language | TypeScript | End-to-end; reuse types from `ente-media` where possible |
| Client state | **Zustand** | Session, library, filters, sync progress, UI chrome — keep stores small and domain-scoped |
| Validation | **Zod** | Runtime parsing at API/metadata boundaries; already used throughout Ente packages |
| Persistence | IndexedDB via **idb** or **Dexie** | Thumbnail cache, sync cursors, tag index (M3+) — not a substitute for Ente's server state |
| Virtualization | **react-window** or **@tanstack/react-virtual** | Thumbnail grid |
| Tests | **Vitest** | Crypto suite (M1); component/store tests as needed |
| Crypto | `ente-base/crypto` or `ente-wasm` | Pick one in M1 |

**Zustand store sketch** (expand as milestones land):

- `useSessionStore` — auth status, user email; master key held in closure/module scope, not persisted to disk
- `useLibraryStore` — decrypted file list, collection membership, last sync times
- `useTagStore` — tag index, active filter tags (M4)
- `useUIStore` — viewer open/closed, selection, background job progress (M6)

Avoid Redux, Context-heavy trees, or the official app's gallery reducer — Zustand keeps the new UI decoupled and lightweight. Reach for additional libraries only when there is a concrete need; prefer what Ente packages already depend on (`zod`, `ente-utils`) over new surface area.

### Project layout

The frontend app **already exists** as a skeleton at **`mobileapp/`** in the repo root. All UI and app-level code is built here — do not scaffold a new Next.js app or add a second app under `web/apps/`.

```
ente/                              # monorepo root
├── mobileapp/                     # ← the PWA app (use this)
│   ├── src/
│   │   ├── pages/                 # Next.js Pages Router (_app.tsx, index.tsx, …)
│   │   ├── core/                  # M1: extracted Ente crypto/auth/API module
│   │   ├── stores/                # Zustand stores
│   │   └── components/            # UI components
│   ├── public/                    # PWA manifest, icons, static assets
│   ├── next.config.ts
│   ├── package.json
│   └── tsconfig.json
├── web/                           # upstream Ente web code — lift packages from here
│   ├── apps/photos/               # official Photos app — reference only, do not fork
│   └── packages/                  # ente-base, ente-media, ente-accounts, …
├── cli/                           # Go CLI — clean auth reference for M0
└── architecture/                  # E2EE key hierarchy docs
```

**Current skeleton state:** Next.js 16, React 19, TypeScript, Pages Router (`src/pages/`). Run with `cd mobileapp && npm run dev`. Evolve `next.config.ts` as needed (static export, `transpilePackages` if importing from `web/packages/`, PWA plugin in M2).

The M0 spike script and M1 crypto test suite can live under `mobileapp/scripts/` and `mobileapp/src/core/` respectively.

---

## Codebase Reference

The project builds on the [ente-io/ente](https://github.com/ente-io/ente) monorepo. The table below maps each concern to the source files an implementing agent should read first.

### Where the code lives

| Concern | Primary location in this repo | Notes |
|---|---|---|
| **This app's skeleton** | **`mobileapp/`** | Next.js PWA — all frontend milestones target this directory |
| Crypto (libsodium wrappers) | `web/packages/base/crypto/` | Box / Blob / Stream encryption; Argon2id key derivation |
| Auth + SRP + 2FA | `web/packages/accounts/services/` (`srp.ts`, `user.ts`) | Also mirrored in `web/packages/accounts-rs/` |
| File + metadata types | `web/packages/media/` (`file.ts`, `file-metadata.ts`, `magic-metadata.ts`) | Defines `EnteFile`, three metadata layers |
| Download + decrypt blobs | `web/packages/gallery/services/download.ts` | Thumbnails, full files, streaming video |
| Photos API + sync | `web/packages/new/photos/services/` (`collection.ts`, `file.ts`, `pull.ts`) | Diff sync, metadata updates, favourites |
| Exact dedup | `web/packages/new/photos/services/dedup.ts` | Hash-based grouping via `metadataHash()` |
| Clean non-UI auth reference | `cli/` (Go) | SRP login flow without React |
| Rust crypto + API | `rust/bindings/wasm/ente-wasm/`, `rust/apps/cli/` | WASM built via `npm run build:wasm` in `web/` |
| Key hierarchy docs | `architecture/README.md` | masterKey → collectionKey → fileKey |

The official Photos web app lives at `web/apps/photos/`. **`mobileapp/`** is a separate Next.js project at the repo root with its own pages and components. Lift crypto/API logic from `web/packages/` into `mobileapp/src/core/` — do not copy the official app's UI.

### Encryption & metadata model (critical for tags)

Each file has **three encrypted metadata blobs**, all decrypted with the **file key** (itself encrypted with the **collection key**, which is encrypted with the **master key**). See `[Note: Metadatum]` in `web/packages/media/file-metadata.ts`.

1. **`metadata`** — immutable, set at upload (title, creationTime, content **hash**, parsed Exif fields).
2. **`magicMetadata`** — private mutable (owner-only); today mostly `visibility` (normal / archived / hidden).
3. **`pubMagicMetadata`** — public mutable (shared with album collaborators); holds user-editable fields like **`caption`**, `editedTime`, `editedName`, location overrides.

Decryption of a remote file entry is implemented in `decryptRemoteFile()`:

```358:413:web/packages/media/file.ts
export const decryptRemoteFile = async (
    remoteFile: RemoteEnteFile,
    collectionKey: string,
): Promise<EnteFile> => {
    // ...
    const key = await decryptBox(
        { encryptedData: encryptedKey, nonce: keyDecryptionNonce },
        collectionKey,
    );
    const metadataJSON = await decryptMetadataJSON(encryptedMetadata, key);
    // ... decrypt magicMetadata and pubMagicMetadata with same file key ...
    return { ...rest, id, key, metadata, magicMetadata, pubMagicMetadata };
};
```

**Where tags live:** user-facing text and custom fields belong in **`pubMagicMetadata.data`**, not in immutable upload metadata. Do not confuse these two fields:

| Field | Location | Mutable? | Suitable for tags? |
|---|---|---|---|
| `parsedMetadata.description` | Immutable `metadata` | No — extracted from Exif at upload | No |
| `caption` | `pubMagicMetadata.data` | Yes — user-editable in the official app | Yes — either embed a namespaced block here, or add a sibling key |

The official app reads/writes captions via `pubMagicMetadata.data.caption` (see `FileInfo.tsx`, `updateFileCaption()` in `web/packages/new/photos/services/file.ts`). Metadata updates go through `PUT /files/public-magic-metadata` with **version + count** optimistic locking — you must spread existing keys, not replace the whole object:

```247:264:web/packages/new/photos/services/file.ts
const updateFilesPublicMagicMetadata = async (
    files: EnteFile[],
    updates: FilePublicMagicMetadataData,
) =>
    putFilesPublicMagicMetadata({
        metadataList: await Promise.all(
            files.map(async ({ id, key, pubMagicMetadata }) => ({
                id,
                magicMetadata: await encryptMagicMetadata(
                    createMagicMetadata(
                        { ...pubMagicMetadata?.data, ...updates },
                        pubMagicMetadata?.version,
                    ),
                    key,
                ),
            })),
        ),
    });
```

Because schemas use `z.looseObject`, **unknown keys in `pubMagicMetadata.data` are preserved** as long as every writer merges rather than replaces. A dedicated key (e.g. `customTags`) is viable — but **verify experimentally** that the official mobile app doesn't strip unknown keys when editing caption/location.

### Favourites

Favourites are a special collection with `type: "favorites"` (see `web/packages/media/collection.ts`). Marking a photo favourite adds or moves a user-owned copy into that collection via `/collections/add-files` and related APIs — see favourite handling in `web/packages/new/photos/services/collection.ts`. M5 wires into this collection model.

### Content hash for exact dedup

Content hash lives on immutable metadata — exact duplicate detection does not require downloading file bytes:

```122:140:web/packages/media/file-metadata.ts
    /**
     * A hash of the file's contents.
     * For images and videos this is the hash of the file's contents.
     */
    hash?: string;
```

The existing dedup service groups by `metadataHash(file.metadata)` — see `deduceDuplicates()` in `web/packages/new/photos/services/dedup.ts`.

### Sync / diff endpoints

| Endpoint | Purpose | Reference |
|---|---|---|
| `GET /collections/v2?sinceTime=` | Collection list changes | `collection.ts` |
| `GET /collections/v2/diff?collectionID=&sinceTime=` | File changes within one collection | `collection.ts`, `rust/apps/cli/src/api/methods.rs` |
| `GET /diff?sinceTime=&limit=` | Global incremental file sync (limit ~500) | Rust CLI |
| `GET /trash/v2/diff?sinceTime=` | Trash changes | `trash.ts` |

### What to reuse vs omit

**Reuse (crypto/API layer):**

- `ente-base/crypto` — `encryptBox`, `decryptBox`, `decryptBlobBytes`, `decryptStreamBytes`, `deriveInteractiveKey`, `encryptMetadataJSON`, `decryptMetadataJSON`
- `ente-base/http`, `ente-base/token`, `ente-base/session`, `ente-base/origins`
- `ente-media/file`, `ente-media/file-metadata`, `ente-media/magic-metadata`
- `ente-accounts/services/srp`, `ente-accounts/services/user` (login, key unwrap)
- Core of `ente-gallery/services/download.ts` — thumbnail + file fetch/decrypt
- Selected functions from `ente-new/photos/services/file.ts` and `collection.ts` — diff sync, metadata PUT, trash, favourites

**Omit (not needed for this PWA):**

- Official photos app UI: pages, layout, and feature components under `web/apps/photos/src/`
- Shared Ente UI primitives you don't need: `ente-base/components/*`, MUI, PhotoSwipe viewer, sidebar, ML settings, search workers, i18n/Crowdin
- Upload pipeline UI (`gallery/services/upload/*`) — needed from M7 onward, not M0–M4
- Electron/desktop hooks (`ente-base/electron.ts`)
- FFmpeg, Leaflet, HLS, CLIP/ML indexing (`new/photos/services/ml/*`)

**Crypto stack choice:** the core can target either `libsodium-wrappers` (via `ente-base/crypto`) or the Rust `ente-wasm` crate. The monorepo builds WASM via `npm run build:wasm` before web apps compile. Pick one stack in M1 and stay consistent.

---

## M0 — Spike: prove the crypto path end-to-end

Before any UI, one throwaway script (not even React): authenticate against your real Ente account, complete the login + 2FA + SRP dance, pull the key hierarchy, fetch *one* file's encrypted blob and its metadata, decrypt both, and write the plaintext image to disk. If you can't do this, nothing else matters — prove it on day one.

### Reference implementations in this repo

**Auth (simplest to read):** Go CLI at `cli/pkg/sign_in.go` — SRP session flow against `/users/srp/*`, Argon2id KEK derivation, master key unwrap from `KeyAttributes`.

**Auth (TypeScript):** `web/packages/accounts/services/srp.ts` + `user.ts` — same flow using `fast-srp-hap` and `ente-base/crypto`.

**Decrypt one file:**
1. `GET /collections` → decrypt collection keys with master key
2. `GET /collections/v2/diff?collectionID=X&sinceTime=0` → encrypted file entries
3. `decryptRemoteFile(entry, collectionKey)` → `EnteFile` with file key + metadata
4. Fetch thumbnail: `GET https://thumbnails.ente.com/?fileID={id}` (header `X-Auth-Token`) → `decryptBlobBytes({ encryptedData, decryptionHeader: file.thumbnail.decryptionHeader }, file.key)`
5. Fetch full file via download URL pattern in `download.ts` → `decryptStreamBytes` for images

Deliverable: a Node/TS script that logs in and dumps one decrypted photo + its decrypted `pubMagicMetadata` JSON. Watch response headers during login/sync to discover real rate limits empirically. TypeScript via `tsx` or compiled output — same language as the app and core package.

### M0 checklist

- [x] Read `cli/pkg/sign_in.go` and `web/packages/accounts/services/srp.ts`; confirm auth steps match your account (SRP vs email OTP vs 2FA)
- [x] Script authenticates against production (or self-hosted) API — `mobileapp/scripts/ente-cli.ts`
- [x] Master key recovered; at least one collection key decrypted — `session.ts` + `sync.ts`
- [x] One file entry fetched via diff or `/collections/file` — `/collections/v2/diff` in `sync.ts`
- [x] `decryptRemoteFile` equivalent produces readable metadata JSON (inspect `pubMagicMetadata.data.caption`) — via `ente-media/file`
- [x] Thumbnail decrypted to valid JPEG/PNG bytes on disk — verified file 672175118-thumb.jpg (16347 bytes)
- [x] Full-res image decrypted and matches what the official app shows — verified file 672175118-full.png (856690 bytes)
- [x] Rate-limit / retry behaviour noted (headers, 429 responses) — `http.ts` logs rate-limit headers; no 429 observed on single-file run
- [x] Spike code location documented in Agent Progress Report (e.g. `mobileapp/scripts/`)

**How to run:**

```sh
cd mobileapp
npm run spike
# or:
ENTE_EMAIL=you@example.com ENTE_PASSWORD=... ENTE_TOTP=123456 npm run spike -- --file-id 12345
```

Outputs land in `mobileapp/scripts/output/` (gitignored). Crypto shim at `src/core/crypto-shim.ts` redirects `ente-base/crypto` → libsodium for Node compatibility.

**Exit criteria:** decrypted bytes match what the official app shows; metadata JSON is human-readable and you can identify where tags will live (`caption` or custom `pubMagicMetadata` key).

---

## M1 — The extracted crypto/auth/API core

Turn the spike into a real module. Lift Ente's crypto wrapper, account/key-management, and API client from `web/packages/`, wrap them behind a tiny interface you control:

```typescript
// Target seam — illustrative, adjust names to taste
interface EnteCore {
  login(credentials): Promise<Session>;
  listCollections(): Promise<Collection[]>;
  syncCollectionFiles(collectionId, sinceTime): Promise<EnteFile[]>;
  getDecryptedThumbnail(file: EnteFile): Promise<Uint8Array>;
  getDecryptedFile(file: EnteFile): Promise<Uint8Array>;
  getPublicMetadata(file: EnteFile): FilePublicMagicMetadataData;
  updatePublicMetadata(file: EnteFile, updates: Partial<FilePublicMagicMetadataData>): Promise<void>;
}
```

This interface is the seam between "Ente's code, trusted, tested" and your app UI.

### Crypto test suite (before any UI)

| Test | What to assert | Code reference |
|---|---|---|
| Key derivation KAT | Same password + salt → same KEK | `deriveInteractiveKey` / `deriveKey` in `ente-base/crypto` |
| Box round-trip | `decryptBox(encryptBox(data, key), key) === data` | `encryptBox` / `decryptBox` |
| Blob round-trip | Metadata JSON survives encrypt/decrypt | `encryptMetadataJSON` / `decryptMetadataJSON` |
| Tamper detection | Flip one byte in ciphertext → throws | libsodium auth tag |
| Metadata merge | `{ ...existing, caption: "x" }` preserves unknown keys | `createMagicMetadata` spread pattern in `file.ts` |
| File decrypt integration | Known test vector file decrypts | `decryptRemoteFile` |

Existing tests to mine: `cli/internal/crypto/crypto_test.go`, any `ente-base/crypto` tests.

### M1 checklist

- [x] M1 core module at `mobileapp/src/core/` (TypeScript, strict)
- [x] Dependencies on `ente-base`, `ente-media`, `ente-utils` wired (libsodium via crypto-shim)
- [x] `EnteCore` class implemented at `mobileapp/src/core/ente-core.ts`
- [x] `login()` — SRP + TOTP 2FA + in-memory session
- [x] `syncCollectionFiles()` — `/collections/v2/diff` + `decryptRemoteFile`
- [x] `getDecryptedThumbnail()` — thumbnails.ente.com + `decryptBlobBytes`
- [x] `getDecryptedFile()` — files.ente.com + `decryptStreamBytes`
- [x] `updatePublicMetadata()` — merge + PUT `/files/public-magic-metadata`
- [x] Crypto test suite green (`npm test` — 6 tests)
- [x] CLI harness lists N files and decrypts arbitrary file by ID (`npm run cli`)

**How to run:**

```sh
cd mobileapp
npm test                                          # crypto suite
npm run cli -- list --limit 20                    # list files
npm run cli -- decrypt --file-id 672175118        # decrypt one file
ENTE_EMAIL=... ENTE_PASSWORD=... npm run cli -- list
```

**Exit criteria:** green test suite + CLI that lists and decrypts arbitrarily — verified against test account.

---

## M2 — Minimal gallery PWA (read-only)

First actual frontend. **Build on the existing `mobileapp/` skeleton** — wire in the M1 core, render a scrollable thumbnail grid with a full-screen viewer. Read-only. No tags yet.

### Next.js setup

The app skeleton is already in place. Extend it rather than creating a new project:

- **App root:** `mobileapp/` — Pages Router under `src/pages/`
- **Config:** evolve `mobileapp/next.config.ts` — add static export (`output: "export"`) when ready to deploy; add `transpilePackages` if depending directly on `web/packages/*`
- **Dev:** `cd mobileapp && npm run dev`
- React 19 + **TypeScript** (strict); stay on Pages Router unless there is a strong reason to migrate
- **Zustand** for client state from day one — at minimum a session store and a library store before the grid renders
- **PWA:** add `public/manifest.webmanifest`, icons, theme colour, and a service worker (e.g. [Serwist](https://serwist.pages.dev/) via `@serwist/next` or equivalent). Test install-to-homescreen on a real phone early — static export is compatible with offline caching of shell assets; decrypted media stays in IndexedDB from M3
- If using `ente-wasm`, build WASM first: `cd web && npm run build:wasm`, then wire the output into `mobileapp`

### Implementation notes

- **Virtualized grid:** `react-window` is already used in `ente-gallery` — reuse that pattern or `@tanstack/react-virtual`
- **Thumbnail-first:** grid calls `getDecryptedThumbnail()` only; never full file
- **State:** gallery reads from `useLibraryStore`; login flow updates `useSessionStore`
- **Keys:** master key + file keys in memory only for this milestone

### M2 checklist

- [x] `mobileapp/` skeleton confirmed — Pages Router, TypeScript, dev server runs
- [x] `next.config.ts` updated for deployment needs (static export, transpilePackages as needed)
- [x] Zustand installed; `useSessionStore` + `useLibraryStore` in `mobileapp/src/stores/`
- [x] M1 core imported from `mobileapp/src/core/`; login page works
- [x] Collection picker or default "all photos" view
- [x] Virtualized thumbnail grid
- [x] Tap → full-screen viewer with full-res fetch on demand
- [x] Loading / error states for decrypt failures
- [x] PWA manifest, icons, and service worker; installable on mobile
- [ ] Smooth scroll with 1000+ items (real library test)

**Exit criteria:** installs as a PWA on your phone, scrolls your real library smoothly, opens full-res on tap.

---

## M3 — Local encrypted cache + tag index

The performance and offline backbone.

**A. Encrypted local cache** — avoid re-fetching on every visit; nothing on disk is readable without login.

**Key storage decision (implemented):**
- **Session keys:** master key + `cacheKey` (HKDF from master key) in memory only; cleared on tab close / sign out
- **Persisted metadata:** collections, file snapshots, and tag index encrypted with `cacheKey` in IndexedDB (`idb`, DB name `ente-organizer-{userId}`)
- **Persisted thumbnails:** server ciphertext in IndexedDB (CDN encrypted bytes + header); decrypted with `file.key` only after login
- **Lock button:** wipes in-memory keys + entire IndexedDB for the user (sign out clears memory only, keeps encrypted cache for fast re-login)
- **Full-res viewer:** images network on demand and never persisted; videos use session blob-URL LRU + optional encrypted IDB ciphertext cache (size-capped); shows cached thumbnail while loading

**B. Local tag index** — built from `pubMagicMetadata.data._organizer_v1.tags` on sync. Persisted encrypted; exposed through `useTagStore` (read-only until M4).

**C. Incremental sync** — `/collections/v2` and `/collections/v2/diff` with persisted `sinceTime` per collection. Implementation: `mobileapp/src/lib/sync/pull-collections.ts`, `pull-files.ts`.

### M3 checklist

- [x] Thumbnail cache in IndexedDB keyed by `file.id` (server ciphertext)
- [x] Metadata snapshot cache (encrypted; rebuilds tag index offline)
- [x] Second launch: grid renders from cache after login before sync completes
- [x] Offline: already-synced media viewable during active session after login
- [x] Tag index built on sync; `useTagStore` populated (read-only — no write UI yet)
- [x] Incremental sync via `/collections/v2/diff` wired
- [x] `sinceTime` persisted per collection
- [x] Panic / lock control clears keys + cache
- [x] Key storage decision documented

**Exit criteria:** second app launch is fast after login; offline works for cached media within a session; in-memory tag map ready for M4 filtering UI.

**How to run:** `cd mobileapp && npm run dev` — login, browse, use **Lock** to wipe local cache, sign out to clear session keys while keeping encrypted cache on disk.

---

## M4 — The tag system (core feature)

Three sub-pieces:

### 4a. Tag schema

Define tag storage inside **`pubMagicMetadata.data`**. Two viable strategies — **verify both against official app before bulk tagging**:

**Option A — namespaced block inside `caption`:**
```
Summer trip          ← human-visible caption
---ente-tags-v1---
["selfie","vietnam"]
```
Pros: visible in official app as caption text. Cons: clutters caption; official app edits may break fence.

**Option B — dedicated key (e.g. `customTags` or `_enteOrganizer`):**
```json
{ "caption": "Summer trip", "customTags": ["selfie", "vietnam"] }
```
Pros: clean separation; merge pattern preserves unknown keys. Cons: must confirm official app round-trips unknown keys.

Run the experiment: write tags via your app → open file in official app → edit unrelated field → sync back → confirm tags survive.

### 4b. Write path

Tag/untag = read `pubMagicMetadata` → merge tag change → `encryptMagicMetadata(createMagicMetadata({ ...data, ...updates }, version))` → `PUT /files/public-magic-metadata` → update local tag index optimistically.

**Conflict detection (two-writer problem):** before write, compare `pubMagicMetadata.version` to last-synced version. If server version advanced since you loaded the file, fetch fresh metadata and merge tags rather than blind overwrite.

### 4c. Read path + management UI

- Multi-tag filter = intersect `Set<fileId>` per tag from `useTagStore` (pure client, no server)
- Tag management screen: create / rename / delete / merge tags (rename/merge = batch metadata rewrite)

**Batching primitive (first needed here):** port `batched()` from `file.ts` (default batch size 1000) with concurrency limits informed by M0 rate-limit observations.

### M4 checklist

- [x] Tag schema chosen and documented (Option B: `_organizer_v1.tags` in `pubMagicMetadata.data`)
- [x] Official-app round-trip experiment passed — tagged photo in PWA, edited description in official app, reloaded PWA; tag persisted
- [x] Tag / untag on single photo works end-to-end (PhotoViewer panel → `updateTagsOnFile`)
- [x] Local tag index updates optimistically (`useTagStore.applyFileTags`)
- [x] Multi-tag filter UI — AND semantics (`TagFilterBar`, `filterFilesByTags`)
- [x] Tag management screen (rename / delete / merge at `/tags`)
- [x] Batch metadata rewrite with concurrency limit (`mapBatched`, concurrency 2)
- [x] Conflict detection on version mismatch (`updateFileTags` refetch via `/collections/file` + retry)
- [x] Tag write survives subsequent official-app sync _(verified: caption/description edit did not strip tags)_

**Exit criteria:** you can tag, multi-filter, and manage tags on your real library, and a tag write survives a subsequent official-app sync.

---

## M5 — Favourites

A small milestone with high payoff: surface Ente's existing favourites collection in a dedicated view.

Reference: `CollectionType.favorites` in `web/packages/media/collection.ts`; add/remove via collection APIs in `collection.ts` (search `favorite`, `favoritesCollectionName`).

Dedicated screen: filter local file list to files present in the favourites collection (or collection membership from sync state).

### M5 checklist

- [x] Favourites collection resolved at login/sync
- [x] Dedicated favourites view in PWA
- [x] Favourite / unfavourite actions call same APIs as official app
- [x] Changes visible in official app favourites view after sync

**Exit criteria:** favourites view matches official app after sync.

---

## M6 — Dedup + similarity (compute-heavy)

Grouped because both need hashes over the library.

**Exact duplicates:** use `metadataHash(file.metadata)` — same approach as `deduceDuplicates()` in `dedup.ts`. Group identical hashes; present for user-driven deletion via `moveToTrash()`.

**Near-duplicates:** perceptual hash (pHash/dHash) over **decrypted thumbnails** (from M3 cache). Group by Hamming distance under threshold. Store hashes in local index (one-time cost per image).

**I/O constraint:** hashing the whole library decrypts every thumbnail once. Run as resumable background job with progress UI; never block the main thread.

**Safety:** dry-run / preview mode before trash — cross-cutting item.

### M6 checklist

- [x] Exact dup screen using metadata hash (no full download)
- [ ] Dedup groups match spot-check against official app's duplicate feature (if available) — manual verify on real library
- [x] pHash computed over cached thumbnails (dHash in Web Worker)
- [x] Similarity groups with adjustable threshold
- [x] Background job with progress + resume
- [x] User selects keeper → `moveToTrash` on losers
- [x] Confirm gate before destructive delete

**Exit criteria:** "find duplicates/similar" screen runs incrementally over a real library without melting the phone.

---

## M7 — Compression

Client-side re-encode (canvas or WASM e.g. mozjpeg) with quality preview — before/after and size delta.

A compressed image is a **new file upload** (port upload logic from `gallery/services/upload/`). Auto-tag the result as `compressed` using the tag system from M4.

### M7 checklist

- [x] Pick encode path (canvas vs WASM)
- [x] Preview UI: before / after / size delta
- [x] Upload new file via Ente upload API (port from upload service)
- [x] Auto-tag `compressed` on new file metadata
- [x] Skip already-compressed files in UI

**Exit criteria:** pick an image, preview compression, accept, re-uploaded and auto-tagged `compressed`.

---

## M8 — Crop + upload/delete

Cropping is the required edit: canvas crop → re-encode → upload as new file (reuses M7's encode+upload path). M7 already establishes the upload pipeline; M8 completes the write surface.

Scope for this milestone:
- **Delete:** `moveToTrash()` — also required by M6 (`web/packages/new/photos/services/collection.ts`)
- **Crop:** required
- **Generic upload:** optional if the native app remains the primary ingestion path

### M8 checklist

- [x] Crop UI (aspect ratio + free crop)
- [x] Crop → encode → upload pipeline
- [x] Delete from PWA (trash, not permanent purge unless desired)
- [x] _(optional)_ Generic file upload

**Exit criteria:** crop + upload works; delete works for dedup/compression flows.

---

## Appendix — API quick reference

| Operation | Method + path | Source |
|---|---|---|
| SRP login | `POST /users/srp/create-session`, `verify-session` | `accounts/services/srp.ts` |
| List collections | `GET /collections/v2?sinceTime=` | `collection.ts` |
| Files in collection | `GET /collections/v2/diff?collectionID=&sinceTime=` | `collection.ts` |
| Update caption/tags | `PUT /files/public-magic-metadata` | `file.ts` |
| Thumbnail | `GET https://thumbnails.ente.com/?fileID=` + auth header | `download.ts` |
| File download | `GET /files/download/{id}` (redirect/proxy) | `download.ts` |
| Trash file | trash APIs via `moveToTrash` | `collection.ts` |
| Add to favourites | `/collections/add-files` into favorites collection | `collection.ts` |

---

## Appendix — Suggested tag schema

Default recommendation: **Option B** (dedicated key). Run the M4 round-trip experiment before bulk-tagging a large library.

```typescript
// pubMagicMetadata.data
interface OrganizerMetadata {
  caption?: string;           // official field — leave alone unless user edits
  _organizer_v1?: {
    tags: string[];           // e.g. ["selfie", "vietnam", "compressed"]
    updatedAt: number;        // epoch μs — for conflict debugging
  };
}
```

Merge on write: `{ ...pubMagicMetadata.data, _organizer_v1: { ...existing, tags: newTags } }` with version check.

---

## Appendix — Agent handoff template

Copy into Agent Progress Report when ending a session:

```
Last updated: 2026-06-21
Last agent: Implemented M1 login + decryptStreamBytes tests; 12/12 crypto tests green
Current milestone: M1 (complete) → starting M2
Blockers: none
Next action: Wire EnteCore.login into mobileapp/src/pages/, add Zustand stores

M1 checklist: all items checked except CLI harness — see mobileapp/scripts/ente-cli.ts
Files touched: mobileapp/src/core/, mobileapp/src/stores/
How to run: cd mobileapp && npm run dev
```
