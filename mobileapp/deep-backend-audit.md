# Deep backend audit — reliability & performance

**Date:** 2026-09-11  
**Scope:** `mobileapp/` client deep layer (sync, outboxes, IDB, crypto, workers, `src/core/`). Upstream Ente Go `server/` is out of scope except where it defines APIs we should use.  
**Focus:** Reliability and performance. Code style is irrelevant unless it blocks coherence.

---

## Verdict

**Competent, not bulletproof.** More engineered than typical vibe code in the places that matter (sync races, trash, outbox overlays, favourite batching). Photo blobs on Ente’s servers are fine. Local mutations (tags, favourites, archive, crop/compress) are **eventually consistent** and can still be lost on hard tab kill or logout-during-debounce. At ~10k+ files the main cost is **full-library JSON stringify** plus **overlapping background job storms**.

There is no custom server. The load-bearing backend is client-side: `src/core/`, `src/lib/sync/`, mutation outboxes, `src/db/`, and workers.

**Shipped `0.3.158`:** incremental library IDB `fileShards` (fileId%64, dirty writes, monolith migrate). Gallery subscription split still open.

**Shipped `0.3.157`:** CLIP cross-device via `mldata` / `organizer_clip` (upload after embed flush, status-diff pull, local IDB cache).

**Shipped `0.3.156` (partial):** unified durable flush (any-outbox beforeunload + pagehide), logout/lock flush, 401→logout, favourite drain local patch + persist rollback, trash clears tag/visibility outboxes, pull-files visibility overlay, collection magic version +1, hard-pause background scans while gallery scrolling.

---

## What’s solid

| Area | Why |
|------|-----|
| Single-flight `syncRemote` | Overlapping bootstrap/drain/resync share one in-flight pull |
| Cursor ordering | Cursors advance only after encrypted files persist (`pull-files.ts`) — prevents truncated-library / early-skip |
| Tag merge-ahead + outbox overlays | Pull does not clobber in-flight organizer tags |
| Trash seeding | Seed trash before dropping from `allFiles`; re-exclude before commit |
| Favourite batch drain | Chunks of 100 with per-file fallback |
| Tag 409 → per-file fallback | Batch PUT then verify path |
| CLIP ORT init | WASM fp32 first so failed WebGPU cannot poison Transformers.js init |
| Thumbnail pipeline | Scroll-aware concurrency (8 idle / 3 fling), LRU budgets |
| Derived-replace queue | Coalesces rapid edits; in-flight guard against duplicate uploads |
| SRP auth | Faithful to Ente accounts (`checkM2`, zod, 2FA paths) |
| Upload retry | Idempotent PUT + finalize with 5xx/429/network retry |

---

## Findings — durability & sync

### High

1. **Tab-close persist is best-effort**  
   `pagehide` / `visibilitychange` handlers call `void flush…()` (tag outbox, favourite outbox, library cache). Browsers may kill the page before encrypt/IDB finishes. Favourites alone get a `beforeunload` prompt.

2. **Optimistic library vs outbox write race**  
   Tag edits update optimistic `allFiles` (debounced encrypt) and enqueue outbox (independent persist chain). Cache can land on disk with tags while outbox persist fails → reload looks tagged, sync wipes, no retry.

3. **Logout cancels debounced library save**  
   `library-store.reset()` calls `cancelScheduledEncryptedFilesSave()` (drops pending 1.5s debounce) instead of flush. Session reset then clears outboxes in memory. Edits in that window can vanish locally.

4. **No session invalidation on HTTP 401/403**  
   `ensureOk` throws plain errors. Expired/revoked tokens look like random sync failures. Restore never probes the server.

5. **In-place image upload is two-phase, non-atomic**  
   Rotate-in-place: `PUT /files/update` then separate public-metadata PUT. Second step failure leaves remote bytes updated with stale dims/tags. No rollback.

6. **Collection metadata local version not bumped after PUT**  
   File metadata bumps `version + 1` after success; collection metadata keeps the sent version. Organizer-config patches inherit this → next write can 409 / lose coalesced patches.

