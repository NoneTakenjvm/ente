# Ente Photos — Custom Frontend Plan

## Agent Progress Report

> **Instructions for agents:** Update this section at the start and end of every work session. Do not skip it — the next agent depends on it.

| Field | Value |
|---|---|
| **Last updated** | 2026-09-08 |
| **Last agent / session** | Thumbnail scroll scheduling |
| **Current milestone** | Post-M8 UX |
| **Blockers** | Phone heap still limited — ffmpeg WASM + full video bytes are inherently heavy |
| **Next recommended action** | Hard-refresh `:3080` (preview left running) → Manage footer `0.3.61`; fling scroll in fit mode and confirm less hitching. |

**This session shipped:**
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
   - Dead-end exploration scripts removed (`crop-bench*`, `orb-cost*`); `@webarkit/purecv-wasm` dev-dependency dropped. Kept `crop-match-validate.ts` + `similarity-spike-real.ts` as reproducible regression harnesses.

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
- [x] Script authenticates against production (or self-hosted) API — `mobileapp/scripts/lib/auth.ts`
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

Outputs land in `mobileapp/scripts/output/` (gitignored). Crypto shim at `scripts/lib/crypto-shim.ts` redirects `ente-base/crypto` → libsodium for Node compatibility.

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