7. **Favourite intent dropped when outbox persist fails**  
   `setFileFavorite` catch clears pending UI but leaves optimistic star with no outbox entry and no toast.

### Medium

8. **Visibility + derived-replace outboxes lack pagehide flush**  
   Hard kill can lose archive / crop-replace retry intent (payload bytes may orphan).

9. **Trash does not clear tag/visibility outboxes**  
   Favourites are cleaned; tags/visibility leave stale rows that skip forever; restore may replay old intents.

10. **`pullFiles` disk snapshot ignores visibility outbox**  
    Mid-pull IDB write overlays tags only → cache can show wrong archive state until next full sync.

11. **Favourite drain triggers full `syncRemote`**  
    After any successful favourite batch → complete library pull + re-encrypt. Expensive and races with in-flight edits.

12. **Library encrypt-to-IDB failures swallowed**  
    Persist chain `.catch(() => undefined)` — no user signal, no retry.

13. **Bulk tag UI reports success before server ack**  
    Returns succeeded immediately after enqueue; drain failures toast later.

14. **`updatePublicMetadata` has no 409 retry**  
    Tags/visibility retry; rotate metadata path does a single PUT.

15. **`remapFavoriteOutboxFileId` misses hash-keyed entries**  
    Shared-file favourite intents can orphan after crop/compress replace.

16. **Authenticated API calls lack transient retry**  
    Uploads retry; sync/trash/favourites/collection ops use raw `authFetch` (except tag pipeline MetadataUpdateError path).

---

## Findings — performance & scale

### High / severe at 10k+ files

17. **Full-library `JSON.stringify` on main thread**  
    `encryptCachePayload` yields once then stringifies entire `EnteFile[]` before worker encrypt. Triggered by sync, trash, tag bursts, uploads.

18. **No global job concurrency budget**  
    Phash/quality (32 cached + 8 network), CLIP prefetch, gallery thumbs (8/3) can stack → decrypt pile-up, IDB contention, OOM.

19. **Embedding index fully in RAM**  
    Cold hydrate decrypts every CLIP chunk into `Map<fileId, number[]>`. ~20k × 512 floats ≈ 40MB+ raw + JS overhead.

### Medium

20. **Thumb/full decrypt on main thread**  
    `core/download.ts` imports `ente-base/crypto/libsodium` directly (not the crypto worker). Cache encrypt uses the worker; downloads do not.

21. **Full-file downloads: 1 attempt; thumbs: 4**  
    Edit/compress/viewer full loads fail more often under 429 / flaky mobile nets.

22. **Partial worker teardown on logout**  
    phash / CLIP / margins terminate; compress, image-quality, border-scan, relative-sort, ffmpeg can linger.

23. **`decryptFileChanges` unbounded `Promise.all`**  
    Large diff pages spike crypto/memory.

24. **`findFileById` rescans every collection from cursor 0**  
    O(collections × files) if ever used on a hot path.

25. **Derived-replace payload copies bytes**  
    Pending video edits: RAM override + IDB copy + upload — 2–3× file size peak.

26. **IDB write amplification on ciphertext cache hits**  
    LRU touch re-`put`s; thumbnail eviction can `getAll` + sort under pressure.

---

## Hot paths at 10k+ files

| Hot path | Risk |
|----------|------|
| `saveEncryptedFiles` / `loadEncryptedFiles` | UI freeze + memory spike |
| `rebuildFromFiles` every sync | O(files × tags) + tag-index encrypt |
| `hydrateEmbeddingIndex` | Full CLIP corpus in RAM |
| Outbox overlays during sync | Full array map copies 2–3× |
| Local media overrides + derived payloads | Large video OOM |

---

## If you keep vibe-coding — fix first

Ordered by reliability impact for a phone PWA that gets killed often:

1. **Unified flush barrier** on hide/logout — await outboxes + library encrypt together; logout must flush, not cancel.
2. **Never land optimistic library tags/favourites on disk without matching outbox** (or roll back optimistic state on persist failure).
3. **Stop full-library re-encrypt on every mutation** — incremental file rows or dirty-id patches.
4. **Global concurrency governor** across thumbs / phash / quality / CLIP.
5. pagehide + trash cleanup for visibility/derived; route download decrypt through crypto worker; 401 → lock session; bump collection metadata version; retry full-file downloads and auth API blips.

---

## CLIP / embedding cross-device sync — feasibility

### Current state

CLIP is **local-only**. Nothing is uploaded.

| Layer | Detail |
|-------|--------|
| Model | `Xenova/mobileclip_s2` (Transformers.js), 512-dim, L2-normalized |
| IDB | Encrypted chunks (`embeddingChunks`), 64 vectors/flush; meta in `embeddingIndex` |
| Encryption | Session cache key from master key (`deriveCacheKey`) |
| Videos | Not embedded |
| Tiles | Separate local store; research-only |

**Pain point confirmed:** every device / browser profile must rescan.

### Size math (approx)

| Form | Per file | 10k files | 100k files |
|------|----------|-----------|------------|
| float32 raw | 2 KB | ~20 MB | ~200 MB |
| float16 | 1 KB | ~10 MB | ~100 MB |
| int8 + scale | ~0.5 KB | ~5 MB | ~50 MB |
| gzip JSON in `mldata` | ~2–4 KB enc. | ~20–40 MB | ~200–400 MB |

### Options ranked

| Rank | Approach | Feasibility | Notes |
|------|----------|-------------|-------|
| **1** | **Ente `mldata` with a custom key** (e.g. `organizer_clip`) | **Yes — recommended** | Official Photos already syncs ML via `PUT /files/data` type `mldata`, encrypted with **file key**, gzip JSON, `status-diff` + fetch (≤200 IDs). Unknown top-level keys are preserved ([Note: Preserve unknown ML data fields]). Do **not** overwrite official `clip` / `face`. |
| **2** | Reuse official `clip` key | **Only if models align** | Ente ONNX MobileCLIP vs Xenova MobileCLIP-S2 — same 512 dims, **not interchangeable**. Adopting Ente’s pipeline would share compute with desktop Photos; kit nearness needs matching vectors. |
| **3** | `pubMagicMetadata` per file | **Maybe, tiny scale only** | Fits one vector per file; 100k writes + version conflicts with tags; wrong tool for corpus sync. |
| **4** | Album / `.organizer` collection magic | **No** | Config-sized JSON only; blows up for N×2KB vectors. |
| **5** | User entity / remote-store | **No without server changes** | Entity types whitelisted; remote-store is flag keys only. |
| **6** | Third-party S3/R2 | **Technically yes, product no** | Parallel sync, keys, E2EE, credentials — fights zero-knowledge “through Ente” architecture. |
| **7** | Legacy `/embeddings` API | **Dead** | Cleanup/cron only; no HTTP routes. |

### Recommended design sketch (`mldata`)

1. After scan (or incremental flush): merge into existing decrypted `mldata` raw JSON:

   ```json
   {
     "face": { "...": "leave untouched" },
     "clip": { "...": "leave untouched" },
     "organizer_clip": {
       "version": 1,
       "modelId": "Xenova/mobileclip_s2",
       "client": "mobileapp-pwa",
       "embedding": [ /* 512 floats */ ]
     }
   }
   ```

2. gzip → `putFileData(file, "mldata", bytes, lastUpdatedAt)`; honour 409 (re-fetch, merge, retry).

3. On hydrate / after file sync: `status-diff` cursor → fetch changed IDs → decrypt with `file.key` → if `modelId` matches, populate `embedding-index-store` (+ keep local IDB as cache).

4. Keep tile embeddings local unless quantized and sized carefully.

5. Optional later: switch inference to Ente’s ONNX MobileCLIP and write the official `clip` key instead — one scan shared with desktop Photos, but kit-nearness research would need re-validation.

**Privacy:** File-key encrypted derived data — same E2EE posture as official ML. No plaintext vectors leave the client.

**Complexity:** Medium — wire `ente-gallery/services/file-data` (or a thin core seam); add mldata sync cursor in IDB; upload after embedding job flushes; do not block gallery on network.

---

## Additional core findings (second pass)

Beyond the first durability/perf list:

| Sev | Finding | Path |
|-----|---------|------|
| High | No 401/403 → session lock | `core/api/http.ts`, `session-store.ts` |
| High | In-place rotate non-atomic (bytes then metadata) | `upload-image.ts`, `metadata.ts` |
| High | Collection magic version not bumped after success | `collection-metadata.ts` |
| High | Favourite persist failure leaves optimistic star | `library-store.ts` |
| Med | Full-file download no retry | `download.ts` |
| Med | Auth API no transient retry | `http.ts` vs `upload/remote.ts` |
| Med | Unbounded parallel decrypt on large diffs | `api/files.ts` |
| Med | `findFileById` full collection walk | `ente-core.ts` |
| Med | Critical-path test gaps (SRP, http, download, metadata 409, pull-files cursor, session lock) | `src/core/`, `lib/sync/` |

---

## Bottom line

- Coherent enough to keep vibe-coding on — seams are readable; several hard races were already fixed deliberately.
- Treat local mutations as durable only after outbox drain completes.
- Expect jank past ~10k files until persistence stops being whole-library.
- For CLIP pain: **use Ente `mldata` with a namespaced key**; skip pubMagicMetadata / album blobs / third-party cloud unless you have a strong reason.

Companion canvas (optional visual summary):  
`~/.cursor/projects/.../canvases/deep-backend-reliability-audit.canvas.tsx`

**Follow-up (UI / session / gallery):** see [`ui-and-session-audit.md`](./ui-and-session-audit.md) — cross-device session split, ghost-click root cause, tools chrome, gallery perf, UX sweep.

---

## Fix plans (every finding)

Legend: **Effort** S / M / L · **Owner choice** = needs your decision before coding.

### Durability & sync

#### 1. Tab-close persist is best-effort
**Plan:** Introduce `flushAllDurableState()` that awaits, in order: tag/favorite/visibility/derived outboxes → scheduled library encrypt → tag index if dirty. Call it from `pagehide` / `visibilitychange` with `event.waitUntil`-style best effort via kept Promise (browsers still may kill; pair with `beforeunload` when any outbox non-empty — extend favourite pattern). Prefer `navigator.storage.persist()` once after login (optional).

**Owner choice:** Warn on tab close whenever *any* outbox is non-empty (tags/archive/derived too), or keep warn only for favourites?

#### 2. Optimistic library vs outbox write race
**Plan:** Single write barrier per mutation: (a) enqueue outbox + await outbox IDB put, then (b) patch `allFiles` + schedule library save — **or** roll back optimistic patch if outbox persist throws. Never call `scheduleSaveEncryptedFiles` until outbox row exists. Same for tags + favourites.

**Owner choice:** Slightly slower tap→star/tag feel (await IDB ~1 frame) vs keep optimistic UI and only roll back on failure (can flicker)? Recommend: keep optimistic UI, await outbox, rollback+toast on failure.

#### 3. Logout cancels debounced library save
**Plan:** `reset()` / `clearMemoryState` must `await flushAllDurableState()` (or fire-and-await in logout path) **before** clearing outboxes / cache key. Replace `cancelScheduledEncryptedFilesSave` with flush. Lock can stay cancel-or-flush depending on product (see choice).

**Owner choice:** On **Lock**, flush pending edits then clear memory (safer), or discard local unsynced UI state (faster lock)? Recommend flush.

#### 4 / core. No 401/403 → session lock
**Plan:** In `ensureOk` / `authFetch`, on 401/403 call `session-store.lock()` (or dedicated `invalidateSession`) once, toast “Session expired — unlock to continue”, stop outbox runner. Don’t loop-logout on every parallel 401 (single-flight flag).

**Owner choice:** Soft **lock** (re-enter password / unlock) vs hard **logout** (wipe memory, keep encrypted session blob)? Recommend lock (matches idle lock UX).

#### 5. In-place rotate non-atomic
**Plan:** Prefer: metadata merge included in same remote update if API allows; else treat as saga — if metadata PUT fails after bytes PUT, enqueue derived/metadata repair outbox and toast “Rotation saved; metadata retrying”. Don’t claim success until both ok. Optional: skip in-place and keep replace-upload (you already moved to in-place for a reason).

**Owner choice:** Keep **in-place** with repair outbox, or revert rotate to **replace-upload** (simpler atomicity, new file id)? Recommend keep in-place + repair.

#### 6. Collection metadata version not bumped
**Plan:** After successful collection magic PUT, set local `version: sentVersion + 1` (mirror file metadata). Add 409 refetch-merge-retry to `organizer-config-save-queue` like tags.

No owner choice — clear bugfix.

#### 7. Favourite persist failure drops intent
**Plan:** On `upsertFavoriteOutboxEntry` catch: revert `applyOptimisticFavorite`, toast failure, do not only `removePending`. Mirror tag-outbox failure UX.

No owner choice.

#### 8. Visibility / derived-replace lack pagehide
**Plan:** Same listeners as tag/favorite outbox; include in `flushAllDurableState`. Derived: flush outbox meta + confirm payload bytes exist; if bytes missing, drop entry + toast.

No owner choice.

#### 9. Trash doesn’t clear tag/visibility outboxes
**Plan:** In `moveFilesToTrash`, also `removeTagOutboxEntries` / `removeVisibilityOutboxEntries` for those ids (parity with favourites). On restore from trash, do not replay deleted intents.

No owner choice.

#### 10. `pullFiles` disk snapshot ignores visibility
**Plan:** Mid-pull `saveEncryptedFiles` path: apply `applyOutboxVisibilityToFiles` as well as tags (same as `syncRemote` final commit).

No owner choice.

#### 11. Favourite drain → full `syncRemote`
**Plan:** After favourite batch success, patch local favourites collection / `favoriteFileIds` from response only; schedule lightweight reconcile or rely on next normal sync. Remove `syncRemote` from drain success path (or gate behind “favourites collection unknown”).

**Owner choice:** Accept slightly stale album membership until next sync, or keep full sync for correctness? Recommend local patch + next sync.

#### 12. Library encrypt failures swallowed
**Plan:** On persist catch: toast once (“Couldn’t save library cache”), set `libraryPersistError` flag, retry with backoff; don’t `.catch(() => undefined)` silently on the chain head.

No owner choice.

#### 13. Bulk tag UI reports success before ack
**Plan:** UI copy: “Queued” / pending badge until outbox drain removes entry; or return `{ queued: n }` and let caller toast “Saving…” then success/fail from runner (runner already toasts failures).

**Owner choice:** Change wording only, or block “done” until drain? Recommend wording + optional pending chip (don’t block UI).

#### 14. `updatePublicMetadata` no 409 retry
**Plan:** Copy `updateFileTags` / `updateFileVisibility` refetch loop (≤4) into `updatePublicMetadata`.

No owner choice.

#### 15. `remapFavoriteOutboxFileId` misses hash keys
**Plan:** Remap both string(fileId) and `fileHashAndTypeKey` entries when compress/crop replace runs; add unit test for shared-file path.

No owner choice.

#### 16. Auth API no transient retry
**Plan:** Extract `withAuthRetry` from upload retry (429/5xx/network + Retry-After); wrap `authFetch` for idempotent GETs and safe POSTs (trash/favourite/metadata already have their own paths — unify carefully). Skip non-idempotent one-shots unless documented safe.

**Owner choice:** Retry all museum calls by default, or allowlist (sync, trash, favourites, collections)? Recommend allowlist first.

---

### Performance & scale

#### 17. Full-library JSON stringify
**Plan:** Dirty-id set + IDB per-file (or shard) store; hydrate to in-memory `allFiles`; sync writes only diffs. One-shot migrate old monolith on next login (wipe-and-rebuild local cache OK per project rules).

**Owner choice:**
- **A)** Per-file IDB rows (simplest mentally, more IDB ops)
- **B)** Shards of ~500 files (fewer ops, slightly more complex)
- **C)** Defer entirely until after concurrency governor  
Recommend **B** after #18, or **A** if you want simplest code.

#### 18. No global job concurrency
**Plan:** `lib/io-budget.ts` shared semaphore; kinds `thumb | fullFile | backgroundScan`; scroll/viewer boost interactive; wire thumbnail-cache, download, similarity, quality, kit-embedding, PhotoViewer preload.

**Owner choice:** Hard-cap scans while scrolling (scans pause), or soft deprioritize (scans crawl)? Recommend hard pause on fling, soft otherwise.

#### 19. Embedding index fully in RAM
**Plan ladder:** (1) packed `Float32Array` instead of `number[]`, (2) lazy chunk load for current view/sort, (3) keep sync via mldata separately.

**Owner choice:** Memory packing only vs lazy load (more code, lower RAM)? Recommend packing first, lazy if still heavy at 20k+.

#### 20. Download decrypt on main thread
**Plan:** Switch `download.ts` to `ente-base/crypto` worker APIs (`decryptBlobBytes` via sharedWorker), matching cache encrypt. Watch Comlink transfer costs for large buffers (transferable ArrayBuffers).

No owner choice.

#### 21. Full-file download 1 attempt
**Plan:** Same retry helper as thumbs (4 attempts + Retry-After) in `fetchEncryptedFile`.

No owner choice.

#### 22. Partial worker teardown on logout
**Plan:** Extend `resetDependentStores` to terminate compress, image-quality, border-scan, relative-sort, ffmpeg (idle terminate already — force now).

No owner choice.

#### 23. Unbounded `decryptFileChanges`
**Plan:** Map with concurrency limit (e.g. 4–8) over diff page entries.

No owner choice.

#### 24. `findFileById` full walk
**Plan:** Prefer `library-store.getFileById` / local index; if remote needed, targeted API if available — else document “debug only” and assert not used from UI. Grep callers; fix any hot path.

No owner choice unless a caller needs remote-only lookup.

#### 25. Derived-replace byte copies
**Plan:** Avoid `bytes.slice()` when buffer is uniquely owned; single copy into IDB; clear RAM override after persist; cap concurrent large video edits (1).

**Owner choice:** Max concurrent pending video replaces (1 vs 2)? Recommend 1 on mobile.

#### 26. IDB LRU write amplification
**Plan:** Touch LRU in memory; flush eviction/order periodically (every N hits or on hide), not on every cache hit. Thumbnail eviction: maintain sorted structure or approx size counter instead of `getAll`+sort each time.

No owner choice.

---

### CLIP sync (product)

**Recommended default plan:** `mldata` key `organizer_clip` with Xenova model id; merge-preserve official `face`/`clip`; local IDB remains cache; upload after scan flush; pull via status-diff after file sync.

**Owner choices:**
1. **Ship `organizer_clip` mldata sync** now, or wait until local perf (#17/#18) is done?
2. Longer-term: **stay on Xenova** (duplicate compute vs desktop Photos) vs **switch to Ente ONNX MobileCLIP** (shared `clip` key, re-validate kit nearness)?
3. Upload **float32 gzip JSON** (simple, larger) vs **float16/int8** (more code, less bandwidth)?

---

### Suggested implement order (backend)

1. Unified flush + logout flush + outbox/library ordering (#1–3, #7–8)  
2. Collection version + 401 lock + favourite/visibility trash cleanup (#6, #4, #9)  
3. Global IO budget (#18)  
4. Auth/download retries + decrypt concurrency (#16, #21, #23, #20)  
5. Incremental library IDB (#17)  
6. CLIP mldata (after you pick choices above)  

