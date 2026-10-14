# mobileapp simplification plan

**Status:** Phases 0–1 implemented locally (APP_VERSION 0.3.195, uncommitted); Phase 2 onward not started. Written 2026-10-14 against `ntphotos` @ `81946e8e48` (APP_VERSION 0.3.194).

**Purpose:** make `mobileapp/` smaller and easier to change safely, without changing what the app does. The work covers:
- removing duplicated mechanisms
- deleting dead and research code
- replacing hand-rolled helpers with the ones Ente packages already ship
- splitting oversized components

Each proposal comes from one of four review angles:
- **reuse:** an existing helper already does this
- **simplification:** derivable state, copy-paste, dead code
- **efficiency:** redundant I/O or sequential awaits
- **altitude:** a symptom is patched instead of the root cause

**How to use this doc:**
- Sections 1–6 are the detailed reviews, one per area. Proposals are numbered §N.M.
- This front part reconciles overlaps between sections and gives the order to implement in.
- Work top-down through the [roadmap](#roadmap) and tick boxes as PRs land.
- Line numbers are from the commit above and will drift. Re-grep before editing.

---

## At a glance

| Area | LOC today | Est. reduction | Section |
|---|---:|---:|---|
| `src/components/` | 20,433 | | §1, §2, §3 |
| `src/pages/` | 2,465 | | §2, §3.2 |
| `src/hooks/` | 2,822 | | §1 |
| `src/stores/` | 6,107 | | §3 |
| `src/lib/` | 24,922 | | §2, §4, §5 |
| `src/core/` + `src/db/` | 7,109 | | §4 |
| `src/workers/` | 1,939 | | §5 |
| **`src/` total (excl. tests)** | **65,873** | **≈ 12–15k (19–23%)** | |
| Tests | 10,845 | ≈ 0.7–1k | §6.2 |
| `scripts/` | 20,488 | ≈ 16–17.5k | §6.1 |
| Root audit docs | 1,073 | ≈ 1.1k (archive) | §6.5 |

Per-section `src/` estimates:

| Section | Est. reduction |
|---|---|
| §1 Viewer/editing | 1.9–2.3k |
| §2 Browse/tag-filter/pages | 2.0–2.6k |
| §3 Manage/stores | 1.9–2.4k |
| §4 Data/sync/tags | 2.8–3.3k |
| §5 Jobs/ML | 3.5–4k (2.4k of it is research code, deleted under §6) |
| §6 Dead src beyond §5 | about 0.3k |

The sections overlap in a few places (see [Reconciliations](#reconciliations)). Treat the lower bound as realistic.

**Overall:** about 30–34k fewer lines out of about 97k (src + tests + scripts), roughly a third. More than half of that is pure deletion in Phase 0.

**The six biggest problems, all areas combined:**
1. **Research code ships in, and alongside, the app.** About 17k LOC of scripts, 284 tsc errors, and about 2.4k LOC of eval and dHash code in `src/lib` that production never calls.
2. **One mechanism is copied N times instead of shared.** Examples:
   - outboxes (×5)
   - worker clients (×8)
   - job lifecycle in the UI (×7)
   - debounced persists (×3)
   - index stores (×3)
   - LRU blob stores (×2)
   - confirm dialogs (×10)
   - retry loops (×4)
   - tag-filter setters (×3)
3. **God components.** PhotoViewer (2,566), library-store (2,073), tag-store (1,435), TagScopeFilterDropdown (1,158), ManageTagsPanel (1,179), manage.tsx (1,013).
4. **Mutually exclusive flags instead of unions.** Eight ordering flags in ui-store, four tool-mode flags in selection-store, and six parallel sort states in the gallery.
5. **In-place mutation plus a revision counter** (`filesRevision`), which `useMemo` consumers miss.
6. **Wasted I/O.** Double flush on page-hide, a full outbox re-encrypt per enqueue, up to 24 PUTs per tag write, sequential IDB decrypts, and O(n²) favourite derives.

---

## Shared building blocks

Create these once, early, and point every later PR at them. Each one replaces three or more copies.

| Helper | Home | Replaces | Section |
|---|---|---|---|
| `plural(n, word)` | `lib/format.ts` | Inline `n === 1 ? … : …` ternaries across UI | §2 |
| `formatFileSize(bytes)` | `lib/format.ts` | 4 byte formatters | §1, §2, §3 |
| `errorMessage(e)` | `lib/format.ts` | 57 inline `e instanceof Error ? e.message : String(e)` | all |
| `ConfirmDialog` | `components/ConfirmDialog.tsx` | 5 Confirm modals + 5 inline AlertDialogs | §2.3 |
| `tagFilterActions(update)` | `lib/tag-filter-edit.ts` | 3 copies of the tag-filter setters | §2.1a = §1.5 = §3.5c |
| `useScopeCounts(files)` | `hooks/` + `countFileKinds` in lib | Counts computed twice and prop-drilled 4 levels | §2.1b = §3.10 = §4.5 |
| `createWorkerClient(url)` | `lib/worker-client.ts` | 8 hand-written postMessage clients | §5.2 |
| `job-utils.ts` + `useJob` / `<JobControls>` | lib + hooks | 7 job lifecycles and scan loops | §5.3 + §3.1 |
| `createOutbox<E>()` | `lib/outbox.ts` | 5 outbox skeletons | §4.1 |
| `loadKv<K>` / `saveKv<K>` | `db/kv.ts` | 14 load/save wrapper pairs | §4.2 |
| `createLruBlobStore()` | `db/blob-store.ts` | thumbnails + file-ciphertexts stores | §4.3 |
| `retryWithBackoff()` + `HTTPError` | `core/api/http.ts` | 4 retry loops, 2 Retry-After parsers | §4.4 |
| `createDebouncedPersist(write, ms)` | lib | 3 debounced-persist modules | §3.6 |
| `registerFlush` / `registerReset` | `lib/session-lifecycle.ts` | durable-flush hand list, 5 page-hide listeners, scattered session resets | §3.6 + §3.7 + §4.1 |
| `createIndexStore()` | stores | 3 identical index stores | §3.8 |
| `ordering` / `toolMode` unions | ui-store / selection-store | 8 + 4 boolean flags, 6 sort states | §3.9 = §5.6 |
| `sortFilesByScore(files, scoreOf, asc)` | lib | Per-kind sort functions | §5.6 |
| ente-utils / ente-base helpers | — | Local `batch`, `withTimeout`, `wait` ×7, byte concat, `splitByPredicate` | §4.9, §5.7 |
| Test fixtures (`src/test-utils/`) | tests | 12 `stubFile` variants and more | §6.2 |
| `scripts/e2e/lib.ts` | scripts | `BASE` ×14, `signIn` ×13, `assert` ×10 | §6.1 |

---

## Reconciliations

Several sections reached the same proposal from different directions. This is the single decision for each.

1. **Research code: delete it, don't move it.** §5.1 proposes moving eval and dHash code into `scripts/lib/`, while §6.1 deletes the research scripts that are its only consumers. Do §6: delete both, and keep the conclusions in `docs/research/kit-nearness-s2-research.md` with the deleting commit's SHA. Fall back to §5.1's move only for a script the owner explicitly wants to keep.
2. **Tag-filter actions.** §1.5, §2.1a and §3.5c are one change. Implement it once in §2.1a, and have the §4.5 `setTagFilterScopes` / §3.5d `patchFilter` helpers live in the same `lib/tag-filter-edit.ts`.
3. **Scope counts.** §2.1b (hook), §3.10 (panel usage) and §4.5 (single-pass `countFileKinds`) are one change. Do the lib part (§4.5) first.
4. **Ordering.** §3.9 (ui-store union) and §5.6 (gallery-ordering registry plus `sortFilesByScore`) are one change, in one PR.
5. **Page-hide flush and session reset.** §3.6, §3.7 and §4.1 each propose a registry. Use one small `lib/session-lifecycle.ts` with:
   - `registerFlush(fn)`: one pagehide/visibilitychange listener; outboxes and debounced persists register here, which replaces durable-flush's hand list;
   - `registerReset(fn)`: called on logout or site wipe.

   Delete every per-module page-hide listener.
6. **Tag rewrites.** §3.3c/§3.5 (`applyTagRewrite` in the store) and §4.7 (delete tag-batch, add `queueTagMutation` in tag-outbox) form one path: store `rewriteTags` → `queueTagMutation`. Do them in one PR.
7. **Outbox runner context.** §1's hook finding (move the 250-line context out of `use-library-bootstrap`) and §4.7 are one change.
8. **Manage router.** §2.5 is fully covered by §3.2.
9. **Jobs.** §5.3 (lib loops) comes before §3.1 (`useJob` UI hook); §3.1 consumes it.
10. **`resetDerivedReplaceQueueForTests`.** §4 lists it as dead; §6.3 says keep it. **Keep it.** It resets module-level state for tests and has no public-API equivalent. Delete `LruTouchCoalescer.hasPending` with §4.3, since the blob store makes it internal.
11. **Copy-on-write file patches (§3.4)** are a prerequisite for removing the gallery remap and the `baseFilesKey` workaround (§2 findings). Land §3.4 before them.
12. **dbVersion bumps.** §4.3 (thumbnail ArrayBuffer), §4.6 (legacy shims) and §6.4 (drop the tile-embeddings store) each need one. Batch them into a single bump where the phases allow. Each is a cache clear or one-time re-pull, not a migration.

---

## Open decisions (owner)

| # | Decision | Recommendation | Affects |
|---|---|---|---|
| D1 | Delete the research scripts and eval code, or keep some? | Delete all; keep the research doc. | §5.1, §6.1, §6.3 |
| D2 | Retire the corpus-export and tile-scan dev features in ManageSettingsPanel? | Retire (pass6 said do not ship tiles). −0.8k src. | §5.1, §6.4, §4.3 |
| D3 | Drop the tag-write verify-refetch (`attemptWriteAndVerify`)? | Drop. First check `git log -S attemptWriteAndVerify` for the bug it was added for, and make sure `retryOnConflict` covers it. | §4.4 |
| D4 | Drop the `bytesBase64` derived-replace shim now? | Not yet. Ship one build that drains, confirm the derived-replace outbox is empty on the phone, then delete it. Every other shim in §4.6 can go now. | §4.6 |
| D5 | Replace react-image-crop with the shared crop UI? | Defer to the end, and only after §1.2. | §1.6 |
| D6 | One-shot e2e smokes: merge into one suite or delete? | Merge the four with lasting invariants (upload, recents, thumbnail-memory, durability) and delete the rest. | §6.1 |
| D7 | `m0-spike.ts`: is M0 done? | If yes, delete it along with `ente-core.ts`'s script-only methods (§4.9). | §6.1, §4.9 |
| D8 | ⚠️ Rotate the committed test-account password and move it to `.env.local`. | Do this regardless. | §6.5 |

---

## Guardrails

**Crypto- and metadata-sensitive code: change only the call sites, byte for byte.**
- The `pubMagicMetadata` spread-merge `{ ...file.pubMagicMetadata?.data, ...updates }`, and its merge order.
- `pubMagicVersionForPut`, and setting the local version to sent+1 after a successful PUT.
- `retryOnConflict` (`core/metadata.ts`): refetch → decrypt → re-merge → PUT on 409.
- The private `magicMetadata.data` spread in the visibility overlay.
- `mergeAheadOrganizerTags` / `copyAheadOrganizerTags` in tag-outbox.
- `encryptCachePayload` / `decryptCachePayload` and the session cacheKey (`db/crypto.ts`). Every blob-store and kv refactor keeps at-rest encryption.
- The persisted embedding index format (§5.8 changes transport only).

**Behavioural invariants to preserve:**
- Outbox ack-if-unchanged (the `enqueuedAt` compare) and remap.
- Two-writer safety with the official Ente app.
- Favourites are a collection, not a flag.
- Eviction never does `getAll` on ciphertexts (guarded by `e2e-thumbnail-memory`).

**Process rules:**
- **No shims.** Removed formats get a dbVersion bump and a cache clear or re-pull, never a dual-format loader. D4 is the one exception.
- **No logging** of keys, tokens, decrypted bytes or metadata payloads in any new helper (`errorMessage`, `retryWithBackoff` and the outbox labels included).
- **One concern per PR.** Don't fold unrelated cleanups into a structural PR. The diff should be reviewable in one sitting.

---

## Verification

**Every PR** (from `mobileapp/`):

```sh
npm run lint
npm run build
npm test            # vitest, includes src/core/__tests__ crypto + outbox/metadata suites
```

**Additional checks by PR type:**
- **Crypto/metadata PRs** (§4.1, §4.2, §4.3, §4.4, §4.8): also write or adjust tests for the moved code in the same PR. Do not loosen an existing assertion to make it pass.
- **Deleting scripts:** `npx tsc -p scripts/tsconfig.json` should report only errors in scripts still awaiting deletion, and zero by the end of Phase 0.
- **Shippable `src/` changes:** bump `APP_VERSION` in `src/lib/app-version.ts` (once per batch), then do phone QA of the touched flows. Docs-only and scripts-only PRs need no bump.
- **Tracking:** a dev-only `knip` run (§6.3) after Phase 0 confirms no new dead exports have appeared.

---

## Roadmap

Each phase leaves the app shippable. Phases 0–1 are mostly independent PRs that can run in parallel. Phases 2–4 are ordered by the dependencies noted.

### Phase 0: Delete (low risk, about 20k lines)
- [x] §6.1 Delete the research, GA, debug and probe scripts; move the research doc to `docs/research/`; fix the stale new-frontend.md links; remove the empty `scripts/lib/`.
- [x] §6.3 + §5.1 (as delete) Delete the eval files, the dHash block in kit-nearness-sort, `global-electron.d.ts` and the test-only exports. §6.2 deletes the matching tests.
- [x] §6.2 Retarget the similarity-groups tests to the production stage-1 path, then delete the sync facade (§5.5 part 1).
- [x] §6.4 Retire corpus export and the tile pilot (if D2 is approved).
- [x] §4 dead-code list, plus the dead-code lists at the end of §1, §2, §3 and §5.
- [x] §4.6 Legacy shims, except `bytesBase64` (D4), with one dbVersion bump.
- [x] §6.5 Remove `@ffmpeg/util` and `vaul`; move `shadcn` to devDependencies; archive the root audit docs; remove the unused CSS tokens; resolve `skills-lock.json`.
- [x] §6.5 / D8 Rename `test-account.tsx` → `.ts`, read credentials from env, rotate the password.

### Phase 1: Shared helpers and mechanical tidy-ups (low risk)
- [x] `lib/format.ts`: `plural`, `formatFileSize`, `errorMessage`.
- [x] §2.3 `ConfirmDialog`.
- [x] §4.9 + §5.7 Use ente-utils/ente-base helpers; shared PRNG, vector and format-detection helpers.
- [x] §1.4 Remove redundant type annotations.
- [x] Un-export internal-only symbols (§4 and §6.3 lists).
- [x] §6.2 `src/test-utils/` fixtures; §6.1 `scripts/e2e/lib.ts` and the consolidated smoke suite (D6).
- [x] §4.2 Typed kv.

### Phase 2: Data-layer mechanisms (medium risk, crypto-adjacent; run the full test suite)
- [ ] §4.1 + §3.6 + §3.7 `createOutbox`, `createDebouncedPersist`, `session-lifecycle` registries (Reconciliation 5).
- [ ] §4.4 + §4.8 `HTTPError`, `retryWithBackoff`, the two-layer tag write, `putMetadata` / `encryptPubMagic`, and the core→lib layering fix (D3).
- [ ] §4.3 `createLruBlobStore`, with thumbnails stored as ArrayBuffer (dbVersion bump).
- [ ] §4.7 + §3.3c `outbox-runner`, delete tag-batch, `queueTagMutation` (Reconciliation 6), and move the runner context out of the bootstrap hook.
- [ ] §4.5 `SCOPES` table, the tag-filter `ctx` and single-pass counts; split tags.ts into tags.ts and tag-filter.ts.
- [ ] Remaining §4 findings: sequential→parallel IDB work, favourite derive, pull-files batching, and view-sessions aggregates.

### Phase 3: Stores and jobs (medium risk)
- [ ] §3.4 Copy-on-write file patches; drop `filesRevision`; then remove the §2 gallery-remap and `baseFilesKey` workarounds.
- [ ] §3.3 library-store cleanup (dead actions, single-file twins, one remove-files path).
- [ ] §3.5 tag-store `typeConfig`, one rewrite path, filter-tree helpers moved to lib (with §2.1a).
- [ ] §3.8 Index-store factory.
- [ ] §3.9 + §5.6 `ordering` / `toolMode` unions and `sortFilesByScore`.
- [ ] §5.2 `createWorkerClient`, one worker at a time, starting with relative-sort.
- [ ] §5.3 then §3.1: `job-utils.ts`, then `useJob` / `<JobControls>`; delete `usePhashJobStore` and `useCompressJobStore`.
- [ ] §5.5 Collapse the remaining stage-1 twins. §5.4 Merge the phash and quality scans. §5.8 CLIP transport.

### Phase 4: UI structure (medium risk; phone QA each PR)
- [ ] §3.2 (= §2.5) manage.tsx becomes a router; add `ManageDuplicatesPanel` and `ManageSimilarPanel`; §3.10 shared panel pieces.
- [ ] §2.1b–f Collapse the tag-filter family (9 files → 5), in the order given in §2.1.
- [ ] §2.2 Shared grid marquee and scroll; delete the fake masonry.
- [ ] §2.4 Shared media view, `useLibraryFiles` and the session gate in AppShell; §2.7 one `ensureSessionRestored`; §2.8 one list-card shell.
- [ ] §1.3 + §1.7 `PendingBatchFooter`, `ToolFooter` shell, and one busy state in SelectionActionFooter.
- [ ] §1.2 `MediaEditorOverlay` (merge Crop and Video).
- [ ] §1.1 PhotoViewer: dedupe first (echo loop, `loadMediaBytesForEdit`), then split by concern.
- [ ] §2.6 Move upload orchestration out of UploadPanel.

### Phase 5: Optional
- [ ] §1.6 Drop react-image-crop (D5).
- [ ] Add `knip` and `typecheck:scripts` to CI, so CI runs more than `npm run build`.

---

## Contents

1. [Viewer and editing UI](#1-viewer-and-editing-ui)
2. [Browse, tag-filter, grid UI and pages](#2-browse-tag-filter-grid-ui-and-pages)
3. [Manage panels and state stores](#3-manage-panels-and-state-stores)
4. [Data, sync, persistence and tags layer](#4-data-sync-persistence-and-tags-layer)
5. [Background jobs, ML and media processing](#5-background-jobs-ml-and-media-processing)
6. [Scripts, tests, dead code and repo hygiene](#6-scripts-tests-dead-code-and-repo-hygiene)

---

## 1. Viewer and editing UI

Scope: PhotoViewer, the editor overlays, the tool footers, `src/hooks/` and the edit/media libs.

**Current size:** about 11,300 LOC in scope.
- PhotoViewer: 2566
- Editor overlays: 1353
- Footers and controls: 1597
- `src/hooks/`: 2822
- Edit and media libs: about 3000, of which crop-editor is 719 and crop-match is 627

**Main problems:**
- PhotoViewer is one component that does seven jobs:
  - slide loading
  - the video cache
  - gestures, including three separate double-tap mechanisms
  - chrome auto-hide
  - tag drafts
  - edit save/revert
  - a debug overlay
- It also keeps a prop-echo loop with its parents.
- CropEditorOverlay and VideoEditorOverlay are about 70% the same code.
- CropToolFooter and RotateToolFooter are about 90% the same code.
- The hooks carry heavy redundant type annotations. The `typedef` lint rule is off for `src/hooks/**`, `src/lib/**` and `*.tsx`.
- Bytes→blob and "load bytes for file" logic is re-implemented in 4–5 places, even though `lib/load-media-bytes.ts` already exists.

**Achievable reduction:** about 1,900–2,300 LOC (about 18–20%) without changing behaviour. A further 150–250 LOC is possible if the full crop editor drops react-image-crop (1.6).

### Structural proposals (biggest wins first)

**1.1 Shrink PhotoViewer by deduping, then split by concern.**
- **What (dedupe first):**
  - Remove the `initialIndex`/`initialFileId` echo loop (see the echo-loop finding below).
  - Route all slide loads through `loadMediaBytesForEdit(file, onProgress, signal)`.
  - Add one `setSlideUrl(fileId, url, byteSize)` helper.
  - Replace the three tap mechanisms with one pointer tap recognizer.
  - Replace the about 12 `resetChromeTimer()` calls with one root `onPointerDownCapture`.
  - Merge `handleEditSaved` and `handleRevertLastEdit`.
  - Delete the debug overlay.
- **What (then split):**
  - `useSlideMedia` for the load effect, preload window and URL ownership (about 816–1146).
  - `useViewerGestures` for carousel, dismiss and tap (about 1397–1603).
  - `ViewerChrome` for the JSX (2152–2553).
  - `useViewerTagDraft` (1651–1771).
  - PhotoViewer itself stays as the orchestrator, at about 600 LOC.
- **Why:** most of the 2566 lines are copies of the same thing, and once those copies are gone the remaining pieces are separate concerns.
- **Files:** `src/components/PhotoViewer.tsx`, `src/lib/load-media-bytes.ts`, `src/pages/gallery.tsx`, `src/components/FilteredMediaView.tsx`, `src/pages/recents.tsx`
- **Est. saved:** about 500–550 LOC. The split itself is LOC-neutral, but it makes the remaining code reviewable.
- **Risk:** medium. Gestures and load are timing-sensitive.
- **Order:** 1st. Do the dedupe before the split.

**1.2 Merge CropEditorOverlay and VideoEditorOverlay into one `MediaEditorOverlay`.**
- **What's shared:** these blocks are copy-paste:
  - mount/file refs: Crop 89–101, Video 101–113
  - load effect: Crop 103–136, Video 115–148
  - ResizeObserver workspace: 138–158 / 150–170
  - `replaceWorking*`: 160–177 / 172–197
  - `applyDisplayLayout`: 179–205 / 199–224
  - rotate handler: 225–255 / 274–325
  - Escape handler: 295–305 / 444–454
  - Cancel/Save header: 352–377 / 495–522
  - error Alert, loading block, ReactCrop workspace: 379–458 / 529–605
  - rotate buttons: 471–492 / 639–660
- **What differs:**
  - `<img>` vs `<video>`
  - the rotate/save implementations (two functions passed in)
  - the image-only lock-aspect checkbox
  - the video-only trim slider and progress bar
- **Why:** the same fix currently has to be made twice.
- **Files:** `src/components/CropEditorOverlay.tsx`, `src/components/VideoEditorOverlay.tsx`, and PhotoViewer 2514–2527, where the two branches are also near-identical.
- **Est. saved:** about 350 LOC.
- **Risk:** low–medium.
- **Order:** 2nd.

**1.3 One batch-tool footer, plus a footer shell.**
- **What:**
  - CropToolFooter and RotateToolFooter match line for line: store wiring, `pendingEntries` memo, exit/discard/apply, the `mapBatched` progress-toast loop (Crop 64–119, Rotate 64–115) and the JSX (Crop 125–169, Rotate 121–165).
  - Make one `PendingBatchFooter({ icon, hint, verb, entries, applyOne, concurrency, busy, setBusy, close, discard })`.
  - The footer chrome class `fixed inset-x-0 bottom-0 z-30 ... backdrop-blur` is repeated 5 times (Crop 126, Rotate 122, Stamp 144, Selection 376/394). Extract a `ToolFooter` wrapper with a title row and an actions slot.
- **Pairs with:** §3.9 (selection-store `mode` union), which removes the per-tool active/busy flags these footers read.
- **Files:** `src/components/CropToolFooter.tsx`, `src/components/RotateToolFooter.tsx`, `src/components/StampToolFooter.tsx`, `src/components/SelectionActionFooter.tsx`
- **Est. saved:** about 150 LOC, plus about 60 from 1.7.
- **Risk:** low.
- **Order:** 3rd.

**1.4 Strip the type-annotation noise from hooks and libs.**
- **What:** remove the explicit function-type and tuple annotations, which the lint config does not require. Examples:
  - `const clamp: (value: number, ...) => number = (...)`
  - `const [translateX, setTranslateX]: [number, Dispatch<...>] = useState(...)`
  - `const vv: VisualViewport | null = ...`
- **Rule to keep:** AGENTS.md still asks for explicit types on exported signatures and on non-obvious locals. Strip only the obvious local ones.
- **Files:** `src/hooks/use-pinch-zoom.ts`, `src/hooks/use-library-bootstrap.ts`, `src/hooks/use-tag-filter-draft.ts`, `src/hooks/use-visual-viewport-sheet-layout.ts`, `src/hooks/use-coarse-pointer.ts`, `src/hooks/use-media-display-pipeline.ts`
- **Est. saved:** about 250 LOC.
- **Risk:** low. This is mechanical, and tsc catches mistakes.
- **Order:** can run in parallel with everything else.

**1.5 Collapse the tag-filter setter triplication.** Same change as §2.1a: one `tagFilterActions(update)` builder in lib, used by `use-tag-filter-draft.ts` (15 near-identical `useCallback`s from line 60), `tag-store.ts` (~735–850) and `use-tag-filter-binding.ts`.
- **Est. saved:** about 250 LOC across the three files. This is counted once, under §2.

**1.6 (Optional) A single crop UI.**
- **What:** QuickCropOverlay already has a normalized crop box (`dragCropRect`, `containedBox` in crop-draft.ts). Using it for the full editor would remove react-image-crop, its CSS, `maxAspectRatioCrop` (react-image-crop `Crop` type) and the `convertToPixelCrop` plumbing in both overlays.
- **Est. saved:** about 150–250 LOC, plus one dependency.
- **Risk:** high. Lock-aspect and handle UX need re-implementing.
- **Order:** last, and only if 1.2 lands first.

**1.7 SelectionActionFooter: one busy state, toast for errors.**
- **What:**
  - Four booleans (`tagBusy`, `favoriteBusy`, `archiveBusy`, `trashBusy`, lines 67–72) are only ever OR-ed at 369. Replace them with `busy?: "tag" | "favorite" | "archive" | "trash"`.
  - `handleFavorite`, `handleArchive` and `handleTrash` (297–362) share one shape: `runAction(kind, task, failText)`.
  - Footer chip writes set `tagError` (runTagAction 141–159), but that error only renders inside the TagPickerSheet (567), and `openTagSheet` clears it (199). So chip failures are silent. Use `toast.error` like the other actions do.
- **Est. saved:** about 60 LOC.
- **Risk:** low.
- **Order:** with 1.3.

### Findings

**PhotoViewer**

- `PhotoViewer.tsx:168–227` — reuse — `formatDownloadBytes` is the fourth byte formatter. The others are `formatFileSize` (lib/compress.ts:50), `formatBytes` (pages/manage.tsx:99) and `formatBytesShort` (memory-probe.ts:55); ente has `formattedByteSize` in web/packages/gallery/utils/units.ts:29. → Use `formatFileSize` (~25).
- `PhotoViewer.tsx:356–369` — reuse — local `useThumbnailEntry` duplicates the exported one in components/albums/AlbumCoverThumb.tsx:21. ThumbnailCell.tsx:117 also subscribes inline. → One shared hook (§2.8) (~25).
- `PhotoViewer.tsx:551–556, 595–603, 700–726, 2554–2566` (echo loop) — altitude — `viewerFileIdRef`, `appliedInitialIndexRef`, the initial-prop sync effect and `notifyFileUpdated` exist only to absorb an echo. `handleFileUpdated` in gallery.tsx:306 and FilteredMediaView.tsx:87 just writes the id the viewer reported back into `initialFileId`, and `viewerFileId` is used for nothing else (gallery.tsx:235–239, 349–352). → Make `initialIndex`/`initialFileId` mount-only, and delete `onFileUpdated`, both parents' `handleFileUpdated`, the sync effect and the custom memo comparator. Also drop the 7 `notifyFileUpdated` calls (1665, 1800, 1828, 1846, 1939, 1950, 2003) (~70).
- `PhotoViewer.tsx:728–733` — simplify — the effect checks `sessionFiles.some(e => e.id === file.id)`. Since `file = sessionFiles[currentIndex]`, this is always true. → Delete (6).
- `PhotoViewer.tsx:512, 752–767, 2394–2410` — simplify — the "Image WxH / Viewport" debug overlay has its own resize/visualViewport listeners and is always shown with the chrome. → Delete, or gate it behind the dev flags (~40).
- `PhotoViewer.tsx:780–782, 1178` — dead — `goToIndexRef` is assigned but never read. → Delete (5).
- `PhotoViewer.tsx:800–804 vs 1148–1176` — simplify — the file-change effect and `goToIndex` both reset zoom and `setCarouselDragPx(0)`. → Keep the effect only (~6).
- `PhotoViewer.tsx:806–814, 2053–2063` + `use-pinch-zoom.ts:217` — altitude — pan bounds are pushed from two places in the viewer (`updatePanBounds` plus `pinchLayoutRef` writes), and the hook also pulls them in `syncBoundsFromLayout`. → Let the hook own the bounds from `layoutRef` on scale change, and delete the viewer-side pushes (~20).
- `PhotoViewer.tsx:1016–1076` — reuse — the override branch duplicates `startNetworkLoad` (865–987). Lines 932–940 are a hand-rolled copy of `loadMediaBytesForEdit` (override → `loadCachedVideoBytes` → `getDecryptedFile`). → Add `signal` to `lib/load-media-bytes.ts:12` and call it for every slide (~60).
- `PhotoViewer.tsx:957–963, 1035–1044, 1817–1821, 1922–1927` — reuse, efficiency — the bytes→blob conversion (video `blobFromUint8Array`, image `toRenderableImageBlob`) is repeated four times. 1818 and 1924 use `new Blob([Uint8Array.from(bytes)])`, which copies the whole file; `bytes-blob.ts` exists to avoid exactly that copy. → One `slideBlob(file, bytes)` helper (~25).
- `PhotoViewer.tsx:970–975, 1050–1065, 1085–1093, 1812–1826, 1921–1934` — simplify — "revoke previous URL, set `mediaUrlsRef`, set byte size, set slide ready" is repeated 5 times. → `setSlideUrl(fileId, url, size)` (~40).
- `PhotoViewer.tsx:837–847` — simplify — `clearLoadingState` near-duplicates the module-level `withoutSlideMedia` (343–353). → Use the latter (10).
- `PhotoViewer.tsx:252, 527–534, 1203–1221, 1486–1603, 2366–2377` — altitude — double-tap is detected three ways: `mediaTapCountRef` on pointer, `lastTouchTapRef` on `touchend`, and `onDoubleClick` with `TOUCH_DOUBLE_TAP_DEDUPE_MS`. `skipChromeTapRef` arbitrates between them. → One pointerup-based tap recognizer that tracks time and distance and emits single or double, and drop `onDoubleClick` and the touchend path (~80).
- `PhotoViewer.tsx:1203–1261` + 12 call sites (1239, 1255, 1415, 1512, 1620, 2173–2341, 2374, 2448) — altitude — every button calls `resetChromeTimer()`. → A single `onPointerDownCapture={resetChromeTimer}` on the viewer root (~35).
- `PhotoViewer.tsx:1517–1529` — simplify — `registerPointer` cross-feeds the carousel's pointer into the zoom hook. → Move it into the `useViewerGestures` split (1.1).
- `PhotoViewer.tsx:563, 1675–1766` — simplify — `stagedTagsRef` mirrors the `stagedTags` state. → Use a functional `setStagedTags` and read the ref only in the flush (~10).
- `PhotoViewer.tsx:1806–1867, 1902–1960` — reuse — `handleEditSaved` and `handleRevertLastEdit` both do "optimistic bytes → install URL → finalize → on error revert to the store file", and their catch blocks (1837–1853, 1944–1955) are copies. → `applyDerivedEdit(result, label)` (~50).
- `PhotoViewer.tsx:1838, 1945` — reuse — `useLibraryStore.getState().allFiles.find(...)`, while 1662 already uses `getFileById`. → `getFileById` (4).
- `PhotoViewer.tsx:498–499, 506, 1869–1900, 2484–2493` — simplify — favourite and delete errors use inline Alert state; archive and revert use `toast`. → Toast for all, and delete `favoriteError`/`deleteError` (~25).
- `PhotoViewer.tsx:498, 2241` — simplify — local `favoriteBusy` sits beside the store's `favoritePending` in the same `disabled` check. → Keep the store flag (~8).
- `PhotoViewer.tsx:337` — reuse — `errorMessage(error, fallback)` exists here, while `x instanceof Error ? x.message : "..."` is inlined 57 times in src. The scope files include SelectionActionFooter ×5 and both editor overlays ×2. → Move the helper to `src/lib/utils.ts` and use it everywhere (~3 LOC per site, ~150 total).
- `PhotoViewer.tsx:2152–2553` — simplify — `!readOnly ? ... : null` is repeated about 8 times. → Render the edit cluster in one `readOnly ? null : <>...</>` block (~15).

**Editor overlays**

- `CropEditorOverlay.tsx:103–136` — efficiency, altitude — the full editor re-loads and decrypts bytes the viewer already holds. It also builds its preview with `blobFromUint8Array(bytes, mimeTypeForFile(file))`, not `toRenderableImageBlob`, so HEIC and live photos open in the editor un-renderable on Chrome. → Pass the viewer's `{ bytes, url }` in as props and keep `loadMediaBytesForEdit` only as a fallback (~30, plus one fewer decrypt).
- `CropEditorOverlay.tsx:236–241`, `VideoEditorOverlay.tsx:294–297` — simplify — `if (!mountedRef.current)` is checked in `.then()` and again inside `replaceWorking*`. → Keep one (4).
- `VideoEditorOverlay.tsx:16, 50` — simplify — `VideoSaveResult` is an alias of `CropSaveResult`, imported from a sibling component. → Rename it to `EditSaveResult`, move it to lib, and use it directly (3).
- `VideoEditorOverlay.tsx:17` — reuse — `formatTime` is imported from VideoPlaybackControls. → Move it to `src/lib/utils.ts` next to the shared byte formatter (0 LOC, removes a component→component import).

**Footers and controls**

- `CropToolFooter.tsx:182–203` — reuse, efficiency — `cropFile` uses `allFiles.find` instead of `getFileById` and hand-rolls `override ?? getDecryptedFile`, which is `loadMediaBytesForEdit`. It then decodes the image three times: `toRenderableImageBlob`, then `createImageBitmap` just for its dimensions, then `encodeCroppedJpeg`. → Use `loadMediaBytesForEdit`, and let `encodeCroppedJpeg` accept normalized rects and resolve the size from its own decode (~12, plus two decodes per file).
- `StampToolFooter.tsx:66–78` — reuse — `rankedKits` is a copy of `rankPresetsByMatchCount(presets, allFiles)` from `lib/tag-presets.ts:251`. → Call it (~12).
- `StampToolFooter.tsx:33–38` — reuse — `tagsMatchPreset` re-implements a set compare that `tagSetKey` (tag-presets.ts:282) already provides. → `tagSetKey(tags) === tagSetKey(preset.tags)`, or export a single `sameTagSet` from tag-presets (5).
- `StampToolFooter.tsx:90–101`, `SelectionActionFooter.tsx:114–125` — reuse — the same "dedupe pinned + recent, slice to 16" `workingSetTags` block appears in both. → `workingSetTags(...lists)` in tag-presets or the tag-speed-store (~10).
- `StampToolFooter.tsx:151–324` — simplify — a three-level nested ternary (expanded → activeKit → pickMode → empty) at 8–12 indent levels. → Early-return subcomponents `KitList` / `TagChips` (~30, mostly indentation).
- `VideoPlaybackControls.tsx:78–130` — efficiency — the effect lists `scrubbing` as a dependency only for the `timeupdate` guard. Every scrub start/stop therefore re-attaches 5 listeners and re-runs the rAF metadata sync. → Read a `scrubbingRef` in `onTimeUpdate` and drop the dependency.
- `VideoPlaybackControls.tsx:88–90 vs 132–141` — simplify — `video.muted` and the volume fallback are set in two effects. → Keep the muted effect only (4).
- `VideoPlaybackControls.tsx:55–57` — altitude — every mount calls `hydrate()` on the playback store. → Hydrate once at store creation or app boot (3).
- `DisablePagePinchZoom.tsx:9–35` — simplify — a null-rendering component used only by `_app.tsx`.
  - The three add/remove pairs can be a loop over `["gesturestart", "gesturechange", "gestureend"]`.
  - `return (): void => undefined` can be a bare `return`.
  - → Turn it into a `usePreventPagePinch()` call in `_app` (~12).

**Hooks**

- `use-pinch-zoom.ts:28, 135, 158–162, 170, 251, 261, 320–327, 379, 461` — dead — `onPanRelease` and its edge-overflow accumulator are never passed (the only call is PhotoViewer 785–788). → Delete (~25).
- `use-pinch-zoom.ts:34–36, 553–557` — simplify — `translateX`, `translateY` and `transitionEnabled` are returned, but callers only use `transformStyle`. → Drop them from `PinchZoomState` (5).
- `use-pinch-zoom.ts:63–99` — reuse — `getObjectContainSize` is the third copy of the contain-fit math. The others are `containedBox` (crop-draft.ts:51) and `containedDisplaySize` (crop-editor.ts:40). → Keep `containedBox` and derive the other two (~40).
- `use-pinch-zoom.ts:468–484` — simplify — `onPointerUp` repeats `releasePointer` (332–344). → `onPointerUp = (e) => releasePointer(e.pointerId)` (~12).
- `use-pinch-zoom.ts` (11 sites: 219, 226, 291, 307, 324, 355, 427, 505, 533, …) — simplify — the magic number `1.01` is repeated. → `const ZOOMED = 1.01` or an `isZoomed(scale)` helper.
- `use-media-display-pipeline.ts:160–166, 234–240, 321–325, 340–344` — simplify — the filter-options object is built four times. → One `useMemo` (~15).
- `use-media-display-pipeline.ts:313–327` — efficiency — `computeVisibleFiles` re-filters, although the `filteredFiles` memo already exists. → Reuse the memo (~12).
- `use-media-display-pipeline.ts:588–591` — efficiency — `baseFilesKey` joins every file id into a string on each change. → Compare array identity (reliable once §3.4 makes patches copy-on-write).
- `use-media-display-pipeline.ts:662–687 vs 717–773` — simplify — the shuffle-effect guard re-derives the `displayFiles` precedence chain. → Compute an `activeOrder` kind once and switch on it in both places. This is the same `ordering` change as §3.9 and §5.6 (~30).
- `use-media-display-pipeline.ts:782–790` — reuse — the shuffle branch duplicates `reconcileFrozenFileOrder` (61–85). → Call it (~8).
- `use-library-bootstrap.ts:125–372` — altitude — about 250 LOC of `startTagOutboxRunner` context lives inside a React hook. → Move it to `src/lib/tag-outbox-runner.ts` beside the runner; the hook just calls `startTagOutboxRunner(deps)`. LOC-neutral, and it pairs with the outbox work in §4.
- `use-library-bootstrap.ts:185–217` — reuse — `applyFavoriteMutation` duplicates `applyFavoriteMutations` (135–184). The runner already falls back to the single version (tag-outbox-runner.ts:220–286). → Express single as `applyFavoriteMutations([m])` (~33).
- `use-library-bootstrap.ts:37–53, 319–327` — simplify — dynamic imports are hand-typed. → `const { x } = await import(...)` infers the types (~20).
- `use-library-bootstrap.ts:328–355` — reuse — an ad-hoc compress mime/extension/encoder mapping, the third copy after media-kind.ts:36 and renderable-image.ts:34. → One `imageMimeType(ext, bytes?)` in media-kind (~20).
- `use-library-bootstrap.ts` (4 sites of `library.allFiles.find`) — reuse → `getFileById`.
- `use-visual-viewport-sheet-layout.ts` and `use-visual-viewport-height.ts` — reuse — both subscribe to visualViewport resize/scroll plus window resize. PhotoViewer 752–767 is a third copy and ui-store.ts:326 a fourth. → One `subscribeVisualViewport(cb)` in lib that both hooks build on (~35).

**Edit and media libs**

- `crop-editor.ts:65–600` — altitude — about 530 LOC of content/border/home-indicator detection used only by auto-crop (ManageAutoCropPanel, border-scan.worker) sits in the manual-editor module. → Move it to `lib/auto-crop-bounds.ts`. LOC-neutral; the editor module drops to about 190.
- `crop-editor.ts:430–530 vs 252–264` — reuse — `detectContentBoundsFromSource` re-implements `trimBottomHomeIndicator`'s eat-upward loop. → Call it (~30).
- `crop-editor.ts:682–687` — simplify — `bakeRotation` is a pure alias of `rotateImageBytes`. → Import `rotateImageBytes` in CropEditorOverlay (6).
- `rotate.ts:14–67` — reuse — hand-rolls Image + canvas + `toBlob`. The compress.ts helpers `decodeImageElement`, `createCanvas2d` and `encodeCanvasJpeg` already do this (as crop.ts:157–183 shows). → Rewrite in about 15 lines (~35).
- `crop.ts:113–127` — simplify — `boundingBoxForRotation` uses general trig, but `RotationDegrees` is only 90, 180 or 270. → A swap-if-odd-quarter helper shared with `dimensionsAfterRotation` (video-edit.ts:104–113) and `dimensionsAfterQuarterTurn` (crop-editor.ts) (~20 across the three).
- `crop.ts:74–77` — reuse — `croppedReplaceTitle` is byte-identical to `rotatedReplaceTitle` (rotate.ts:78–81). library-store also has `compressedReplaceTitle`. → One `jpegReplaceTitle(file)` (~8).
- `crop.ts:35–36` — simplify — `canCropVideo` is a one-line fileType check, used once (PhotoViewer 2286 as `canCrop(f) || canCropVideo(f)`). → `canEdit(file)` in crop.ts (3).
- `rotate-draft.ts:3, 8–25, 46–65` — reuse, simplify:
  - `PendingRotationDegrees` is an alias of `RotationDegrees`.
  - `nextPendingRotation` can be `(prev + 90) % 360` with 0 meaning delete.
  - The count/confirm functions duplicate crop-draft.ts:133–152.
  - → A generic `confirmDiscardPending(record, noun)` in one place (~25).
- `renderable-image.ts:34–68` — reuse — `mimeTypeForImageName` repeats the extension chain from `mimeTypeForFile` (media-kind.ts:49–64), plus a parallel detected-format chain. → `` `image/${format}` `` from a known-format set in media-kind, shared with §5.7 `image-format.ts` (~25).
- `video-edit.ts:104–113` — reuse — `dimensionsAfterRotation` is a copy (see the `crop.ts:113` finding).
- `video-edit.ts:201–204 vs 36–67` — simplify — the "even dimension" clamp is written inline again. → Reuse `normalizeVideoCropRect` with a full-frame rect (4).
- `video-media-cache.ts:86–107` — simplify — `takeSessionVideoUrl` and `forgetSessionVideoUrl` both delete without revoking; they differ only in the return shape. → Keep `take`, and callers read `.url` (~10).
- `viewport-fit.ts:46–75` — reuse — `maxAspectRatioCrop` (a pixel `Crop`) is the same math as `defaultNormalizedCrop` (crop-draft.ts:32) in normalized units. → Keep one and scale it (~20). If 1.6 lands, the react-image-crop type goes with it.
- `crop-match.ts:27–29` — simplify — re-exports `hammingDistance` from phash. Only similarity-groups.ts:5 imports it through crop-match. → Import from `@/lib/phash` and drop the re-export. The module is also misnamed: it is similarity matching, not crop editing. → Rename to `similarity-match.ts`.

### Dead code / deletions

All verified with Grep across `src/`. "Test-only" means the only references are the defining file plus `src/lib/__tests__`.

- `src/lib/crop-editor.ts`:
  - **Test-only exports:** `fullImageCrop`, `fullFramePixelCrop`, `initialCropForDisplay`, `cropRectForSave` (also an alias of `pixelCropToSourceRect`), `dimensionsAfterQuarterTurn`. Delete them and their tests.
  - **Internal plus tests only:** `rowLooksLikeHomeIndicator`, `findBottomHomeIndicatorTop`, `trimBottomHomeIndicator`, `detectRawContentBoundsFromImageData`. Un-export them.
- `src/lib/crop-editor.ts:682–687` `bakeRotation` — alias of `rotateImageBytes`. Delete it after updating CropEditorOverlay and crop-rotate.integration.test.
- `src/lib/crop.ts:47–50` `croppedUploadTitle` — test-only.
- `src/lib/viewport-fit.ts:96–99` `viewportCropFraction` — test-only alias of `viewportBlankFraction`.
- `src/lib/marquee-selection.ts` `keysInContentMarquee` — test-only. `rectsOverlap`, `MARQUEE_EDGE_ZONE_PX` and `MARQUEE_EDGE_MAX_SPEED_PX` are internal-only, so un-export them.
- `src/lib/video-edit.ts:251–257` `cropVideoBytes` — its only caller is `cropVideoAndUploadFile` (library-store.ts:237 type, 1627 impl), and nothing in `src/` calls that store action (§3 dead code). Delete both (~40 LOC in the store). `normalizeVideoCropRect` stays: it is used internally and by memory-and-video-crop.test.
- `src/lib/rotate-draft.ts:3` `PendingRotationDegrees` — referenced only in its own file. Replace it with `RotationDegrees`.
- `src/lib/crop-match.ts`:
  - `CROP_REJECT_THRESHOLD` and `templateMatchScoreGrids` are referenced only inside crop-match.ts; un-export them.
  - `TEMPLATE_GRID_SIZE`, `CROP_SAD_THRESHOLD` and `templateMatchScore` are test-only exports.
- `src/hooks/use-pinch-zoom.ts` — `onPanRelease` option, `onPanReleaseRef` and `edgeOverflowAccumRef` (never supplied by the only caller). `getObjectContainSize`, `computePanBounds` and `PanBounds` are exported but used only inside the hook.
- `src/components/PhotoViewer.tsx:780–782, 1178` `goToIndexRef` — written, never read.
- `src/components/PhotoViewer.tsx:728–733` — an effect whose condition is always true.
- `src/components/PhotoViewer.tsx:512, 752–767, 2394–2410` — the debug viewport overlay and its state and listeners.
- `src/components/PhotoViewer.tsx:123, 481, 595–603` `onFileUpdated` / `notifyFileUpdated`, with `src/pages/gallery.tsx:306–309` and `src/components/FilteredMediaView.tsx:87–90` `handleFileUpdated` — an echo loop: the parents only feed the id back as `initialFileId`.


---

## 2. Browse, tag-filter, grid UI and pages

**Current size.** About 11.3k LOC in scope, not counting the vendored `ui/` folder (about 1.8k).
- Tag-filter family: about 3.7k. TagScopeFilterDropdown 1158, TagPickerSheet 667, TagFilterBar 644, TagQueryEditor 497, TagClausePicker 426, plus five small files.
- Grids: about 1.5k. ThumbnailGrid 591, LocalUploadGrid 569, ThumbnailCell 317.
- Upload and compress: about 1.3k.
- Shell, auth and modals: about 1.3k.
- albums/, dedup/ and recents/: about 870.
- Pages: about 2.45k, with manage.tsx alone at 1013.

**Main problems.**
- **The same filter state is passed around four different ways.** A store binding, a draft hook, store actions and about 40 props.
- **The same eight scope counts are computed in two places and passed down through four levels.**
- **TagScopeFilterDropdown mixes two jobs.** It holds both filter and sort, so `NearnessFilterEditor` has to be loaded with `dynamic()` to break an import cycle.
- **Marquee and scroll code is copied between the two grids.** LocalUploadGrid also has a masonry mode that only ever lays out square cells.
- **Five Confirm modals plus five inline AlertDialogs** are the same dialog.
- **Pages repeat the same skeleton.** Session gate, loader, library sort, selection reset and the viewer are written out in each page.
- **manage.tsx holds about 600 lines of duplicate-finder logic** directly in the page (see §3.2).

**Achievable reduction:** about 2,000–2,600 LOC (roughly 18–23%), with no change to features.

**The two structural questions:**
- **Can the tag query/filter components collapse into fewer?** Yes. The 9 files can become 5, with one action surface and one counts object.
- **Can pages share a layout?** Yes. `AppShell` is already the layout. Extend it with the session gate, and move the repeated media-view and library-list logic into one component and one hook.

### Structural proposals (biggest wins first)

**2.1 Collapse the tag-filter UI family.** Saves about 1,000–1,300 LOC. Risk: medium. Do this after 2.3.

Why: one concept (edit a `TagFilterSelection`) is implemented four times, and its state is passed around by hand.

**2.1a One action surface.**
- Today:
  - `hooks/use-tag-filter-binding.ts` and `hooks/use-tag-filter-draft.ts` (258 lines) each wrap the same ~14 functions from `lib/tag-filter-mutations.ts`.
  - `stores/tag-store.ts:735–924` wraps them a third time.
  - `tag-store.ts:522–655` keeps private copies of the mutation helpers that live at `tag-filter-mutations.ts:139–268` (see also §3.5c).
- Replace with:
  - one `tagFilterActions(apply: (fn) => void)` factory in lib, and
  - one store primitive, `updateTagFilter(target, fn)`.
  - The draft becomes `useState` plus the factory; the binding becomes the store primitive plus the factory.
- Also move the `TagQueryEditorActions` type out of the component: `TagQueryEditor.tsx:30–51` exports it and `use-tag-filter-draft.ts:30` imports it.

**2.1b One `ScopeCounts` object from a `useScopeCounts(candidateFiles)` hook.**
- The eight count memos are duplicated at `TagFilterBar.tsx:317–350`, `albums/AlbumEditorPanel.tsx:122–170` and `ManageCompressPanel.tsx:143–170, 485–494`.
- The eight count props are drilled through `TagFilterBar → GalleryToolsMenu → TagQueryBuilderContent → TagQueryEditor → TagScopeFilterDropdown`, and through `NearnessFilterEditor.tsx:14–21, 63–74`.
- Saves about 200 lines on its own.

**2.1c Split TagScopeFilterDropdown into two components.**
- `ScopeFilterMenu`:
  - Takes `{filter, setScope, counts}`.
  - The five sections at 624–726 become one array of `{title, value, onChange, options}` mapped over a single `RadioOptionsSection`.
  - Drop the store fallback (see Dead code).
- A gallery-only `SortMenu`:
  - Reads `useUIStore` directly.
  - Builds the six `sortSections` (898–1045) from data.
  - Owns the nearness/kit panel (732–896).
  - Pairs with the single `ordering` union in §3.9 and §5.6.
- Effects:
  - Removes about 30 of the ~40 props TagFilterBar passes at 421–474.
  - Removes the `dynamic()` cycle workaround at line 260, because TagQueryEditor would then import only ScopeFilterMenu.
  - The 1158-line file becomes about 500 lines across two files.

**2.1d One `TagFilterEditor` component.**
- The "TagClausePicker + grouped hint + TagQueryEditor + `describeTagFilter`" block appears twice:
  - `NearnessFilterEditor.tsx:44–78`
  - `AlbumEditorPanel.tsx:235–274`
- Extract it once and make `NearnessFilterEditor` a thin wrapper, or inline it into SortMenu.

**2.1e Fold the desktop query builder into GalleryToolsMenu.**
- Delete `TagQueryBuilderPanel.tsx` (60). Its only use is `GalleryToolsMenu.tsx:258`, and it repeats GalleryToolsMenu 205–217.
- Inline `TagQueryBuilderContent.tsx` (75 lines). It only unpacks 12 actions from the binding (32–64) and packs them back up.
- Turn the mobile dropdown (158–254) and the desktop buttons (256–303) into one `tools` array rendered two ways.

**2.1f Share the small parts of TagQueryEditor and TagClausePicker.**
- `isTagFilterJoin`: TagQueryEditor:27 and TagClausePicker:45.
- `MatchJoinToggle`: TagQueryEditor 89–132 and TagClausePicker 274–315.
- Has/Not buttons: TagQueryEditor 166–192 and TagClausePicker `ModeButtons` 78–123.
- `FilterNodeRow` (TagQueryEditor 206–319) should take `actions` instead of 8 callbacks (301–314, 379–392).

**Order:** 2.1a, 2.1b, 2.1c, 2.1d, 2.1e, 2.1f. Each step compiles on its own.

**2.2 Share grid mechanics and delete LocalUploadGrid's fake masonry.** Saves about 300–450 LOC. Risk: low to medium. Do this early.

- **Delete the masonry mode.**
  - LocalUploadGrid's `SizedMasonryGrid` (321–418) passes `aspectRatio: 1` for every item (336–340).
  - So its "fit" layout is just a square grid with `object-contain`.
  - Give `SizedGrid` an `objectFit` prop and delete `SizedMasonryGrid` and the `masonryLayoutRef` branch (429, 441–443).
  - In `lib/masonry-layout.ts`, delete `computeMasonryLayoutFromAspects` (176–185), `visibleMasonryItems` (300+) and `computePlacedMasonryItems` (61–118). None has another caller.
- **Extract a `useGridMarquee(containerRef, resolveIds, selection)` hook.** The marquee code is copied almost line for line:

  | Piece | ThumbnailGrid | LocalUploadGrid |
  |---|---|---|
  | refs | 384–386 | 430–432 |
  | `resolveMarqueeFileIds` | 428–452 | 435–459 |
  | `handleMarqueeRect` | 454–485 | 461–491 |
  | `handlePointerDown` | 504–516 | 510–518 |
  | `sameIds` | 590 | 568 |
  | overlay div | 581–585 | 559–563 |

- **Share the scroll-controller effect.** ThumbnailGrid 195–214 vs LocalUploadGrid 269–287, and the masonry copy at 299–320 vs 354–374.
- **Use the shared cell overlay.** `LocalUploadCell` (135–200) repeats the ThumbnailCell shell; it already reuses `SelectedTileOverlay`.

**2.3 One `ConfirmDialog`.** Saves about 250–300 LOC. Risk: low. Do this first.

- Delete these five files:
  - `ConfirmBatchTrashModal.tsx` (69)
  - `ConfirmDeleteModal.tsx` (64)
  - `ConfirmPanicModal.tsx` (68)
  - `ConfirmRevertEditModal.tsx` (71)
  - `dedup/ConfirmTrashModal.tsx` (77)
- Replace the inline copies:
  - `albums/AlbumEditorPanel.tsx:294–320`
  - `pages/recents.tsx:239–265`
  - `TagFilterBar.tsx:604–641`
  - `ManageTrashPanel.tsx:330–360`
  - `ManageTagsPanel.tsx:985–1012`
- Shared props: `{open, title, description, confirmLabel, destructive?, isWorking?, confirmDisabled?, onCancel, onConfirm}`.
- Put the `if (!next && !isWorking) onCancel()` guard and the spinner label inside it, once.

**2.4 Pages share one media view, one library hook and a gated shell.** Saves about 200–250 LOC. Risk: medium.

- **Gallery should use FilteredMediaView.**
  - `GalleryMediaBody` (`gallery.tsx:235–309, 326–356`) re-implements `FilteredMediaView.tsx:42–117`: selection subscriptions, prune, grid selection, footer inset, open/close/update viewer, PhotoViewer.
  - Keep gallery's `viewerFilesRef` freeze as a FilteredMediaView prop or default.
- **One `useLibraryFiles()` hook.** The sorted, deduped, non-archived library list is built three times:
  - `gallery.tsx:171–225`, which has the remap cache. Once §3.4 lands the remap cache goes away too.
  - `albums.tsx:101–114`, without the cache, so it re-sorts the whole library on every `allFiles` change.
  - `AlbumEditorPanel.tsx:77–80`, which also skips the archived filter.
- **Move the session gate into AppShell.**
  - `if (!ready || !authenticated) return <PageLoader …/>` is copied in gallery 88–94, albums 347–353, recents 149–155 and manage 675–681.
  - `AppShell` (or a `requireSession` default) can call `useRequireSession` and render `SyncBanner` itself. Every page renders it today: gallery 134, albums 448, recents 183, manage 689.
- **Share the remaining copies.**
  - The library-loading `showFullPageLoader` check is copied 4 times (gallery 311, albums 342, recents 144, manage 654). Make it one `useLibraryLoading()` helper.
  - The sort toggle button (gallery 103–121 = albums 416–434) becomes a `GallerySortToggle` component.
  - The "reset selection when the filter changes" effect (gallery 256–272 = albums 210–229) moves into `useMediaDisplayPipeline`.
  - The four footers (`SelectionActionFooter`, `StampToolFooter`, `RotateToolFooter`, `CropToolFooter`) are rendered at gallery 344–347 and albums 528–531. FilteredMediaView should render them. See §1 for collapsing the footers themselves.

**2.5 Make manage.tsx a router.** Covered in full by §3.2. Two additions:
- Derive `section` from `router.query.section` rather than mirroring it. That removes `useState` (162), the sync effect (213–218) and the `setSection` calls.
- Pull the 220-line similar-groups effect (244–462) into a `useSimilarGroups()` hook inside the new panel.

**2.6 Move upload orchestration out of UploadPanel.** Saves about 0 LOC but makes the panel much easier to read. Risk: medium. Do this last.

- `runUpload` (`UploadPanel.tsx:221–408`, about 190 lines) is a worker pool, crypto pool and cancellation logic inside a component.
- Move it to `core/upload/run-upload-batch.ts` with progress callbacks, so the panel only holds UI state.
- Derive the `phase` union and the staging/uploading booleans, which can be computed from each other.

**2.7 One session-restore path.** Saves about 40 LOC. Risk: low to medium.

- The "reconcile, then restore if not authenticated" sequence runs in five places:
  - `SessionProvider.tsx:33–36`
  - `pages/index.tsx:14–23`
  - `pages/login.tsx:24–37`
  - `hooks/use-require-session.ts:37–56`
  - `pages/tags.tsx:12–19`
- Make it one memoised `ensureSessionRestored()` in session-store.
- The `LOGIN_PATHS` list (`use-require-session.ts:11`) is copied inline at `SessionProvider.tsx:60–64`.

**2.8 One list-card shell and one thumbnail hook.** Saves about 80–100 LOC. Risk: low.

- `albums/AlbumListCard.tsx:153–210` and `recents/SessionListCard.tsx:28–70` are the same Card + cover + name + badge row. Use one `MediaListCard` with `leading`, `subtitle` and `trailing` slots.
- `useThumbnailEntry` is defined in two places and inlined in a third:
  - `albums/AlbumCoverThumb.tsx:21`
  - `PhotoViewer.tsx:356`
  - inline in `ThumbnailCell.tsx:116–132`
- Move it to `hooks/use-thumbnail-entry.ts`.
- The "img or Skeleton" block is repeated in AlbumCoverThumb 46–53, SessionViewThumb 345–353 and DedupGroupCard 45–49.

### Findings

**TagScopeFilterDropdown.tsx**
- `:269–396` — simplify — about 40 props, all destructured. → 2.1c (about 600).
- `:409–436` — simplify — `commitViewportWidth` and `commitViewportHeight` are near copies, and draft state is seeded from `getState()`. → One `commitViewport(axis)` function (~12).
- `:449–460` — simplify — repeated `showX = onX !== undefined` and `xSort = x ?? "none"` pairs. → They disappear once SortMenu reads the store (~12).
- `:598–613` — simplify — `filterActive` and `sortActive` are listed out by hand; TagFilterBar 365–371 repeats the check. → Use `isTagFilterActive` plus a `isSortActive(ui)` helper (~20).
- `:771–820` — simplify — the kit picker list sits inside a 160-line nested ternary, with a `className` ternary at 780–786. → Extract `KitPickerList` and flatten with early returns (~30).
- `:1057–1068` — simplify — the "None" reset calls every handler one by one. → A single `resetSort()` store action (~10).

**TagFilterBar.tsx**
- `:72–146` — efficiency — about 30 separate store selectors, re-rendering the bar on any of them. → Most go away with SortMenu; use `useShallow` for the rest (~50).
- `:249–269` — altitude — kit-likeness "orphan cleanup" runs as a component effect. → Clear it in the store action that deletes kits (~20).
- `:584–599` — simplify — inline async IIFE for remove. → A named handler (~5).

**TagQueryEditor.tsx**
- `:418` — efficiency — `selectedList` is rebuilt every render. → `useMemo` (0).

**TagClausePicker.tsx**
- `:144–149` — efficiency — subscribes to `allFiles`, `tags`, `fileIdsByTag` and `tagTypes` while the picker is closed; only the memos check `open`. → Move the body into a child that mounts on open (0).
- `:334–376 vs 388–419` — reuse — kit rows and tag rows are near copies. → One `PickerRow` (~30).

**TagPickerSheet.tsx**
- `:43–53, 182–314` — simplify — about 130 lines of custom swipe-to-dismiss for one sheet. → Drop it (the close button and overlay already dismiss) or move it into `ui/sheet` so every sheet gets it (~120).
- `:336–355, 607–662` — simplify — `applyButton` and `errorAlert` are duplicated across two footer branches. → One footer with conditional content (~25).
- `:431–603` — simplify — deep nested ternary over kit and tag rows. → Early-return subcomponents (~30).
- `:165–168` — simplify — `defaultCreateType` repeats `isSpecificTypeTab` (55–58). → Reuse it (~4).

**GalleryToolsMenu.tsx**
- `:70–115` — simplify — `exitRotate` and `exitCrop` are parallel. → One `exitTool(kind)` (~15). Pairs with the selection-store `mode` union in §3.9.

**ThumbnailGrid and ThumbnailCell**
- `ThumbnailGrid.tsx:322–326` — efficiency — `setScrollTop` runs on every scroll event, re-rendering the masonry window and recomputing visible items each frame. → Store a scroll bucket instead, e.g. `Math.floor(scrollTop / 240)` (0).
- `ThumbnailGrid.tsx:400–426` — altitude — a double-rAF "settle token" works around ghost taps after a marquee drag. → Suppress the click in the marquee pointer-up handler (~20).
- `ThumbnailCell.tsx:55–76` — simplify — hand-written props comparator. → Drop it once the selection object is stable, which `useMediaGridSelection` already ensures (~20).

**Selection hook**
- `hooks/use-media-grid-selection.ts:36` — efficiency — `new Set(selectedIds)` every render. → `selectedIdSet()` is already cached by WeakMap at `selection-store.ts:354` (0).

**UploadPanel.tsx**
- `:647–661` — simplify — nested ternaries for title and description. → A lookup keyed by phase (~10).
- `:490–525` — simplify — `toggleFile` and `selectMany` re-implement set toggling. → One `toggleInSet` helper, shared with §3.10 `useGridSelection` (~15).

**CompressionPanel.tsx**
- `:314–329, 387–404, 406–422` — reuse — three "label + percent + Progress" blocks. → One `ProgressRow` (~25).
- `:240–271` — dead — see Dead code.

**Pages**
- `albums.tsx:415` — simplify — album view renders `GalleryToolsMenu` twice: once in the header and once inside `TagFilterBar` (`TagFilterBar.tsx:504`). → Delete the header one (3).
- `albums.tsx:159–187` — efficiency — list mode runs `filterFilesByTags` over the full library for every album whenever `libraryFiles`, tags or favourites change. → Acceptable for now. If it gets slow, move it into the counts worker that TagFilterBar already uses (182–222) (0).
- `recents.tsx:66–72` — efficiency, reuse — builds a Map of the whole library even though `getFileById` is already indexed (`library-store.ts:779`), and also uses it as the fallback at 86 and 202. → Use `getFileById` only, keeping the `allFiles` subscription for re-renders (~8).
- `manage.tsx:200–205` — simplify — the `hydrateEmbeddings` effect repeats the `afterSync` hydrate at 190–198. → Hydrate all three once on mount; see §3.8 (~6).
- `manage.tsx:982` — altitude — the cleanup footer uses `fixed bottom-[calc(4rem+…)]`, hard-coding the nav height. AppShell's note at 87–90 explains why fixed bottom bars break on iOS. → Make it a normal flex child at the end of the panel (0).

**Cross-cutting**
- `=== 1 ? "" : "s"` appears 32 times across 13 files. Examples: TagFilterBar:521, AlbumEditorPanel:247, manage.tsx:732/734/837, UploadPanel. → Add `plural(n, word)` to `lib/utils.ts`; there is no helper in src or ente-utils (~30).
- `AppShell.tsx:72–77`, `FilteredMediaView.tsx:44–51,66–67`, `gallery.tsx:245–250,284–287,329–332` — simplify — the same "any tool active" check (`enabled || stampActive || rotateActive || cropActive`) is written out about 6 times. → Becomes `mode !== "none"` once §3.9 lands; until then an `isAnyToolActive(state)` selector (~15).

### Dead code / deletions

All verified with Grep.
- **`TagQueryBuilderPanel.tsx` (whole file, 60 lines).**
  - Its only caller is `GalleryToolsMenu.tsx:258`.
  - `clauseCount` is never passed (the caller spreads `query`, which has no `clauseCount`), so the aria-label branch at 37–40 is dead.
  - Inline what is left (2.1e).
- **`TagScopeFilterDropdown.tsx:397–402, 444–448`** — the fallback to store `tagFilter` and setters when no props are given. All three callers (`TagFilterBar:421`, `TagQueryEditor:443`, `ManageCompressPanel:516`) pass every scope and handler.
- **`CompressionPanel.tsx`** — the "uploading" phase can never show:
  - `handleUpload` calls `setPhase("uploading")` then `setPhase("success")` in the same synchronous pass (244, 259), so React never renders the block at 406–422.
  - `uploadProgress` (88, 245, 255) only feeds that block.
  - About 25 lines.
- **`LocalUploadGrid.tsx:309–418`** — `SizedMasonryGrid`, the square-only "fit" mode (2.2). In `lib/masonry-layout.ts`, `computeMasonryLayoutFromAspects` (176), `visibleMasonryItems` (300) and `computePlacedMasonryItems` (61) have no other callers. About 170 lines.
- **`lib/masonry-layout.ts:219` `groupMasonryItemsByColumn`** — only used in `__tests__/masonry-layout.test.ts`; `computeMasonryLayout` builds `itemsByColumn` itself.
- **`ConfirmPanicModal.tsx:50–52` and `ConfirmRevertEditModal.tsx:53–55`** — `event.preventDefault()` does nothing, because `AlertDialogAction` (`ui/alert-dialog.tsx:122–133`) is a plain Button, not a Close. Both go away with 2.3.
- **`pages/tags.tsx` (22) and `pages/favourites.tsx` (13)** — redirect-only pages for old routes, which the no-backward-compat rule says to remove. Nothing in src or `public/manifest.webmanifest` links to `/tags` or `/favourites`. Delete them, or use `redirects()` in `next.config.ts` if old bookmarks matter.
- **`albums.tsx:415`** — the duplicate `<GalleryToolsMenu />` (see Findings).
- **Keep `pages/dev-login.tsx`.** It overlaps `LoginForm.tsx:60–73`, but 9 e2e and debug scripts under `scripts/` call it.
- **`ui/`** — no unused files or exports. `dialog`, `scroll-area` and `separator` are each used only by `manage/ManageTagsPanel.tsx`.


---

## 3. Manage panels and state stores

**Current size:** about 11.5k LOC.
- `src/components/manage/`: 4,391
- `src/stores/`: 6,107
- `src/pages/manage.tsx`: 1,013
- Largest files: library-store 2,073, tag-store 1,435, ManageTagsPanel 1,179, ManageSettingsPanel 1,035

**Main problems:**
1. **Job lifecycle copied about 7 times.** Each copy has an AbortController, a paused ref, status, progress, a "superseded run" check, then/catch, a toast, the progress-percent math and a Scan/Resume/Pause button block. Copies:
   - phash in manage.tsx
   - CLIP, quality and tile in ManageSettingsPanel
   - compress
   - tune (partial)
   - auto-crop (partial)
2. **manage.tsx is not a router.** About 650 of its lines are the exact and similar dedup UI, inline.
3. **Same-shaped state handled by hand in several stores:**
   - three identical index stores
   - three hand-rolled debounced-persist modules
   - three job stores
   - eight mutually exclusive ordering flags in ui-store
   - four mutually exclusive tool-mode flags in selection-store
   - four parallel tag-type maps in tag-store, each persisted with four arguments
4. **library-store** carries dead actions, single-file twins of batch actions, three near-identical tag rewrites and three copies of the "remove files from library" sequence. It also mutates `allFiles` in place plus keeps a `filesRevision` counter, so `useMemo([allFiles])` consumers miss optimistic edits.

**Estimated achievable reduction:** about 1,900–2,400 LOC (17–20%). There are also several hot-path efficiency fixes.

### Structural proposals (biggest wins first)

**3.1 One `useJob` hook and one `<JobControls>` component. Delete `usePhashJobStore` and `useCompressJobStore`.**
- **What:** add `useJob()` returning `{status, progress, error, start(run: (signal, onProgress) => Promise<T>), pause(), reset()}`.
  - It owns the AbortController, the paused flag and the supersede check (`abortRef.current !== controller`).
  - It aborts on unmount.
  - Pair it with `<JobControls status progress total onStart onPause labels>`. This renders the "X / Y" line, the progress bar, the Scan/Resume/"Scan complete" label and the Pause button.
  - Also add `jobPercent(current, total, ratio?)`.
- **Why:**
  - Phash and compress already abort and pause on unmount (ManageCompressPanel.tsx:131–136), so their global stores only keep a stale status.
  - After a remount, compress Resume does nothing, because `selectedIds` is local state and the handler returns early at :310.
  - The upload store stays global, because AppShell and UploadProgressBar read it.
- **Files:**
  - ui-store.ts:27–131
  - manage.tsx:150–154, 558–612, 658–668
  - ManageSettingsPanel.tsx:247–487, 844–1003
  - ManageCompressPanel.tsx:109–136, 309–412, 442–462
  - ManageTagsPanel.tsx:302–393, 785–796
  - ManageAutoCropPanel.tsx:104–338
  - session-store.ts:124–127
- **Pairs with:** §5.3 (`job-utils.ts`), which covers the lib side of the same pattern.
- **Est. LOC saved:** about 500
- **Risk:** medium. Behavior is the same, but toasts and batch callbacks need care.
- **Order:** 2nd (after 3.2, so the dedup job lives in its own panel)

**3.2 Make manage.tsx a section router. Move exact and similar dedup into `ManageDuplicatesPanel` and `ManageSimilarPanel`.**
- **What:**
  - Move state (162–198), the similar effect (244–462), the phash job (558–612) and the JSX (726–994) into the two panels.
  - Derive `ManageSection` and the section titles from the `hubCategories`/`toolCategories` arrays in ManageHub.tsx:79–153. This deletes `sectionTitles` at 155–166 and `parseManageSection` at manage.tsx:106–122, replacing the latter with `allSections.includes(value)`.
  - Delete `formatBytes` (manage.tsx:99–104) and use `formatFileSize` from lib/compress.
- **Why:** every other tool is already a panel, and today the page holds dedup-only state for all ten sections.
- **Files:** manage.tsx, ManageHub.tsx, new ManageDuplicatesPanel.tsx and ManageSimilarPanel.tsx
- **Est. LOC saved:** about 80 net (on top of the 3.1 savings it enables). manage.tsx goes from 1,013 to about 150 lines.
- **Risk:** low
- **Order:** 1st

**3.3 library-store cleanup.**
- **What:**
  - (a) Delete the dead actions (see Dead code).
  - (b) Make `setFileFavorite` (1275–1309) and `setFileArchived` (1311–1337) call `batchSetFavorite([file])` and `batchSetArchived([file])` (1955–2008, 2010–2042), or delete them and update callers.
  - (c) Turn `renameTag`, `deleteTag` and `mergeTags` (1178–1273) into one `rewriteTags(sourceNames, mutator, treeRewrite, tagStoreApply, serverCall)`.
  - (d) Extract `removeFilesFromLibrary(ids)` from `moveFilesToTrash` (1852–1885), `pruneDuplicateGroups` (1394–1410) and `replaceSourceWithCompressed` (585–608). This fixes the inconsistency where prune only clears the favorite outbox while trash clears five.
  - (e) Extract `applyOrganizerConfig(config)` from bootstrapFromCache (841–856) and syncRemote (897–938). Bootstrap currently skips the album store and tag types.
  - (f) Use `commitAllFiles` (385–399) instead of the hand-written copies at 821–827 and 1007–1014.
  - (g) Import tag-speed-store and view-sessions-store statically, or once at module level. The dynamic imports at 494, 698, 801, 846, 849, 903, 932 and 1616 are only there because of the session-store cycle, which 3.7 removes.
- **Est. LOC saved:** about 400
- **Risk:** medium
- **Order:** 3rd

**3.4 Always copy on file patch. Drop `filesRevision` and `patchFileInPlace`.**
- **What:**
  - `applyOptimisticFileTags` (library-store.ts:471–487) and the crop/replace paths mutate `allFiles` in place, then bump `filesRevision`.
  - Only gallery.tsx:160–225 depends on `filesRevision`, by re-mapping through `getFileById`.
  - Every other `useMemo([allFiles])` consumer misses these edits: ManageCompressPanel, manage.tsx exactGroups, ManageArchivedPanel and the ManageSettingsPanel tile coverage.
  - Fix: route every patch through `patchFilesInLibrary` (lib/library-file-patch.ts), which builds a new array, and delete `filesRevision`, `patchFileInPlace` and the gallery re-map. `patchFileInLibrary` becomes `patchFilesInLibrary([one])`.
- **Why:** this is the deeper fix. Today a correctness rule ("depend on filesRevision") is bolted onto a single consumer.
- **Est. LOC saved:** about 70, and it fixes stale memos
- **Risk:** medium. It costs one O(n) array-of-references copy per optimistic commit, which is cheap next to the existing filter and memo passes.
- **Order:** 4th

**3.5 tag-store: one type-config object, one rewrite path, filter-tree helpers moved to lib.**
- **What:**
  - (a) Replace `tagTypes`, `tagTypeByName`, `includeInKitNearnessByName` and `includeInEffectsPresenceByName` with one `typeConfig` value and a `commitTypeConfig(next)` that does set + `persistTagTypesConfig`. The four-argument persist call is repeated at 941–946, 959–964, 981–986, 1008–1013, 1229–1234, 1277–1282 and 1398–1403.
  - (b) Implement `applyTagRename`, `applyTagDelete` and `applyTagMerge` (1156–1404, about 250 lines) as one `applyTagRewrite(sourceNames, target | undefined, treeRewrite)`.
    - Rename is a merge of `[old]` into `new` that renames the name in the filter tree.
    - Delete is a merge with no target.
    - The registered-names "changed?" check is duplicated at 1200–1203 and 1374–1377.
  - (c) Move `removeNodeFromTree`, `updateGroupOp`, `findParentGroup`, `ungroupNode` and `wrapSiblingsInGroup` (522–655) into lib/tag-filter-mutations.ts, next to their siblings. This is the store half of §2.1a.
  - (d) Collapse `setFavoritesScope`, `setMediaScope`, `setCroppedScope` and `setRotatedScope` (744–782) into `patchFilter(patch, target)`. They are identical spreads.
  - (e) Delete `tagIndexRevision` (see Dead code).
- **Est. LOC saved:** about 280
- **Risk:** medium. Merge and rename semantics for effects-presence inheritance need tests.
- **Order:** 5th

**3.6 `createDebouncedPersist(write, ms)` in lib, and one page-hide flush path.**
- **What:** three hand-rolled copies of "timer + pending value + serial promise chain + flush + cancel":
  - library-store.ts:330–379
  - tag-store.ts:218–291
  - view-sessions-store.ts:56–122
- Replace them with `const saver = createDebouncedPersist(write, 1500)`, which exposes `{schedule, flush, cancel}`.
- Delete the per-store pagehide/visibilitychange listeners (tag-store.ts:1425–1435, library-store.ts:~2063–2073) and the flush half of view-sessions-store.ts:405–413. `durable-flush.ts` already installs one listener; add view sessions to `flushAllDurableState`.
- **Est. LOC saved:** about 130
- **Risk:** low
- **Order:** 6th

**3.7 Session-reset registry.**
- **What:** replace `resetDependentStores` (session-store.ts:47–130) with `onSessionReset(fn)` in lib. Each store or lib module registers its own reset when it loads, and session-store calls `runSessionResets()`.
- Modules that were never loaded hold no state, so the dynamic imports become unnecessary. This also removes the import-cycle reason behind the dynamic imports in 3.3(g).
- It fixes the partial UI reset: today only `setDedupDryRun(false)` runs (128), so sort/nearness ordering survives logout.
- **Est. LOC saved:** about 60
- **Risk:** low–medium. Make sure every module with session state registers.
- **Order:** 7th

**3.8 Index-store factory.**
- **What:** embedding-index-store (42), phash-index-store (36) and quality-index-store (37) differ only in their hydrate function. Add `createIndexStore(loadFn)` with an in-flight-promise `ensureHydrated()`.
- Replace the `if (!isHydrated) await hydrate()` checks at:
  - library-store.ts:1040
  - ManageSettingsPanel.tsx:220–232, 532
  - ManageTagsPanel.tsx:334–336
  - manage.tsx:191–205 (which triggers it twice)
  - use-media-display-pipeline.ts:147–152
  - TagFilterBar
- Today concurrent callers decrypt the index twice.
- **Est. LOC saved:** about 90
- **Risk:** low
- **Order:** 8th

**3.9 Use union types for mutually exclusive mode flags.**
- **ui-store:**
  - Replace `viewportFitSort`, `uploadedAtSort`, `imageSizeSort`, `imageQualitySort`, `tagFilterFitSort`, `relativeSort`, `nearnessFilter`/`nearnessSource` and shuffled `mediaViewOrder` with `ordering: Ordering | undefined` plus `setOrdering`.
  - This deletes `clearOrderings` (281–296) and the five near-identical setters (309–363).
  - Consumers: TagFilterBar.tsx (25 uses) and use-media-display-pipeline.ts (4 uses).
  - §5.6 covers the matching lib side (one `sortFilesByScore`).
- **selection-store:**
  - Replace `enabled`, `stampActive`, `rotateActive` and `cropActive` with `mode: "none" | "select" | "stamp" | "rotate" | "crop"`.
  - Replace `rotateBusy` and `cropBusy` with one `applyBusy`.
  - This deletes the `stampOff`/`rotateOff`/`cropOff` spreads (69–86) and the four almost identical setActive bodies (103–110, 172–187, 239–252, 284–297).
  - `s.enabled` has 7 consumers, which become `s.mode === "select"`.
- **Est. LOC saved:** about 110
- **Risk:** medium (wide consumer edits)
- **Order:** 9th

**3.10 Shared panel pieces.**
- `useGridSelection(files, busy)`: picked ids filtered to visible ids, toggle, selection memo, run-busy wrapper.
  - Trash 134–176, Archived 44–96, Compress toggle at 253–263.
- `TagPickerSelect`: ManageTagsPanel 604–632 and 749–777.
- `InlineRenameInput`: preset rename at ManageTagsPanel 667–711 plus state at 125–128 and 280–300, and the tag rename form in ManageTagRow.
- `NumberToggleField`: ManageSettingsPanel 686–712, 764–786, 813–841.
- `SwitchField`, or a config array: ManageSettingsPanel 639–672.
- `useScopeCounts(files)`: see §2.1b.
- `ConfirmDialog`: see §2.3 (ManageTrashPanel 330–360, ManageTagsPanel 985–1012).
- **Est. LOC saved:** about 220
- **Risk:** low
- **Order:** 10th

**Target store architecture.** Keep one store per domain and do not merge stores. Apply 3.1–3.9 and keep only canonical state:

| Store | Canonical | Derived (keep or drop) |
|---|---|---|
| library | `collections`, `allFiles`, sync status | `fileIndexById` (keep, rebuilt in `commitAllFiles`); `filesRevision` (drop, 3.4) |
| tag | `fileIdsByTag` (a persisted incremental cache of the tags on `allFiles`), `registeredTagNames`, `typeConfig`, `tagFilter`, `albumViewFilter` | `tags` (keep as a cached sorted key list); `tagIndexRevision` (drop); `lastTagTouchFileIds` (an event, kept only as a gallery refilter hint) |
| favorites | `unsyncedFavoriteUpdates` (mirrors the outbox), `pendingFavoriteFileIds` | `favoriteFileIds`, `favoritesCollectionId` |
| ui | `ordering`, gallery view prefs | — |
| index stores, settings, album, tag-speed, view-sessions | their own data | — |

- Move `dedupDryRun` out of ui-store into local state of the dedup panel.
- Job state is local, through `useJob`. Only the upload job stays global.

### Findings

**manage.tsx**
- `manage.tsx:191–205` — efficiency — Embedding hydration is triggered both from afterSync and from a mount effect → use a single `ensureHydrated()` call (3.8). (~10)
- `manage.tsx:903–927` — simplify — The empty-state nested ternaries repeat the "Scan your library" branch → use an early-return `emptyMessage` variable. (~12)

**ManageHub**
- `ManageHub.tsx:155–166` — reuse — `sectionTitles` duplicates titles already in the category arrays → derive titles from `hubCategories`/`toolCategories`. (~12)

**ManageSettingsPanel**
- `ManageSettingsPanel.tsx:141, 326–330` — efficiency — The panel subscribes to the whole `embeddingEntries` Map, and `onBatchPersisted` runs `setEmbeddingEntries(new Map(entries))` on every batch.
  - Each batch therefore copies the map O(n), re-renders the panel, and re-runs the tile-coverage effect (178–218).
  - That effect recomputes `kitNearnessTaggedFileIds` over the whole library and does an IDB coverage read when dev tools are on.
  - → Subscribe to `s.entries.size` and read entries via `getState()` inside the handlers. (~5, large runtime win)
- `ManageSettingsPanel.tsx:158` — simplify — `qualityCandidateCount = clipCandidateCount` is an alias → use `clipCandidateCount` directly. (~1)
- `ManageSettingsPanel.tsx:282–318` — simplify — The CLIP batch-mode toast branching is verbose → use one message map keyed by mode. (~20)
- `ManageSettingsPanel.tsx:517–597` — altitude — Dev-only corpus export sits inside the settings panel → move it with the research code (§5.1). (~60 out of the panel)

**ManageTagsPanel**
- `ManageTagsPanel.tsx:565–878` — simplify — The presets card is about 300 lines inside a 1,179-line panel → split it into `ManageTagPresetsCard.tsx` (pairs with `TagPickerSelect` and `InlineRenameInput` from 3.10). (organization)
- `ManageTagsPanel.tsx:998` — simplify — `fileIdsByTag.get(deleteTarget)?.size` is computed twice → compute it once into a const. (~1)
- `ManageTagsPanel.tsx:415, 956` — reuse — The suggestion key `tags.join("\0")` appears twice → use a `suggestionKey(tags)` helper. (~2)
- `ManageTagsPanel.tsx:828–846` — simplify — Fitness formatting is verbose → use one `formatFitness(n)` with `toFixed`. (~12)

**ManageCompressPanel**
- `ManageCompressPanel.tsx:442–462` — simplify — The `stageRatio` branch of `progressPercent` is unreachable, because the value is only used when the ratio is undefined → `total > 0 ? Math.round(((current - 1 + (ratio ?? 1)) / total) * 100) : 0`. (~15)
- `ManageCompressPanel.tsx:265–291` — reuse — `selectMany` re-implements `useSelectionStore.selectMany` semantics on a local Set → fold it into `useGridSelection`. (~20)
- `ManageCompressPanel.tsx:503–510` — simplify — The `encoderHint` nested ternary → use a `Record<Encoder, string>` lookup. (~5)
- `ManageCompressPanel.tsx:495–501` — simplify — `hasQueryContent` re-lists every scope field → add an `isTagFilterActive`-style helper in lib/tags, next to `isTagFilterActive`. (~5)

**ManageAutoCropPanel**
- `ManageAutoCropPanel.tsx:340` — efficiency — `autoCropEligibleFiles(files)` filters the whole library on every render → wrap it in `useMemo([files])`. (~0, runtime win)
- `ManageAutoCropPanel.tsx:51–54, 104–325` — altitude — Scan and apply loops (plus a private `yieldToMain`) live in a component, unlike every other tool → move them to `lib/auto-crop-job.ts` and drive them with `useJob`. (~40)
- `ManageAutoCropPanel.tsx` THUMB_CONCURRENCY = APPLY_CONCURRENCY = 1 — simplify — `mapBatched` with concurrency 1 is just a for-loop → use a plain `for…of`. (~8)

**ManageTrashPanel**
- `ManageTrashPanel.tsx:233–236` — efficiency — `soonestDays` is computed with a loop on every render. trash-store sorts by `deleteBy` descending, so the soonest is the last item → use `items.at(-1)`. (~4)

**ManageUsagePanel**
- `ManageUsagePanel.tsx:128–164` — simplify — Repeated `<dt>/<dd>` rows → map over a `[label, value][]` array. (~20)

**BatchCompressPreviewSheet**
- `BatchCompressPreviewSheet.tsx:90–94` — simplify — The total size is shown again after line 55 → delete the duplicate. (~5)
- `BatchCompressPreviewSheet.tsx:62–67` — simplify — Filler copy with no information → delete it. (~6)
- `BatchCompressPreviewSheet.tsx:78–79` — simplify — `fileByteSize(file)` is called twice → compute it once. (~1)

**ui-store**
- `ui-store.ts:27–66` — dead — `usePhashJobStore.error` is set (manage.tsx:568, 600) but never read → it goes away with 3.1. (~6)

**session-store**
- `session-store.ts:128` — altitude — The UI store "reset" only clears `dedupDryRun` → handled by 3.7 plus a real `useUIStore.reset`. (~0)

**library-store**
- `library-store.ts:445–451` — efficiency — `requireFile` does a linear `allFiles.find` → use `getFileById` / `fileIndexById`. (~2)
- `library-store.ts:592–601` — efficiency — `replaceSourceWithCompressed` runs a `filter` and then a `findIndex` over the library → do a single pass via `fileIndexById`. (~5)
- `library-store.ts:585` — simplify — `replaceSourceWithCompressed` is also used for crop and video replace → rename it to `replaceSourceFile`. (~0)
- `library-store.ts:603, 1403, 1874, 1897` — efficiency — Immediate full-library `saveEncryptedFiles` on hot paths (every compress or crop replace during a batch) → use `scheduleSaveEncryptedFiles` plus the durable flush. (~0, large runtime win; medium durability risk)
- `library-store.ts:1880–1884` — efficiency — Five independent outbox cleanups are awaited sequentially → use `Promise.all`. (~2)
- `library-store.ts:1149–1151` — simplify — `patchFile` is an async wrapper over `patchFiles` → call `patchFiles([…])` directly. (~4)
- `library-store.ts:1802–1850` — simplify — `uploadImageFile`/`uploadVideoFile` are positional-argument forwarders → callers use the underlying upload directly, or keep one `uploadFile(file, opts)`. (~30)

**tag-store**
- `tag-store.ts:1045–1047` — simplify — `applyFileTags` forwards to `applyFilesTags` (its only caller is library-store) → call `applyFilesTags([{…}])`. (~5)
- `tag-store.ts:926–928` — simplify — `clearAlbumViewFilter` equals `clearFilters("album")` (albums.tsx is the only caller) → delete it. (~5)
- `tag-store.ts:1406–1416` — simplify — `reset` re-lists type-config defaults that `initialTagState` already holds via `configFromPersisted(undefined)` → `set(initialTagState)`. The maps are copy-on-write, so sharing them is safe. (~6)

**favorites-store**
- `favorites-store.ts:131–136` — simplify — `revertOptimisticFavorite` takes an unused `_collections` parameter → drop it at the definition and in library-store callers. (~3)
- `favorites-store.ts:203` — altitude — The module-level `pendingFavoriteFilesByHashAndType` Map is exported from a store and cleared in `reset` → move it to lib/favorites with the other non-reactive caches. (~0)

**trash-store**
- `trash-store.ts:159–191` — reuse — `restoreToCollection` and `deleteForever` both "filter out ids, set, persist" → use a `removeItems(ids)` helper. (~8)
- `trash-store.ts:186–191, 214–218` — efficiency — Persist, then cache prune, run sequentially but are independent → use `Promise.all`. (~2)

**selection-store**
- `selection-store.ts:112–121` — efficiency — `toggle` uses `indexOf`/`splice` on an array, while `selectedIdSet` keeps a WeakMap Set → `selectMany([id], "toggle")`. (~8)

**view-sessions-store**
- `view-sessions-store.ts:340–352, 374–403` — simplify — `replaceSessionsForTest`/`getSessionsForTest` are store actions used only by the dev hook (scripts/e2e-recents.ts) → inline them into `installDevTestHook` and drop them from the interface. (~10)

### Dead code / deletions

All verified with Grep across `src/` and `scripts/`, excluding `out/`.
- **library-store.ts:**
  - `compressAndUploadFile` (205–209, 1413–1443)
  - `cropVideoAndUploadFile` (237–240, 1627–1656)
  - `cropAndUploadFile` (241–245, 1658–1670)
  - `applyLocalTagsOnFile` (171, 1153–1158)
  - `setActiveCollection` (164, 1100–1102)
  - `activeCollectionId` is always null. Its only read is UploadPanel.tsx:169, which should use the null path directly.
  - About 110 lines in total.
- **tag-store.ts `tagIndexRevision`:**
  - Defined at 65 and 180, bumped at 465, 669, 704, 729, 1037, 1225, 1273 and 1394.
  - Its only consumer, use-media-display-pipeline.ts:126, does `void tagIndexRevision;` (594) and lists it in deps (654) next to `fileIdsByTag` (649).
  - `fileIdsByTag` gets a new Map identity on every one of those commits, so the revision is redundant. (~12)
- **favorites-store.ts:** `addPending` (43, 159–163) and `clearUnsynced` (46, 191–193) have no callers. (~10)
- **selection-store.ts:** `clearStamp` (51, 229–236) has no callers. (~9)
- **tag-speed-store.ts:** `setPinnedTags` (49, 162–166) has no callers; `togglePinnedTag` is the one in use. (~6)
- **video-playback-store.ts:** `setMuted` (39, 68–70) has no callers. (~4)
- **album-store.ts:129:** the `export { emptyPersistedQueryAlbums }` re-export is unused, since organizer-config.ts imports it from lib/query-albums. Its import at line 7 goes too. (~2)
- **ui-store.ts:**
  - `usePhashJobStore.error` and `setError`: written, never read.
  - `usePhashJobStore` and `useCompressJobStore` as a whole once 3.1 lands (27–131, about 105 lines).
- **manage.tsx:**
  - `formatBytes` (99–104): replace with `formatFileSize`.
  - `parseManageSection` (106–122): derive it from the hub arrays.
- **session-store.ts:** `resetDependentStores` (47–130) once 3.7 lands.


---

## 4. Data, sync, persistence and tags layer

Scope: `core/`, `db/`, `lib/sync`, tags, outboxes and caches. Paths below are relative to `src/`.

**Size today (excluding tests):** about 15,950 LOC.
- core/: 5,070
- db/: 2,039
- lib/sync: 563
- in-scope lib files: 8,276. The largest are tags.ts 1,253, tag-filter-mutations 667, thumbnail-cache 582, view-sessions 523, tag-outbox-runner 502 and db/kv.ts 486.

**Main problems:**
1. **Outbox skeleton copied four or five times.** Tag, favourite, visibility and derived-replace outboxes plus favourite-membership each repeat the same pieces: in-memory map, hydrate with in-flight dedupe, persistChain, flush, remap, ack-if-unchanged, clear, and their own pagehide listener.
2. **Typed persistence plumbing written by hand.** That means 14 load/save pairs in kv.ts and two near-identical LRU blob stores.
3. **Three or four independent retry/backoff loops.** One of them is nested three deep around tag PUTs and finishes with a verify-refetch that patches a symptom.
4. **tags.ts handles its five scope fields field by field everywhere.**
5. **Legacy migration shims are still live, adding extra IDB reads per save.**
6. **core imports lib.** core/metadata.ts and core/api/collection-files.ts import `@/lib/*`.

**Achievable reduction:** about 2,800–3,300 LOC (roughly 18–20%), without behaviour change.

**Crypto-sensitive surfaces that must be kept as they are:**
- the `pubMagicMetadata` spread-merge (`{ ...file.pubMagicMetadata?.data, ...updates }`)
- `pubMagicVersionForPut`, and setting the version to sent+1 after a PUT
- `retryOnConflict`, which refetches, decrypts and re-merges on 409 (core/metadata.ts:180–207)
- the private `magicMetadata.data` spread in the visibility overlay
- session-cacheKey encryption at rest (db/crypto.ts)

Any PR touching these must pass the crypto/metadata tests in `src/core/__tests__` and the outbox tests (`npm test`).

### Structural proposals (biggest wins first)

**4.1 One generic persisted outbox plus a registry; flush means "await the pending write".**
- **What:**
  - Add `lib/outbox.ts` exporting `createOutbox<E>({ kvKey, keyOf, label })`. It returns `hydrate`, `entries`, `upsert(many)`, `removeIfUnchanged(sent)`, `removeWhere(pred)`, `remap(from, to)`, `flush`, `clear` and `size`.
  - It keeps a module-level registry (`allOutboxes`). durable-flush.ts then iterates the registry instead of hand-listing each outbox, and installs the one pagehide/visibilitychange listener. The store-side debounced persists in §3.6 register with the same listener.
  - Persist is coalesced with a dirty flag: a burst of N enqueues produces one encrypt+put, not N.
  - `flush()` returns the in-flight chain instead of enqueueing another full re-encrypt. Every mutation already persists: upsert awaits persist at tag-outbox.ts:116 and favorite-outbox.ts:118, and enqueue persists at tag-outbox.ts:139. So flush-on-hide currently re-encrypts state that is already on disk.
- **Why:**
  - The skeleton is duplicated in favorite-outbox.ts:24–96, visibility-outbox.ts:33–53, tag-outbox.ts:26–94, derived-replace-outbox.ts:48–91 and favorite-membership.ts:19–84.
  - Behaviour differs between copies. Hydrate in-flight dedupe exists only in tag/favourite (tag 50–70, favourite 59–77), not visibility (42–53) or derived (57–91). The leading `.catch` on persistChain is missing in visibility (33–40) and derived (48–55).
  - Every hide event flushes twice: once from the per-module listeners (favorite 264–275, visibility 210–220, tag 323–333, derived 214–224) and once from durable-flush.ts:116–124. The comment at favorite-outbox.ts:274 acknowledges this.
  - Each module keeps only its domain code: the apply overlay, reconcile with library, and the favourite/visibility key logic.
- **Files:**
  - lib/favorite-outbox.ts, lib/visibility-outbox.ts, lib/tag-outbox.ts, lib/derived-replace-outbox.ts
  - lib/favorite-membership.ts (uses the same persisted-set skeleton; can use the same factory with a `Set`)
  - lib/durable-flush.ts
- **Est. LOC saved:** about 550–600.
- **Risk:** medium. Ack-if-unchanged (the `enqueuedAt` compare) and the remap semantics must carry over exactly; existing tests cover them.
- **Crypto-sensitive:** no for the generic part. tag-outbox.ts `mergeAheadOrganizerTags` and `copyAheadOrganizerTags` (253–314) touch `pubMagicMetadata.version` and must move unchanged.
- **Order:** 1st.

**4.2 Typed kv: one generic load/save keyed by a `KvValues` map.**
- **What:**
  - Define `type KvValues = { collections: …; tagIndex: …; tagOutbox: …; … }`.
  - Use `loadKv<K extends keyof KvValues>(key)` and `saveKv<K>(key, value)`, which read `getSessionCacheKey()` internally.
  - Delete the 14 `loadEncryptedX` / `saveEncryptedX` wrapper pairs.
  - Merge the phash-chunk and embedding-chunk "append chunk + meta + getAll-decrypt" code into one `appendChunk(store, meta)` / `loadChunks(store)` pair, with chunk decrypts run through `Promise.all`.
- **Why:**
  - The wrappers are pure boilerplate, and every caller passes `getSessionCacheKey()` by hand.
  - kv.ts:124–182 (phash) and 395–467 (embeddings) are the same pattern.
  - `loadAllPhashChunks` (157–172) and `loadAllEmbeddingChunks` (449–465) decrypt sequentially.
  - `appendPhashChunk` re-reads and decrypts the meta record on every append (128).
- **Files:** db/kv.ts, plus every caller of the wrappers (the outboxes, favorite-membership, stores, sync/pull-trash).
- **Est. LOC saved:** about 250.
- **Risk:** low.
- **Crypto-sensitive:** yes, but only for at-rest encryption. `encryptCachePayload` / `decryptCachePayload` stay unchanged; only the call sites collapse.
- **Order:** 2nd. Do it before or together with 4.1, since the outbox factory then takes a `kvKey`.

**4.3 One LRU-budgeted encrypted blob store plus a shared byte-record wrapper.**
- **What:**
  - Add `db/blob-store.ts` with `createLruBlobStore({ storeName, budgetBytes, targetBytes })`. It returns `get`, `put`, `delete`, `flushTouches` and `clear`, and owns: the cursor LRU scan, `evictUntilFit` with its eviction chain, `LruTouchCoalescer`, the `hasOrganizerDB` guards, and a cached disk-bytes total.
  - db/thumbnails.ts and db/file-ciphertexts.ts become instances of about 10 lines each.
  - Add `wrapBytes(bytes)` / `unwrapBytes(record)` for the `encryptBlobBytes → .slice().buffer + toB64(header)` record. db/derived-replace-payloads.ts, db/tile-embeddings.ts and file-ciphertexts.ts:205–228 all repeat it.
- **Why:**
  - thumbnails.ts (296) and file-ciphertexts.ts (254) are near-duplicates.
  - file-ciphertexts `putFileCiphertext` runs a full-store cursor scan on every put (210–213), because it has no cached byte total. thumbnails already has `cachedDiskBytes`.
  - Thumbnails store `encryptedData` as base64, so every get and put pays toB64/fromB64 (thumbnails.ts:229, 262). The other stores use ArrayBuffer.
- **Files:** db/thumbnails.ts, db/file-ciphertexts.ts, db/lru-touch.ts, db/derived-replace-payloads.ts, db/tile-embeddings.ts, db/index.ts (bump dbVersion and clear the thumbnails store; it is a cache, so no migration is needed).
- **Est. LOC saved:** about 280.
- **Risk:** medium, because of the eviction ordering.
- **Crypto-sensitive:** yes, at rest. Same `encryptBlobBytes` / `decryptBlobBytes` with the session cacheKey.
- **Order:** 4th.

**4.4 One HTTP error type and one retry helper; remove nested tag-PUT retries and the verify-refetch.**
- **What:**
  - core/api/http.ts:80 should throw ente-base `HTTPError` (which carries `res.status`) instead of `Error("HTTP ${status} …")`.
  - Fold `MetadataUpdateError` into `HTTPError`, keeping a Retry-After field.
  - Add one `retryWithBackoff(op, { isRetryable, attempts })` in core/api/http.ts. It honours Retry-After and uses ente-utils `wait`.
  - Use that helper in download.ts `fetchEncryptedBytes` (120–160), upload/remote.ts `withUploadRetry` (157–176) and tag-write-pipeline.ts (33–89, 136–165).
  - Delete `parseRetryAfterMs` (metadata.ts:33–42), which duplicates download.ts `retryAfterMs` (28–42).
  - Delete the regex-on-message retry checks: remote.ts:144–145 and tag-write-pipeline.ts:51–55.
  - In tag-write-pipeline, keep exactly two layers:
    - an outer transport retry for 429, 5xx and network errors (not 409);
    - the existing `retryOnConflict` for 409.
  - Delete `attemptWriteAndVerify` / `writeAndVerifyTags` (91–134) with its double PUT and refetch. A versioned PUT accepted by the server is authoritative; refetching to "verify" patches a symptom. ⚠️ Decision needed — see Open decisions.
- **Why:**
  - The worst case today is 3 (transport, 61–89) × 4 (`retryOnConflict`) × 2 (`attemptWriteAndVerify`, 112–125) = 24 PUTs plus 3 refetch/decrypts per file.
  - The batch-path check `tagsEqual(extractTags(file), item.intendedTags)` at tag-write-pipeline.ts:229 is tautological, because `putFilesTags` builds the data from `intendedTags`.
- **Files:** core/api/http.ts, core/metadata.ts, core/download.ts, core/upload/remote.ts, lib/tag-write-pipeline.ts.
- **Est. LOC saved:** about 300. tag-write-pipeline alone goes from 258 to about 90.
- **Risk:** medium.
- **Crypto-sensitive:** yes. Keep `retryOnConflict`'s refetch → decrypt → spread-merge → PUT with `pubMagicVersionForPut`, and keep the local version+1 after success, byte for byte.
- **Order:** 3rd.

**4.5 Drive tags.ts from one `SCOPES` table; pass a filter context object; count everything in one pass.**
- **What:**
  - Define one `SCOPES` table (key, values, filter-name constant, predicate, label).
  - Derive from it: the 10 filter-name constants (13–47), the `describeTagFilter` if-ladder (280–312), the `isReservedTag` ladder (330–341), `isTagFilterActive` (214–220), the scope check in `isFlatIncludeAndFilter` (914–925), and the `apply{Media,Cropped,Rotated}Scope` trio (812–858, all the same `keepFilesWhere` pattern).
  - Replace the five parameters threaded through every `evaluateTagFilterNode` helper (515–759) with one `ctx` object.
  - Share the `only`-op parsing between `describeGroupNode` (243–270) and `evaluateTagFilterNode` (664–685).
  - Replace `countPhotos`, `countVideos`, `countManuallyCropped`, `countNotManuallyCropped` and `countNotFavorites` (1188–1247) with the existing single-pass `countFileKindsInCandidates` (1161–1185), extended to cover cropped and rotated. This is the lib half of §2.1b `useScopeCounts`; AlbumEditorPanel.tsx:153–168 currently makes four extra full passes.
  - Replace the four one-line setters in tag-filter-mutations.ts:285–315 with `setTagFilterScopes(filter, patch)` (pairs with §3.5d `patchFilter`).
  - query-albums.ts:33–65 and 67–146 hand-mirror every node type just to strip or add `id`. Replace with `type Persisted<T> = Omit<T, "id">` and recursive `{ ...node, id }` / `const { id: _, ...rest } = node`. Serialize and hydrate the scopes with one spread.
- **Why:** Adding a sixth scope today touches about 12 sites across three files.
- **Files:** lib/tags.ts, lib/tag-filter-mutations.ts, lib/query-albums.ts, components/albums/AlbumEditorPanel.tsx.
- **Est. LOC saved:** about 330.
- **Risk:** low–medium (pure functions with good test coverage).
- **Crypto-sensitive:** no.
- **Order:** 5th.

**4.6 Delete legacy shims and write-only state.**
- **What:**
  - Shards meta: file-shards.ts:23–30, 82–106, 239–245, 299–302. It is write-only; `loadShardsMeta` only decides whether to write it, which costs an extra IDB put per save.
  - Legacy kv `"files"` migration and the per-save `db.get("kv","files")` probe: file-shards.ts:249–268 and 347–350. Also remove `"files"` from `KvKey`.
  - `bytesBase64` migration: derived-replace-outbox.ts:32–39 and 62–91, plus kv.ts:291–292.
  - `estimateLegacyByteSize` / `recordLastAccess`: thumbnails.ts:47–56.
  - Legacy unwrapped-row delete: file-ciphertexts.ts:150–153.
  - Embedding meta v1 branch: kv.ts:378–386.
  - Speculative `shardCount` parameter, which is always 64: file-shards.ts:46–52.
- **Files:** db/file-shards.ts, db/kv.ts, db/index.ts, db/thumbnails.ts, db/file-ciphertexts.ts, lib/derived-replace-outbox.ts.
- **Est. LOC saved:** about 150, plus one IDB read and one IDB write per library save.
- **Risk:** low. Users on pre-shard data need a one-time re-pull, and a dbVersion bump is acceptable under the no-shims rule. ⚠️ The `bytesBase64` shim guards *pending, unsent* derived-replace payloads, so dropping it could lose a queued edit on a device that hasn't drained. See Open decisions.
- **Crypto-sensitive:** no.
- **Order:** do first. It is independent and makes 4.2 and 4.3 smaller.

**4.7 Rename the runner, make its context concrete, and run independent drains in parallel.**
- **What:**
  - Rename tag-outbox-runner.ts to outbox-runner.ts. It drains all four outboxes.
  - `TagOutboxRunnerContext` (67–89) has optional `patchFile` / `patchFiles` and both `applyFavoriteMutations` and `applyFavoriteMutation`. Its single caller, hooks/use-library-bootstrap.ts:125–320, supplies all of them. Make them required and drop the single-file variants. Move that 250-line context out of the hook into the runner module as well (§1 hooks findings).
  - In the bootstrap callbacks:
    - replace `library.allFiles.find(c => c.id === entry.fileId)` (lines 153, 192, 239, 310) with `getFileById`;
    - replace the sequential `await isFileIdInTrash` per entry with one trash-id `Set`.
  - In the runner:
    - use ente-utils `batch()` instead of the manual chunking at 313–317;
    - use a `Map` instead of `collections.find` per file at 93–99;
    - run the favourite, visibility and derived drains with `Promise.all` (they are independent) instead of sequentially at 413–415.
  - tag-batch.ts: `_http`, `_collections` and `_onFileVerified` (42–46, 142–144) are unused. Collapse `renameTagOnFiles`, `deleteTagOnFiles`, `mergeTagsOnFiles` and `applyTagMutatorOnFiles` (72–154) into one `queueTagMutation(files, mutator, { wait })` in tag-outbox.ts. Then remove the dead plumbing at library-store.ts:1197–1205, 1225–1232, 1264–1272 and 1931. This pairs with §3.3c (`rewriteTags`).
- **Files:** lib/tag-outbox-runner.ts, hooks/use-library-bootstrap.ts, lib/tag-batch.ts (delete), stores/library-store.ts.
- **Est. LOC saved:** about 300 (runner about 120, bootstrap about 60, tag-batch about 120).
- **Risk:** medium.
- **Crypto-sensitive:** no.
- **Order:** 6th, after 4.1.

**4.8 Fix the core → lib layering.**
- **What:**
  - core/metadata.ts imports `@/lib/tags`, `@/lib/tag-writes` and `@/lib/sort-files`. Have it take the already-built organizer block as data, and move tag building to lib.
  - core/api/collection-files.ts imports `@/lib/favorites`. Move `hashAndTypeKey` into core, or pass it in.
  - Replace the local `splitByPredicate` (collection-files.ts:60–74) with ente-utils/array `splitByPredicate`.
  - Merge `putPublicMetadataList` (94–118, no external use) and `putPrivateMetadata` (145–178) into one `putMetadata(path, body)`.
  - Unify `putPublicMetadata` (126–143) and `prepareFilesTagMetadata` + `applyPreparedTagMetadata` (278–318) on one `encryptPubMagic(file, mergedData)` helper.
  - `fileWithOrganizerTags` in tag-writes.ts:123–142 re-implements the "version > 0 ? version : …" rule; route it through the same helper.
- **Files:** core/metadata.ts, core/api/collection-files.ts, lib/tag-writes.ts, lib/favorites.ts.
- **Est. LOC saved:** about 80.
- **Risk:** medium.
- **Crypto-sensitive:** yes. The shared helper must keep `createMagicMetadata` → encrypt → `{ version: sent + 1, count, data: merged }` and the `{ ...existing.data, ...updates }` merge order exactly.
- **Order:** 7th, together with 4.4.

**4.9 Replace hand-rolled helpers with ente-utils / ente-base, and trim script-only core API.**
- lib/batched.ts:3–9 `batch` → ente-utils/array `batch`. Keep `mapBatched`.
- lib/with-timeout.ts → ente-utils/promise `withTimeout`. The local copy only adds a custom message.
- lib/bytes-blob.ts `arrayBufferFromUint8Array` and the gzip.ts copy → ente-base/bytes `ensureArrayBufferBacked`.
- download.ts:99–104 concatenation → ente-utils `mergeUint8Arrays`.
- Seven local sleep/yield helpers → ente-utils `wait`: derived-replace-queue.ts:23, tag-write-pipeline.ts:33–34, organizer-config-save-queue.ts:11, db/crypto.ts:35–38, encrypt-upload-file.ts:69, download.ts:141 and 152, remote.ts:172.
- ente-core.ts:114–170 and 279–293 (`syncCollectionFiles`, `syncLibrary`, `findFileById`), plus `getDecryptedThumbnail` and `getPublicMetadata`, are called only from scripts/ (ente-cli.ts, m0-spike.ts, debug-sync-flow.ts, test-compress-encode.ts). `findFileById` re-downloads and decrypts every collection to find one file. Move these into a script-side helper or delete them with the scripts (§6). The same applies to core/api/files.ts:70–104 `syncCollectionFiles`.
- **Est. LOC saved:** about 180.
- **Risk:** low.
- **Crypto-sensitive:** no.
- **Order:** any time.

### Proposed module map (before → after)

```
core/
  api/http.ts                 → api/http.ts (+HTTPError from ente-base, +retryWithBackoff; one 401 path)
  metadata.ts                 → metadata.ts (no @/lib imports; one putMetadata + encryptPubMagic) [crypto]
  download.ts                 → download.ts (uses retryWithBackoff; one fetch fn parameterised by URL)
  upload/remote.ts            → upload/remote.ts (uses retryWithBackoff; XHR path reuses abortableTimeout)
  api/files.ts                → api/files.ts (minus syncCollectionFiles → scripts)
  ente-core.ts                → ente-core.ts (minus script-only methods)
db/
  kv.ts (486)                 → kv.ts (~230: typed KvValues + loadKv/saveKv + appendChunk/loadChunks)
  thumbnails.ts (296)         → thumbnails.ts (~15, instance)
  file-ciphertexts.ts (254)   → file-ciphertexts.ts (~15, instance)
  lru-touch.ts                → folded into blob-store.ts
  (new) blob-store.ts         ← createLruBlobStore + wrapBytes/unwrapBytes (~220)
  file-shards.ts (353)        → file-shards.ts (~270: no meta, no legacy, parallel decrypt, one tx)
  index.ts (258)              → index.ts (~200: table-driven upgrade)
  derived-replace-payloads.ts, tile-embeddings.ts → same files on wrapBytes
lib/
  (new) outbox.ts             ← createOutbox + registry + single hide listener + flushAll (~120)
  durable-flush.ts            → merged into outbox.ts
  tag-outbox.ts               → tag-outbox.ts (domain: overlay, mergeAhead [crypto], queueTagMutation)
  tag-batch.ts                → deleted (into tag-outbox.ts)
  favorite-outbox.ts          → favorite-outbox.ts (domain: key, reconcile)
  favorite-membership.ts      → favorite-membership.ts (on the same persisted-state factory)
  visibility-outbox.ts        → visibility-outbox.ts (domain: overlay [crypto: private magic spread])
  derived-replace-outbox.ts   → derived-replace-outbox.ts (domain only)
  tag-outbox-runner.ts        → outbox-runner.ts
  tag-write-pipeline.ts (258) → tag-write-pipeline.ts (~90)
  tags.ts (1253)              → tags.ts (~350: extract/index/system tags)
                                + tag-filter.ts (~550: SCOPES table, evaluate/describe/count)
  tag-filter-mutations.ts     → tag-filter-edit.ts (one setTagFilterScopes + tagFilterActions from §2.1a)
  tag-writes.ts + tag-bulk.ts normalize → tag-writes.ts (one normalizeTagNameList(names, max?))
  query-albums.ts             → query-albums.ts (Omit<…,"id"> + spread serialize/hydrate)
  batched.ts, with-timeout.ts, bytes-blob.ts → deleted / reduced to mapBatched
```

### Findings

- `lib/favorite-outbox.ts:229–251` — efficiency — `reconcileFavoriteOutboxWithLibrary` already calls `deriveFavoriteFileIDs` once (229), then calls `isFileFavorited` per entry (241). That re-runs the full derive, including a `filesById` map and `metadataHash` over every file, so the cost is O(entries × files) and the check is redundant with line 247. → Use only `favoriteFileIds.has(entry.fileId) === entry.isFavorite` (−8).
- `lib/favorites.ts:229–241, 102–120` — efficiency — `fileIdsForFavoriteUpdate` scans all files per hash-keyed unsynced update, giving O(updates × n) inside `deriveFavoriteFileIDs`. → Build a hash→non-owned-ids map once per derive (−0 net, large CPU saving).
- `lib/favorites.ts:211–214, 226–227` — simplify — Comment-only no-op blocks. → Delete (−6).
- `stores/library-store.ts:577` — efficiency — `isFileFavorited` does a full library derive per toggle. → Read `useFavoritesStore.getState().favoriteFileIds.has(id)` (−8).
- `lib/favorite-membership.ts:111–113` — simplify — `beginFavoriteMembershipFullSync` is an alias of `resetFavoriteMembershipForFullSync`; its only caller is sync/pull-files.ts:151. → Delete the alias and call reset (−4).
- `lib/tag-outbox.ts:99–117 vs 124–152` — simplify — The upsert and enqueue loops are identical. → One `setEntries(entries)` used by both (−15).
- `lib/tag-outbox.ts:75–80; favorite-outbox.ts:79–84; favorite-membership.ts:79–84` — simplify — `ensureXHydrated` is identical to `hydrateX`, since both early-return on `hydrated`. → Keep one (−18). The factory covers this.
- `lib/tag-outbox.ts:116, 139; favorite-outbox.ts:118` — efficiency — Every enqueue re-encrypts and puts the whole outbox, so N rapid clicks cause N full writes. → Coalesce with a dirty flag in the persist chain (folded into 4.1).
- `lib/derived-replace-outbox.ts:144–147` — efficiency — Deletes are awaited sequentially in a loop. → `Promise.all` or a single persist (−2).
- `lib/derived-replace-queue.ts:117–127 vs 162–170, 134–139 vs 149–157` — simplify — The revive and coalesce branches are duplicated inside the drain loop. → Extract `takeNext()` (−30). Local `toError` and `yieldToCoalesce` (19–23) → ente-utils `wait` (−5).
- `lib/visibility-outbox.ts:164–192 vs tag-outbox.ts:233–251` — simplify — Same overlay shape. → One `overlayFiles(files, entries, patchFn)` (−15). Crypto-sensitive: the visibility patch spreads private `magicMetadata.data` and must stay as is.
- `lib/tag-write-pipeline.ts:229` — altitude — Tautological verify on the batch result. → Treat every returned file as verified (−6).
- `lib/tag-write-pipeline.ts:13–29` — simplify — `TagWriteResult`, `TagBatchWriteResult`, `tagMetadataBatchSize` and `writeAndVerifyTags` are exported but internal or test-only. → Un-export or delete under 4.4.
- `core/api/http.ts:68, 129–131` — simplify — `authFetch` and `authFetchResponse` each run the 401 → `notifyUnauthorized` path. → `authFetch` delegates to `authFetchResponse` (−10).
- `core/download.ts:120–160, 122` — simplify — `fetchEncryptedBytes` takes an unused `session` parameter, and `fetchEncryptedFile` (242–261) duplicates `fetchEncryptedThumbnail` except for the URL. → One function parameterised by URL (−25).
- `core/upload/remote.ts:239–298 vs 72–93` — simplify — The XHR progress path re-implements abort plus timeout. → Reuse `abortableTimeout` (−20).
- `core/upload/remote.ts` — simplify — `PutFileOptions`, `PutEnteFileUpdateRequest/Response` and `UploadedFileObjectAttributes` are exported but used only internally. → Un-export.
- `db/index.ts:160–193` — simplify — `upgrade()` is a chain of `if (!contains) createObjectStore`. → Loop over a `[name, options, indexes]` table (−20).
- `db/index.ts:246–247` — simplify — `unbindOrganizerDB` dynamic-imports file-shards to clear its cache. → file-shards registers a reset hook (the §3.7 session-reset registry), or db/index owns the cache (−5).
- `db/kv.ts:52–70` — simplify — The dynamic-import wrappers `loadEncryptedFiles` / `saveEncryptedFiles` and the `markLibraryCacheFilesDirty` re-export are indirection. → Callers import file-shards directly (−18).
- `db/file-shards.ts:233–235` — efficiency — Shards are decrypted sequentially. → `Promise.all` (−0, faster cold start).
- `db/file-shards.ts:332–339` — efficiency — Per-shard put/delete is awaited in a loop. → One readwrite transaction (−3).
- `db/tile-embeddings.ts:69–92` — efficiency — `getTileEmbeddingsFor` gets and decrypts sequentially. → `Promise.all` (−2). Goes away entirely if the tile pilot is removed (§5.1).
- `lib/sync/pull-files.ts:190–202` — efficiency — Per changed file it does two sequential awaits plus a dynamic import, and copies the whole phash `Map`, which is O(changes × entries). → Collect the changed ids, then do one batched invalidate and one `setEntries` (−8).
- `lib/sync/pull-files.ts:74` — efficiency — `saveLibrarySnapshot` loads and decrypts trash items at every checkpoint (every two collections). → Load trash ids once per pull (−2).
- `lib/sync/pull-files.ts:57–68` — efficiency — Cursor saves are sequential. → One transaction or `Promise.all` (−2).
- `lib/sync/pull-files.ts:136–138 and core/ente-core.ts:147–149` — reuse — Manual "slice by concurrency + `Promise.all`" loops. → `mapBatched` (−6).
- `lib/thumbnail-cache.ts:400–450 vs 483–496` — simplify — The "IDB ciphertext, else fetch + fire-and-forget put" logic is written twice. → One `loadThumbnailCiphertext(file)` used by both (−15).
- `lib/thumbnail-cache.ts:165–173` — simplify — The "single thumbnail larger than the 96 MB budget" branch cannot happen for thumbnails. → Delete (−9).
- `lib/view-sessions.ts:36–39, 106–128` — simplify (derivable state) — `totalViewTimeMs` and `uniqueFileIds` are never read outside the module. `totalViews` and `lastViewedFileId` are just `views.length` and `views.at(-1)` (read at pages/recents.tsx:201–210). → Drop the cached aggregates; `parseCloudViewSessions` (442–456) already recomputes them, so stored payloads stay compatible (−40).
- `lib/view-sessions.ts:488–523` — simplify — `cloudViewSessionsEqual` hand-compares fields after normalising. → Compare `JSON.stringify` of the two normalised payloads (−25).
- `lib/tag-writes.ts:25–37 vs tag-bulk.ts:170–188` — simplify — `dedupeTags` and `normalizeTagNameList` are the same loop. → `normalizeTagNameList(names, max = Infinity)` (−14).
- `lib/tags.ts:383–400, 464` — efficiency — `buildTagIndex` excludes system tags, so the cropped/rotated predicates call `extractTags` per file on every filter and count pass. → Index system tags too, use set lookups, and drop the skip at 464 (−10, fewer decodes).
- `lib/tags.ts:618` — efficiency — `exactUserTagSetIds` builds a `fileById` `Map` per call. → Pass it in via the filter `ctx` (−3).
- `lib/session-persistence.ts:47–136` — simplify — Eight `isBrowser()` guards in a client-only module. → Guard once at the call sites or drop them (−20).
- `lib/site-wipe.ts:96–98` — efficiency — Three independent sequential awaits. → `Promise.all` (−1).

### Dead code / deletions

Method: grep over src/ and scripts/, excluding the defining file and `__tests__`. §6 has the project-wide sweep.

**No production use (delete; adjust tests):**
- db/derived-replace-payloads.ts:80–90 `clearDerivedReplacePayloads`. It is only mocked in mutation-outbox.test.ts:25.
- lib/sync/merge-files.ts `filterFilesForCollection`.
- lib/tags.ts:1074–1096 `countFilesMatchingTagFilter`.
- lib/tag-filter-mutations.ts:664 `kitIsIncluded`.
- lib/tag-outbox.ts:157–162 `upsertTagOutboxEntry`.
- lib/tag-types.ts:131 `filterKitNearnessTags`; tag-types.ts:149 `sortTagsByUsage`.
- lib/query-albums.ts:148 `emptyPersistedTagFilter`.
- lib/tag-presets.ts:222 `countFilesMatchingKitExact`; tag-presets.ts:288 `formatKitSuggestionName`.
- core/upload/upload-url-pool.ts `takeUploadURL`.
- lib/local-media.ts `isImageFile`.
- lib/favorite-membership.ts:111–113 `beginFavoriteMembershipFullSync` (alias; switch its one caller).
- core/metadata.ts:94–118 `putPublicMetadataList`. It is only self-referenced; merge per 4.8.
- `resetDerivedReplaceQueueForTests` and `LruTouchCoalescer.hasPending`. These are test hooks; tests should use the public API.
- Unused parameters `_http`, `_collections` and `_onFileVerified` in lib/tag-batch.ts:42–46 and 142–144, plus their arguments at stores/library-store.ts:1197–1205, 1225–1232, 1264–1272 and 1931.
- The `"files"` member of `KvKey` (db/index.ts) and all legacy shims listed in 4.6.

**Exported but used only in tests or inside their own file (un-export):**
- lib/tag-write-pipeline.ts: `writeAndVerifyTags` (deleted under 4.4), `tagMetadataBatchSize`.
- core/upload/remote.ts:157–176: `withUploadRetry` (replaced under 4.4).
- lib/view-sessions.ts: `shouldResumeSession`, `recomputeSessionAggregates`, `remapSessionFileId`, `formatSessionDuration`, `sessionSpanMs`.
- lib/query-albums.ts: `hydrateTagFilter`, `newQueryAlbumId`.
- lib/tags.ts: `isManuallyRotatedFile`, `fileMatchesTagFilter`, `evaluateTagFilterNode`, `createEmptyTagFilterRoot`, and the `SYSTEM_TAGS` / `*_FILTER` constants (replaced by `SCOPES` under 4.5).
- lib/tag-bulk.ts: `pushRecentTag`.
- lib/favorites.ts: `fileIdsForFavoriteUpdate`.
- lib/collections.ts: `isHiddenCollection`.
- lib/favorite-outbox.ts: `removeFavoriteOutboxEntries`.
- lib/derived-replace-outbox.ts: `ensureDerivedReplaceOutboxHydrated`.
- lib/durable-flush.ts: `requestDurableFlush`, `hasPendingDurableOutbox`.
- lib/app-settings.ts: `clampSimilarMaxGroupSize`, `DEFAULT_SIMILAR_MAX_GROUP_SIZE`.
- lib/session-persistence.ts: `sessionMaxAgeMs`.
- core/api/user-details.ts: `planStorageBytes`.
- core/session.ts: `clientPackageName`.
- core/download.ts: `BytesProgress`.
- db/file-shards.ts: `dirtyFileShardIdsFromUpdation`, `resolveDirtyFileShardIds`, `fileLibraryShardId`, `FILE_LIBRARY_SHARD_COUNT` (test-only).
- Internal-only exported types: `FileShardsMeta`, `KvRecord`, `SyncCursorRecord`, `EmbeddingChunkRecord`, `PhashChunkRecord`, `OrganizerDB`, `PersistedPhashMeta`, `PersistedEmbeddingIndex`, `EmbeddingChunkPayload`, `PersistedViewSessions`, `LruTouchWriter`, `Pull*Result`, `PullFilesOptions`, `TagOutboxDrainStats`, `TagOutboxRunnerContext`, `TagOutboxEntry`, `MapBatchedOptions`.

**Used only by scripts/ (move into scripts or delete with them):**
- core/ente-core.ts:114–131 `syncCollectionFiles`, 133–170 `syncLibrary`, 279–293 `findFileById`, plus `getDecryptedThumbnail` and `getPublicMetadata`.
- core/api/files.ts:70–104 `syncCollectionFiles`.


---

## 5. Background jobs, ML and media processing

**Overview.** This area is about 16.6k LOC: about 13.9k in `src/lib` (kit-*, similarity-*, compress*, phash, quality, sort and layout helpers), 1,939 in `src/workers`, 513 in `src/lib/transcode` and 317 in `src/lib/ffmpeg`. There are four main problems.

1. **Research code ships in `src/lib`.** Corpus eval, majority eval, CLIP eval, the legacy dHash medoid nearness path and the tile-embedding pilot add about 2.4k lines. Production never calls them.
2. **The postMessage worker client is hand-written 8 times.** There are 8 `new Worker` sites, each with its own requestId map, error rejection and idle handling. `createWorkerIdleTimer` is used at only 4 of them.
3. **Job loops are copied.** `image-quality-job.ts` has verbatim copies of `runWithConcurrency`, `waitIfPaused`, the worker-count function and the cached/network split from `similarity-job.ts`. Separately, the phash and quality scans each fetch and decode the same thumbnails.
4. **Small duplications everywhere:**
   - 3 PRNGs
   - 2 shuffles
   - 2 L2-normalizers
   - 2 embedding packers
   - 2 magic-byte format detectors
   - sync/async twins of the stage-1 clustering
   - dead worker message types

Estimated achievable reduction is about 3.5–4k LOC (around 22–25%) taken out of `src/`. About 2.4k of that moves to `scripts/` and is not deleted outright.

Not read in detail: `kit-nearness-margins.ts` body, `masonry-layout.ts`, `organizer-config*.ts`, `transcode/webcodecs-h264.ts`, `compress-classify.ts`. The findings below do not cover them beyond import checks.

### Structural proposals (biggest wins first)

**5.1 Move research and eval code out of `src/lib` into `scripts/lib/`.**
- **What:**
  - Move `kit-nearness-corpus-eval.ts` (322), `kit-nearness-corpus-eval-fast.ts` (378), `kit-nearness-majority-eval.ts` (284) and `similarity-clip-eval.ts` (94).
  - Move the legacy dHash medoid half of `kit-nearness-sort.ts` (about lines 26–692, roughly 600 lines). The file's own header at line 9 says it is "Legacy dHash medoid helpers remain for offline corpus GA / eval harnesses".
  - Move the GA helpers from `kit-nearness-embedding-genome.ts`: `KIT_EMBEDDING_GENE_SPECS` at :67 and the values↔genome converters at :143–160.
  - Decide on `kit-nearness-corpus-export.ts` (428) and the tile pilot (`kit-tile-embedding-job.ts` 227 + `kit-tile-layout`). Both are reached only from ManageSettingsPanel dev buttons (:517/:527/:1022). Either delete the buttons and move the code to scripts, or keep them as dev-only dynamic imports. Recommendation: move them. The pilot header says "local builds only".
- **Why:** Production imports none of this (see the dead-code list at the end of this section). It makes `kit-nearness-sort.ts` 3× larger than the part the app uses. It also forces option bags (colorBonus, colorRadius, structureGate) through five functions.
- **Files:** the files above, plus `src/lib/__tests__/kit-nearness*.test.ts` (move with the code), and the `scripts/*.ts` import paths.
- **Est. LOC out of src:** about 1,700 for the eval files and legacy path, plus about 650 if export and the tile pilot also move.
- **Risk:** low. This is an import-path change only, and tsc catches misses.
- **Order:** 1st.

**5.2 Add one small worker client and delete 7 hand-written ones.**
- **What:** add `src/lib/worker-client.ts`, about 80 lines. It does:
  - `createWorkerClient<Req, Res>({ url, idleMs, poolSize })`
  - lazy creation
  - `request(msg, transfer)` with requestId routing
  - reject-all on `error`, `messageerror` and terminate
  - optional round-robin pool
  - built-in idle timer, which absorbs `worker-idle-timer.ts` (49)
- **Sites it replaces:**
  - `relative-sort-job.ts:39–110`
  - `kit-nearness-margins-job.ts:278–320`
  - `image-quality-job.ts:42–136`
  - `similarity-job.ts:42–100` (the pool) and `:479` (the stage-1 one-off)
  - `border-scan-job.ts:14` (currently has no error listener, so a worker crash hangs the promise)
  - `compress.ts:413–506`
  - the three pending maps in `kit-embedding.ts:111–143` and `:187–268`
- **Why:** The same 40–90 lines are repeated eight times with drifting behaviour. Only 4 of 8 sites have idle termination, and only some reject on worker error.
- **Alternative:** `ente-base/worker/comlink-worker.ts` (ComlinkWorker) already exists. It was avoided only for upload-crypto because of the iOS hang notes. If those notes do not apply to these workers, Comlink would remove the request/response types too. Prefer the 80-line client if the iOS concern is real.
- **Est. LOC saved:** 400–500.
- **Risk:** medium, because it touches every background job. Migrate one worker at a time, starting with relative-sort, the simplest.
- **Order:** 2nd.

**5.3 Add one job-utilities module and dedupe the scan loops.**
- **What:** move `runWithConcurrency` (`similarity-job.ts:270`), `waitIfPaused` (:289), `imageFilesForPhash` (:225, renamed `eligibleImageFiles`), a `workerCount()` and a throttled `progressReporter` into `src/lib/job-utils.ts`.
- **Delete these copies:**
  - `image-quality-job.ts:42–47`, `:165–195`
  - the duplicate progress throttles in `kit-embedding.ts:604–623` and `kit-tile-embedding-job.ts:85–93`
  - the local `throwIfAborted` copies in `kit-nearness-embedding-tune.ts:70` and `similarity-groups.ts:326`
- **Why:** Other domains (kit-embedding, image-quality-job, kit-tile-embedding-job, use-media-display-pipeline, ManageSettingsPanel) currently import these generic helpers from `similarity-job`, which is a misleading home. image-quality-job keeps verbatim copies anyway.
- **Est. LOC saved:** 100–130.
- **Risk:** low.
- **Order:** 3rd.

**5.4 Merge the phash and quality scans into one thumbnail-analysis pass.**
- **What:** `runPhashJob` and `runImageQualityJob` each iterate `imageFilesForPhash`. Each runs its own cached/network split (`similarity-job.ts:347–356,414–417` vs `image-quality-job.ts:226–235,285–288`) and its own `processOne` loop (`image-quality-job.ts:251–283`). Each worker separately fetches, decodes and rasterizes the thumbnail (`phash.worker.ts:172–189`, `image-quality.worker.ts:45–57`). Make one worker decode once and return `{ phashEntry, qualityScore }`, and have one job persist both indexes. `border-scan.worker.ts:124–148` decodes the same thumbnails again and could become a third output.
- **Why:**
  - Removes one full decrypt+decode pass over the library.
  - Removes one worker pool (2–8 workers).
  - Removes one job file's loop.
- **Est. LOC saved:** 200–250, and roughly halves the scan CPU and IO.
- **Risk:** medium. The two indexes have separate version invalidation (`QUALITY_INDEX_VERSION`), so a version bump in one must not force recomputing the other. Persist them separately but compute them together.
- **Order:** 4th, after 5.2 and 5.3.

**5.5 Collapse the stage-1 clustering sync/async twins.**
- **What:** `similarity-stage1-core.ts` has two pairs of near-duplicate functions:
  - `runClipNearestClusteringCore` (:476–507) and `runClipNearestClusteringAsync` (:512–578)
  - `runStage1ClusteringSync` (:631–658) and `runStage1Clustering` (:667–790)

  The sync versions serve only `buildSimilarityGroups` (`similarity-groups.ts:221–238`, which is test-only), `similarity-clip.test` and 6 scripts. Keep the async version and have tests and scripts `await` it.
- **Also:**
  - Throttle the dHash-path `onProgress` (:743–754). It currently fires once per file, which means one postMessage per file from the worker.
  - Drop the re-exports at :41–46.
- **Est. LOC saved:** about 130.
- **Risk:** low.
- **Order:** 5th.

**5.6 Use one gallery-ordering registry instead of six parallel sort states.**
- **What:** The orderings are already mutually exclusive: `ui-store.ts:281–296` `clearOrderings` resets all of them. They are still stored as six separate fields (`viewportFitSort`, `uploadedAtSort`, `imageSizeSort`, `imageQualitySort`, `tagFilterFitSort`, `relativeSort`), each with its own setter (:309–356). There are also six `if` branches in `use-media-display-pipeline.ts:717–770` and four near-identical "none → copy / sort by key with id tie-break" functions:
  - `image-size-sort.ts` (37)
  - `uploaded-at-sort.ts` (30)
  - `image-quality.ts:215–240`
  - `viewport-fit.ts:111–140`
- **Replacement:** one `galleryOrder: { kind, direction } | undefined` in the store, plus one `sortFilesByScore(files, scoreOf, ascending, unknownLast)` helper. Each kind contributes only its `scoreOf`. Delete `image-size-sort.ts` and `uploaded-at-sort.ts`.
- **Est. LOC saved:** about 80 in lib, plus about 60 in the store and pipeline. See also §3 and §1, which cover the store and pipeline.
- **Risk:** low–medium.
- **Order:** 6th.

**5.7 Share vector, PRNG and format helpers.**
- **PRNG and shuffle:**
  - Keep `createRng` + `shuffleInPlace` in `shuffle-files.ts:4–21` (real mulberry32) and export them.
  - Delete `kit-nearness-embedding-eval.ts:51–60`. It is an LCG misnamed `mulberry32`, plus a duplicate shuffle.
  - Delete the inline mulberry step in `relative-sort-packed.ts:99–104`.
- **Embedding vectors:**
  - Keep `packRelativeEmbeddings` (`relative-sort.ts:37`), renamed `packEmbeddings`, and delete `similarity-job.ts:596–622` `packStage1Embeddings`.
  - Share one `l2NormalizeEmbedding` between `kit-embedding.ts:342–361` and `clip-embedding.worker.ts:205–221`.
  - Delete the inline normalize in `kit-nearness-sort.ts:882–889`.
- **Image format detection:** move `detectImageFormatFromBytes` (`compress.ts:129–200`) into a pure `image-format.ts` and delete the copy in `compress.worker.ts:26–92`.
- **Est. LOC saved:** about 170.
- **Risk:** low.
- **Order:** any time. Good first PR.

**5.8 Simplify the CLIP embedding transport.**
- **What:**
  - The worker returns `vector?: number[]`, so JS arrays are structured-cloned. The main thread then repacks with `packEmbeddingVector` (`kit-embedding.ts:736`). Return a `Float32Array` and transfer it instead.
  - `hydrateEmbeddingIndex` (:374–392) re-normalizes and reallocates every stored vector on each boot. Stored vectors are already normalized, so drop that.
  - Replace the producer/consumer ready queue with its two waiter arrays (:625–745) with chunked prefetch, the same fetching-array pattern used in `kit-tile-embedding-job.ts:153–193`.
  - Delete the duplicate `MODEL_ID`/`EMBEDDING_DIMS` in `clip-embedding.worker.ts:30–31`.
  - Delete the unused `fp16`/`q8` dtype options and the unread `modelId` in init-done.
- **Est. LOC saved:** about 120, plus less boot-time allocation for large libraries.
- **Risk:** medium, because the embedding index is persisted. Keep the on-disk format unchanged.
- **Order:** after 5.2.

### Findings

**kit-nearness-sort.ts**
- `src/lib/kit-nearness-sort.ts:9` — altitude — The header admits lines 26–692 are an offline-only legacy path → move to `scripts/lib/kit-nearness-legacy.ts` (~600).
- `src/lib/kit-nearness-sort.ts:298–373` vs `:754–853` — reuse — `pickKitMedoids` and `pickKitEmbeddingMedoids` have the same densest-first/farthest-first structure → this disappears once the dHash variant moves (counted above).
- `src/lib/kit-nearness-sort.ts:859` — simplify — The comment says the centroid is "kept for eval/export helpers; production ranking uses medoids". In fact `DEFAULT_KIT_EMBEDDING_GENOME.useCentroid` is 1 and production does use it → fix the comment, or drop `useCentroid` as a knob if it is always 1 (~15).
- `src/lib/kit-nearness-sort.ts:882–889` — reuse — inline L2 normalize → call `l2NormalizeEmbedding` (6).

**kit-nearness-embedding-genome.ts and -tune.ts**
- `src/lib/kit-nearness-embedding-genome.ts:24–26,67,143–160` — altitude — GA leftovers. The gene specs and the values↔genome converters are used only by `tune.ts` and `scripts/kit-nearness-s2-pass3.ts` → move the specs to scripts, and build the tune grid directly as genome objects (~40).
- `src/lib/kit-nearness-embedding-tune.ts:59–91,169–178` — simplify — The grid only varies lambda (5) × tau (3). `evaluate` round-trips genome→values→genome, and the `toFixed`-keyed cache only ever hits for the default cell → loop over 15 `{...DEFAULT, lambda, tau}` objects and drop the cache (~50).
- `src/lib/kit-nearness-embedding-tune.ts:65` — efficiency — About 16 evaluations run on the main thread with `yieldToUi`. This breaks the CPU-on-workers rule → run them inside the existing kit-nearness-margins worker, or at least the scoring loop (no LOC saved, but it frees the main thread).

**kit-nearness-embedding-eval.ts**
- `src/lib/kit-nearness-embedding-eval.ts:51–57` — reuse — The function named `mulberry32` is actually an LCG; it is a third PRNG → import `createRng` from `shuffle-files.ts` (7).
- `src/lib/kit-nearness-embedding-eval.ts:60` — reuse — duplicate of `shuffleInPlace` at `shuffle-files.ts:15` → export and reuse it (8).
- `src/lib/kit-nearness-embedding-eval.ts:207` + `kit-nearness-embedding-tune.ts:150` — efficiency — `listEmbeddedKitMembers` is computed per rival in both the fold builder and tune → compute once per tune run and pass it in (~10).

**relative-sort**
- `src/lib/relative-sort.ts:18,26` — simplify — The re-export of `pickRelativeStartIndex` plus `pickRelativeStartId` are used only by `relative-sort.test.ts` → have the test call `pickRelativeStartIndex` and delete both (~8).
- `src/lib/relative-sort-job.ts:5–23` vs `src/workers/relative-sort.worker.ts:5–20` — reuse — the request/response interfaces are declared twice → one `relative-sort-worker-types.ts`, as the other workers already do (~18).

**similarity-job.ts**
- `src/lib/similarity-job.ts:225,270,289` — altitude — generic job helpers live in the similarity module and are imported by unrelated domains → `job-utils.ts` (5.3).
- `src/lib/similarity-job.ts:368–407` — simplify — a hand-rolled semaphore (`hashSlotWaiters`) on top of `runWithConcurrency` → it is redundant once the worker client caps in-flight requests per pool (~35).
- `src/lib/similarity-job.ts:596–622` — reuse — `packStage1Embeddings` duplicates `packRelativeEmbeddings` → delete (25).

**image-quality-job.ts**
- `src/lib/image-quality-job.ts:165–195` — reuse — verbatim copies of `runWithConcurrency` and `waitIfPaused` → import them (31).
- `src/lib/image-quality-job.ts:42–47` — reuse — `qualityWorkerCount` duplicates `phashWorkerCount` → `workerCount()` (6).
- `src/lib/image-quality-job.ts:128`, `src/lib/kit-embedding.ts:328` — efficiency — `bytes.slice()` copies each thumbnail before transfer. Freshly decrypted bytes are owned → transfer the buffer directly, or copy only when the cache keeps a reference (2 each, but saves one copy per file).
- `src/workers/image-quality.worker.ts:45–57`, `src/workers/border-scan.worker.ts:124–148` — efficiency — `Uint8Array.from(bytes)` copies again inside the worker → pass bytes straight to `new Blob([bytes])` (2 each).

**border-scan-job.ts**
- `src/lib/border-scan-job.ts:14` — simplify — the worker has no `error` listener, so a crash leaves the promise pending forever, and it recycles every 80 jobs → use the worker client (5.2) (~30).

**phash**
- `src/workers/phash-worker-types.ts:26–46`, `src/workers/phash.worker.ts:106–123` — dead — The single `crop-check` message has no senders; only the batch path is used → delete (~40).

**similarity-stage1-core.ts**
- `src/lib/similarity-stage1-core.ts:476–578`, `:631–790` — simplify — sync/async twins (5.5) (~130).
- `src/lib/similarity-stage1-core.ts:743–754` — efficiency — per-file `onProgress` in the dHash path → throttle every N files or every 100 ms (net 0).

**similarity-groups.ts**
- `src/lib/similarity-groups.ts:221–238` — dead in app — `buildSimilarityGroups` is used only by tests and scripts → delete it with the sync clustering; tests call the async path (~20).
- `src/lib/similarity-groups.ts:551–606` — simplify — The cached/uncached split builds three parallel arrays (`cachedMatches`, `uncachedPairs`, `uncachedSlots`) and then re-walks `activePairs` → filter uncached pairs, await verdicts, write them to the cache, then do one pass of `if (getCachedCropVerdict(...)) union` (~20).
- `src/lib/similarity-groups.ts:514–534` — simplify — the `allCached` pre-scan is a special case of the main loop when every verdict is cached → delete it; the loop already skips worker calls for cached pairs (~18).

**kit-embedding.ts and clip-embedding.worker.ts**
- `src/lib/kit-embedding.ts:266` + `src/workers/clip-embedding.worker.ts:404–422` + `clip-embedding-worker-types.ts:15–21,62–69` — dead — The comment at :266 says "legacy single-embed replies are unused", yet the worker still handles `embed` → delete it (~35).
- `src/lib/kit-embedding.ts:374–392` — efficiency — `hydrateEmbeddingIndex` re-normalizes and reallocates every vector on every boot → trust the stored, already-normalized vectors (~12).
- `src/workers/clip-embedding.worker.ts:205–221` + `kit-embedding.ts:736` — efficiency — `number[]` replies are cloned and then repacked → return a transferred `Float32Array` (~15).
- `src/workers/clip-embedding.worker.ts:30–31` — reuse — duplicate model id and dims constants → import `KIT_EMBEDDING_MODEL_ID` / `KIT_EMBEDDING_DIMS` (2).
- `src/lib/kit-embedding.ts:625–745` — simplify — the producer/consumer ready queue with two waiter arrays → chunked prefetch (~60).

**kit-nearness-margins**
- `src/lib/kit-nearness-margins-job.ts:367,376` + `src/workers/kit-nearness-margins.worker.ts:30–37` — reuse — local `hasEmbedding`, a sample-rank hash and an FNV `hashOf` → reuse the embedding-index `has` and one shared hash (~15).

**compress**
- `src/lib/compress.ts:229,232` — simplify — `canCompressMedia` and `canCompress` are aliases of `isCompressibleMediaType`, used only by `compress.test.ts:6–7,63–71` → delete them and point the tests at the real function (4).
- `src/lib/compress.ts:129–200` vs `src/workers/compress.worker.ts:26–92` — reuse — identical magic-byte detection → one pure `image-format.ts` (~65).
- `src/lib/compress.ts` — altitude — The 616-line file mixes size formatting, localStorage settings (:78–109), format detection, main-thread canvas helpers for crop (:341–397) and the worker client (:413–506) → split the settings and formatting out. The worker client goes away via 5.2 (net ~40).
- `src/lib/compress.ts:600–602` — simplify — `encodeJpegFromBytes` falls back to a main-thread encode, which breaks the CPU-on-workers rule → drop the fallback and surface the error (~5).
- `src/workers/*.ts` — reuse — 24 sites repeat `canvas.getContext("2d")` + `throw "OffscreenCanvas unavailable"` → one `context2d(canvas)` helper in a shared worker util, plus one `decodeToImageData(bytes, maxEdge)` shared by the phash, quality, border-scan, compress and clip workers (~60).

**sort modules**
- `src/lib/image-size-sort.ts`, `src/lib/uploaded-at-sort.ts`, `src/lib/image-quality.ts:215–240`, `src/lib/viewport-fit.ts:111–140` — reuse — four copies of "none → copy; otherwise sort by score with id tie-break" → one `sortFilesByScore` helper (5.6) (~80).
- `src/lib/sort-files.ts:113–126` — fine as is. `sortFilesByUpload/Edit/Update` are used by gallery, albums, ente-core, pull-files and ManageArchivedPanel. `uploaded-at-sort.ts` partly duplicates `sortFilesByUpload` (newest first) → `uploadedAtSort: "newest"` can reuse `sortFilesByUpload`, so only "oldest" needs a reverse (~15).

### Dead code / research code to move or delete

Each item below was checked with Grep against `src/` (excluding `__tests__`) and `scripts/`.

**Research and eval modules with no app importers. Move to `scripts/lib/`.**

| Module | Who imports it |
|---|---|
| `src/lib/kit-nearness-corpus-eval.ts` (322) | `kit-nearness-corpus-eval-fast.ts`, `kit-nearness-majority-eval.ts`, kit-nearness tests, and 10 `scripts/*.ts`. No app code. |
| `src/lib/kit-nearness-corpus-eval-fast.ts` (378) | Only `kit-nearness-corpus-eval.ts` and `kit-nearness-majority-eval.ts`. |
| `src/lib/kit-nearness-majority-eval.ts` (284) | Only `scripts/kit-nearness-majority-ga*.ts`. |
| `src/lib/similarity-clip-eval.ts` (94) | Only `scripts/similar-clip-baseline.ts`. |

**Dev-only feature reached from the app only by a dev button.**
- `src/lib/kit-nearness-corpus-export.ts` (428):
  - The app reaches it only via a dynamic import at `ManageSettingsPanel.tsx:527` (handler :517, button :1022).
  - Eval modules and scripts also import it.
  - It imports `shuffleInPlace` from `kit-nearness-embedding-eval`.
  - Recommendation: move it to scripts with the button, or keep it as a dynamic import and switch to the shared shuffle.

**Pilot code ("local builds only").**
- `src/lib/kit-tile-embedding-job.ts` (227) and `src/lib/kit-tile-layout.ts`:
  - App importers are `ManageSettingsPanel.tsx` (type + `KIT_TILE_LAYOUT_ID`) and `clip-embedding.worker.ts` (`kitTileGrid`, the tile message path).
  - `kit-nearness-corpus-export.ts` also imports kit-tile-layout.
  - Delete them with the pilot button, along with the worker's tile message branch and the third pending map in `kit-embedding.ts`.

**Legacy exports in `src/lib/kit-nearness-sort.ts` (lines about 26–692) with no production callers.**

| Export | Who imports it |
|---|---|
| `pickKitMedoids`, `kitNearnessDistance`, `kitDistance` | Tests, corpus-eval(-fast), scripts. |
| `sortFilesByKitNearness`, `sortFilesByKitNearnessCompetitive`, `kitNearnessDistanceCompetitive` | Tests and `scripts/kit-nearness-validate.ts`. |
| `blendedNearnessDistance`, `rankKitsByBestFitShare` | Tests only. |
| `KIT_COLOR_*`, `KIT_RIVAL_TAU`, `KIT_RIVAL_LAMBDA` | `scripts/kit-nearness-validate.ts` only. |
| `MAX_KIT_MEDOIDS`, `KIT_MEDOID_MIN_SEPARATION` | No external users (internal only). |

These stay in the app:
- `listKitSeedIds` (:120)
- `pickKitEmbeddingMedoids` (:754)
- `buildKitEmbeddingCentroid` (:859)
- `kitEmbeddingMinDistance` (:897, used by `tag-filter-fit-sort`)
- `kitEmbeddingDistanceCompetitive` (:934)
- `kitEmbeddingRivalWeights` (:976)
- `sortFilesByKitEmbeddingCompetitive` (:996)
- `MAX_KIT_SEEDS`
- `fileMatchesKitTags`
- `listKitSeedFiles`

**GA-only helpers.**
- `KIT_EMBEDDING_GENE_SPECS` (`kit-nearness-embedding-genome.ts:67`): used by the genome module itself and `scripts/kit-nearness-s2-pass3.ts`.
- `valuesToKitEmbeddingGenome` / `kitEmbeddingGenomeToValues` (:143–160): used only by `kit-nearness-embedding-tune.ts`.

**Dead in-app paths (delete).**
- `crop-check` single message: `phash-worker-types.ts:26–46` + `phash.worker.ts:106–123`. No sender. `areCropMatches` itself is still used by the batch path, crop-match tests and `scripts/crop-match-validate`.
- `embed` single message: `clip-embedding-worker-types.ts:15–21,62–69` + `clip-embedding.worker.ts:404–422`. No sender (`kit-embedding.ts:266` says so).
- `buildSimilarityGroups` (`similarity-groups.ts:221–238`) and `runStage1ClusteringSync` / `runClipNearestClusteringCore` (`similarity-stage1-core.ts:476–507,631–658`): only tests, `similarity-clip.test` and 6 scripts.
- `pickRelativeStartId` + the `pickRelativeStartIndex` re-export (`relative-sort.ts:18,26–29`): only `relative-sort.test.ts`.
- `canCompress`, `canCompressMedia` (`compress.ts:229,232`): only `compress.test.ts`.

**Checked and live (keep).**

| Module | Live importers |
|---|---|
| `kit-nearness-embedding-eval` | `use-media-display-pipeline.ts:24` (`buildKitEmbeddingPrototypes`) |
| `kit-nearness-embedding-genome` | `use-media-display-pipeline.ts:25`, `tag-presets.ts:16`, `tag-speed-store.ts:17` |
| `kit-nearness-embedding-tune` | `ManageTagsPanel.tsx:67–70` |
| `memory-probe` | ffmpeg, thumbnail-cache, video-edit, VideoEditorOverlay, ManageAutoCropPanel |
| `prepare-local-image`, `transcode/prepare-local-video` | `UploadPanel.tsx` |
| `masonry-layout`, `thumbnail-grid-layout` | `ThumbnailGrid.tsx`, `LocalUploadGrid.tsx` |
| `exact-duplicates` | `pages/manage.tsx` |
| `similarity-match-cache` | `similarity-groups.ts`, `pages/manage.tsx` |
| `compress-classify` | `compress.worker.ts` |
| `gallery-scroll-activity` | 8 importers |


---

## 6. Scripts, tests, dead code and repo hygiene

**Size today:**
- `scripts/`: 20,488 LOC (18,553 ts/mjs and 1,935 md).
- Tests: 78 files, 10,845 LOC including fixtures and `canvas-setup.ts`.
- `src/`: about 1,785 LOC that no app entry point can reach. Entry points counted were `src/pages/*`, `src/sw.ts` and every `new Worker(new URL(...))` target; dynamic imports count as using all exports.
- Repo root: 1,073 LOC of dated audit markdown.

**Achievable reduction:**

| Area | Reduction |
|---|---|
| `scripts/` | about 16–17.5k LOC |
| `src/` | about 1.8k LOC, plus about 0.8k if the tile/corpus research UI is retired |
| Tests | about 0.7–1.0k LOC |
| Root docs | about 1.1k LOC (archive) |
| Dependencies | 2 removed |

None of this changes shipped behaviour.

**Why nothing below is protected today:**
- `scripts/` is excluded from eslint (`scripts/**` in ignores) and from the main tsconfig.
- CI (`.github/workflows/mobileapp-deploy.yml`) runs only `npm ci && npm run build`. No script, test or lint step runs in CI.
- `npx tsc -p scripts/tsconfig.json` reports 284 errors. Most research scripts and two debug scripts no longer type-check against `src/`.

### 6.1 Scripts

`package.json` references only five scripts: `normalize-sw-paths.mjs` (build), `m0-spike.ts` (spike), `ente-cli.ts` (cli), `e2e-local-helpers.ts` (test:e2e:local) and `e2e-post-m8-ux.ts` (test:e2e). Everything else is referenced from docs at most.

**Operational: keep**

| File | LOC | Referenced by | Verdict | Reason |
|---|---|---|---|---|
| normalize-sw-paths.mjs | 15 | package.json `build` | keep | Part of the production build. |
| m0-spike.ts | 133 | package.json `spike` | keep (owner may retire) | Writes to the gitignored `.spike-out/`. If M0 is finished, delete it and its npm script. |
| ente-cli.ts | 216 | package.json `cli` | keep | Dev CLI (login, fetch, `--file-id`). |
| generate-crop-fixture.mjs | 26 | nothing | keep | Generates the `quadrant-4x2.png` fixture used by `crop-rotate.integration.test`. Add a header comment or an npm script. |
| generate-icons.mjs | 71 | nothing | keep | Generates `public/icons`. Add an `icons` npm script. |
| crop-match-validate.ts | 309 | new-frontend.md | keep | Validates the shipped `src/lib/crop-match` against real photos. |

**e2e smokes: keep, consolidated on a shared `scripts/e2e/lib.ts`**

| File | LOC | Referenced by | Verdict | Reason |
|---|---|---|---|---|
| e2e-local-helpers.ts | 75 | package.json | keep | Move onto the shared lib. |
| e2e-post-m8-ux.ts | 163 | package.json | keep | Move onto the shared lib. |
| e2e-upload-smoke.ts | 326 | new-frontend.md | keep + merge | Add an npm script and move onto the shared lib. |
| e2e-recents.ts | 295 | new-frontend.md | keep + merge | Same, and fix its `window` type errors. |
| e2e-thumbnail-memory.ts | 222 | nothing | keep + merge | Proves that eviction never does a `getAll` of ciphertexts. |
| e2e-durability-tools.ts | 136 | ui-and-session-audit.md | merge | Fold into one `e2e-smoke` suite. |
| e2e-compress-followup.ts | 122 | nothing | merge or delete | One-shot smoke; the feature shipped in 0.3.134. |
| e2e-file-shards.ts | 133 | nothing | merge or delete | One-shot smoke. |
| e2e-media-nav.ts | 127 | nothing | merge or delete | One-shot smoke. Its `signIn` is identical to the one in e2e-recents. |
| e2e-organizer-clip.ts | 104 | nothing | merge or delete | One-shot smoke. |
| e2e-quick-rotate.ts | 174 | nothing | merge or delete | One-shot smoke. |

**Debug and probe scripts: delete**

| File | LOC | Reason |
|---|---|---|
| debug-sync-flow.ts | 28 | `ente-cli` covers login plus sync. |
| debug-browser-login.ts | 56 | The e2e `signIn` helpers cover it. |
| debug-tag-picker.ts | 155 | `e2e-post-m8-ux` covers it. |
| debug-crop-editor.ts | 128 | One-off; 22 tsc errors. |
| debug-video-editor.ts | 321 | One-off; 19 tsc errors. |
| test-compress-encode.ts | 135 | mozjpeg measurement for a feature that shipped. |
| test-compress-ui.ts | 110 | Superseded by `e2e-compress-followup`. |
| probe-upload-api.ts | 90 | One-off API probe. |
| compress-followup.md | 175 | The plan has shipped. Delete it or move it to `docs/`, and update the new-frontend.md link. |

**S2 kit-nearness research snapshots: delete.** All were last committed on 2026-09-10.

| File | LOC | Reason |
|---|---|---|
| kit-nearness-s2-research.ts | 1008 | 17 tsc API-drift errors. |
| kit-nearness-s2-deep.ts | 1135 | 9 tsc errors. |
| kit-nearness-s2-pass3.ts | 1270 | 8 tsc errors. |
| kit-nearness-s2-pass3b.ts | 595 | 60% of its lines are shared with pass3. |
| kit-nearness-s2-pass4.ts | 1570 | Superseded by pass5. |
| kit-nearness-s2-pass5.ts | 1363 | The recipe now lives in `src/lib/kit-nearness-margins.ts`. |
| kit-nearness-s2-pass6.ts | 1609 | Negative result ("do not ship"). 55% shared with pass5. |
| kit-nearness-s2-only-tune.ts | 1304 | Not shipped (owner decision). |
| kit-nearness-s2-exact-membership.ts | 1130 | 64% of its lines are duplicated in other scripts. |
| kit-presence-s2.ts | 758 | Shipped as `countKitPresence`; 3 tsc errors. |

`kit-nearness-s2-research.md` (1,574 LOC) is the research record. Move it to `docs/research/` and trim it to the conclusions, replacing script paths with the git SHA of the commit that deletes them.

**dHash-era GA, eval and probe scripts: delete.** All were last committed on 2026-09-08. The dHash scorer is retired.

| File | LOC |
|---|---|
| kit-nearness-ga-search.ts | 642 |
| kit-nearness-ga.ts | 136 |
| kit-nearness-majority-ga-search.ts (78% shared with ga-search) | 416 |
| kit-nearness-majority-ga.ts (only consumer of `src/lib/kit-nearness-majority-eval.ts`) | 154 |
| kit-nearness-validate.ts | 855 |
| kit-nearness-clip-baseline.ts (superseded by pass5) | 455 |
| kit-nearness-baseline.ts | 65 |
| kit-nearness-rival-ablation.ts | 68 |
| kit-nearness-compare-genomes.ts | 54 |
| bench-kit-nearness-eval.ts | 69 |
| probe-kit-coherence.ts | 68 |
| probe-visual-positives.ts | 58 |
| patch-corpus-derived-kits.ts (one-shot data fix) | 51 |
| similar-clip-baseline.ts (only consumer of `src/lib/similarity-clip-eval.ts`) | 33 |
| kit-nearness-ga-notes.md (delete, or fold into the research doc) | 186 |

**Copy-pasted helpers.**
- Research helpers are copied into many scripts: `mulberry32` (13), `shuffleInPlace` (11), `mean` (10), `comboKey`/`DIM` (9), `dot`/`sharesAny`/`hasAll`/`CORPUS_PATH` (8), `l2Normalize` (7), plus matrix, logistic and bootstrap code in four or five scripts each.
  - Some of these already exist in `src/`: `mulberry32`, `shuffleInPlace`, `cholesky` and the solve functions.
  - Deleting the research scripts removes every copy. If any research script is kept, create `scripts/research/lib.ts` that re-exports the `src/` versions.
- e2e helpers: `BASE` is copied in 14 scripts, `signIn` in 13 and `assert` in 10.
  - There are five different base-URL env var names (`E2E_BASE_URL`, `UPLOAD_SMOKE_URL`, `TAG_PICKER_TEST_URL`, `VIDEO_EDITOR_TEST_URL`, `COMPRESS_TEST_URL`).
  - The default URLs also differ: ports 3000, 3001 and 3090, and `127.0.0.1` vs `localhost`.
  - Fix: `scripts/e2e/lib.ts` exporting `BASE` (from `E2E_BASE_URL` only), `launch()`, `signIn(page)` (`/dev-login`, falling back to `/login`) and `assert`. Saves about 150–250 LOC.

**Other script fixes:**
- Every e2e and debug script gets TS6142 because `src/dev/test-account.tsx` contains no JSX. Rename it to `.ts` (see 6.5).
- new-frontend.md links to scripts that no longer exist:
  - `scripts/lib/auth.ts` and `scripts/lib/crypto-shim.ts`: `scripts/lib/` is an empty, untracked directory, and the shim now lives at `src/core/crypto-shim.ts`. Delete the empty directory too.
  - `similarity-spike-real.ts`.
- Optionally add `npm run typecheck:scripts` so the kept scripts stop rotting.

### 6.2 Tests

**Tests of research-only or dead code (delete with the code):**
- `kit-nearness-sort.test.ts`: lines ~109–422 (about 310 LOC) test the retired dHash path. The CLIP tests from line 423 stay.
- `kit-nearness-corpus-eval.test.ts` (72): its module is unreachable from the app.
- `kit-nearness-corpus-export.test.ts` (239): delete only if the corpus-export UI is retired (6.4).

**Tests that exercise a test-only facade:**
- `similarity-groups.test.ts:79–206` (about 130 LOC) calls `buildSimilarityGroups`. That wraps the synchronous `runStage1ClusteringSync` ("Sync Stage-1 for unit tests"), while production uses `runStage1InWorker`.
- Retarget these tests at the shared core that the worker calls, then delete the facade. This keeps the coverage. It is the same change as §5.5.

**Tests that only cover test-only helpers.** Either delete the helper and its test, or remove the `export` and test through the public function.
- `tags.test.ts`: the `countFilesMatchingTagFilter` tests. That function wraps the already-tested `resolveMatchingIds`.
- `sort-files.test.ts`: the `sortFilesByUpdate`, `fileUpdateSortTime` and `moveFilesToFrontByUpdate` describes.
- `crop-editor.test.ts`: the `initialCropForDisplay` and `dimensionsAfterRotation` tests. `video-edit.ts:104` has a private duplicate of `dimensionsAfterRotation`; make it import the crop-editor version so the test covers live code.
- Small cases in the marquee-selection, viewport-fit, merge-files, relative-sort, tag-types and tag-filter-mutations tests.

**Duplicated fixture builders:**
- `stubFile` is defined in 12 files, in varying shapes. Also `toEmb` (7), `fileWithTags` (7), `file` (6), `embMap` (6), `axis` (4), and `userId`, `rgbaImageData`, `includeClause`, `andRoot` and an http fake (3 each).
- Fix: add `src/test-utils/fixtures.ts` (an `EnteFile` builder with overrides, embedding helpers and tag-filter clause builders) and `src/test-utils/fake-http.ts`. Saves about 150–250 LOC and keeps file shapes consistent.

**Keep unchanged:** the crypto, metadata-merge, outbox (mutation-outbox, favorite-outbox-drain, tag-outbox) and sync tests. Their kv mocks are long but specific to each test; share only the `EnteFile` builder with them. These tests are the safety net for §4.1–4.4, so update them in the same PR as the code they cover.

### 6.3 Dead exports and unreachable files in src/

Method: symbol-level reachability from the entry points, then confirmed by grep across `src/`, `scripts/` and tests.

| File | Symbol | LOC | Evidence |
|---|---|---|---|
| src/lib/kit-nearness-corpus-eval-fast.ts | whole file | 379 | Imported only by research scripts. |
| src/lib/kit-nearness-corpus-eval.ts | whole file | 323 | 10 research scripts plus its own test. |
| src/lib/kit-nearness-majority-eval.ts | whole file | 285 | Only the majority-ga scripts. |
| src/lib/similarity-clip-eval.ts | whole file | 95 | Only `similar-clip-baseline.ts`. |
| src/types/global-electron.d.ts | `var electron: any` | 7 | Not referenced anywhere. |
| src/lib/kit-nearness-sort.ts | dHash path | ~401 | Self-described as legacy for the offline GA. See the list below. |
| src/lib/similarity-stage1-core.ts | `runClipNearestClusteringCore`@476, `runStage1ClusteringSync`@631 | ~60 | "Sync Stage-1 for unit tests" (§5.5). |
| src/lib/similarity-groups.ts | `buildSimilarityGroups`@221 | 18 | Test-only facade. |
| src/lib/similarity-groups.ts | `MUTUAL_RANK_K`, `TIGHT_MATCH_DISTANCE`@51 | 2 | Zero references. |
| src/lib/similarity-clip.ts | `findClipTopNeighbours`@100 | 11 | Only the dead sync path and the eval file. |
| src/lib/crop-editor.ts | `fullImageCrop`, `fullFramePixelCrop`, `initialCropForDisplay`, `dimensionsAfterQuarterTurn`, `dimensionsAfterRotation` | ~64 | Tests and debug scripts only. |
| src/lib/sort-files.ts | `organizerUpdatedAt`, `fileUpdateSortTime`, `moveFilesToFrontByUpdate`, `sortFilesByUpdate` | ~38 | Tests only. |
| src/lib/marquee-selection.ts | `keysInContentMarquee`@126 | 25 | Tests only. |
| src/lib/tags.ts | `countFilesMatchingTagFilter`@1074 | 23 | Tests only (also in §4). |
| src/lib/sync/merge-files.ts | `filterFilesForCollection`@102 | 9 | Tests only. |
| src/lib/tag-types.ts | `filterKitNearnessTags` | 6 | Tests only. |
| src/lib/crop-match.ts | `templateMatchScore`@579 | 5 | Keep it exported only while `crop-match-validate` exists. |
| src/lib/crop.ts | `croppedUploadTitle` | 4 | Tests only. |
| src/lib/relative-sort.ts | `pickRelativeStartId` | 4 | Tests only. |
| src/lib/tag-filter-mutations.ts | `kitIsIncluded` | 4 | Tests only. |
| src/lib/viewport-fit.ts | `viewportCropFraction` | 4 | Tests only. |
| src/lib/compress.ts | `canCompressMedia`, `canCompress` | 3 | Tests only. |
| src/lib/query-albums.ts | `emptyPersistedTagFilter` | 2 | Tests only. |
| src/db/derived-replace-payloads.ts | `clearDerivedReplacePayloads`@80 | 11 | Appears only as a `vi.fn` mock. |
| src/db/file-shards.ts | `markLibraryCacheFullyDirty`@78 | ~8 | Re-exported at kv.ts:67–70 and used nowhere else. Remove the re-export too. |
| src/core/index.ts | type re-exports (`SyncLibraryOptions`, `EnteFile`, `EnteCoreConfig`, `FilePublicMagicMetadataData`, `Session`) | ~5 | Nothing imports through `core/index`. |

**The dHash path in kit-nearness-sort.ts (about 401 LOC):**
- Constants: `MAX_KIT_MEDOIDS`, `KIT_MEDOID_MIN_SEPARATION`, `KIT_COLOR_RADIUS`, `KIT_COLOR_BONUS`, `KIT_COLOR_STRUCTURE_GATE`, `KIT_RIVAL_LAMBDA`.
- Medoid helpers: `KitMedoid`, `blendedNearnessDistance`, `structureDistance`, `rankDistance`, `medoidFromEntry`, `pickKitMedoids`.
- Plain sort: `kitNearnessDistance`, `sortFilesByKitNearness`, `kitDistance`.
- Competitive sort: `kitNearnessDistanceCompetitive`, `KitBestFitShare`, `rankKitsByBestFitShare`, `sortFilesByKitNearnessCompetitive`.

**Order of work:**
1. Delete the research scripts (6.1). The four eval files are then fully dead.
2. Delete the eval files, the dHash block and the dHash tests.
3. Retarget the similarity-groups tests at the production stage-1 path.
4. Delete `buildSimilarityGroups`, the sync stage-1 path and `findClipTopNeighbours`.
5. Run `tsc --noEmit` and vitest after each step.

**Unnecessary `export` keywords:** 139 symbols are exported but used only in their own file. Examples are the `KIT_MARGIN_*` constants, the `*_FILTER` constants in tags.ts, the db/index record types and the compress-job types. §4 lists the data-layer ones. Removing the keyword is low risk and makes future dead-code scans accurate. Consider adding `knip` as a dev-only check so the list stops growing.

### 6.4 Research features still reachable from the UI (owner decision)

`ManageSettingsPanel` still reaches two research features:
- **Corpus export:** `kit-nearness-corpus-export.ts` (428 LOC).
- **Tile scan:** `kit-tile-embedding-job.ts` (227), `db/tile-embeddings.ts` (99), `kit-tile-layout.ts` (42), plus a tile branch in `clip-embedding.worker`.

Pass6 concluded "do not ship tiles". Retiring both removes about 800 LOC of source plus the 239-LOC export test, and needs a dbVersion bump that drops the tile-embeddings store. This also removes the tile-embeddings work in §4.3 and the §4 findings.

### 6.5 Dependencies and repo hygiene

**Dependencies:**
- **Remove `@ffmpeg/util`.** It has zero imports; only `@ffmpeg/ffmpeg` is used, in `src/lib/ffmpeg/index.ts`.
- **Remove `vaul`.** It has zero imports and there is no drawer component.
- **Move `shadcn` to devDependencies.** It is the CLI; the globals.css import only needs it installed at build time.
- **Verified as used:** `@fontsource-variable/inter`, `tw-animate-css`, `@tailwindcss/postcss`, `happy-dom`, `tsx`, `@types/react-window`, `dotenv`, `playwright`, `@napi-rs/canvas`.

**Root docs:**
- `deep-backend-audit.md` (424), `ui-and-session-audit.md` (413) and `ux-bugs-investigation.md` (236) are dated September 11–13 and marked shipped (0.3.15x).
- Move them to `docs/archive/` or delete them. Then update new-frontend.md lines 111 and 114 and the cross-links between the docs.
- This plan file belongs in the same place once it has been implemented.

**Other files:**
- `skills-lock.json` is committed and locks the shadcn skill, but `.agents/skills` is an empty, untracked directory. Either delete the lockfile or commit the skill.

**src/dev/test-account.tsx** ⚠️ **security:**
- It contains a plaintext throwaway account email and password and is committed to git.
- It is dynamic-imported only under `NODE_ENV === "development"` and is confirmed absent from `out/`.
- Recommended changes:
  - Read the credentials from `.env.local` (`NEXT_PUBLIC_DEV_TEST_EMAIL` / `NEXT_PUBLIC_DEV_TEST_PASSWORD`, dev only).
  - Rename the file to `.ts`.
  - **Rotate the account password**, because it remains in git history.

**CSS:** the shadcn sidebar and chart theme tokens are unused, since `src/` has no sidebar or chart components. That is about 26 lines across `:root`, `.dark` and `@theme inline`. Remove them.

**Leave as is:** `config/eslint`, and the gitignored build artifacts (`tsconfig.tsbuildinfo`, `.spike-out/`, `scripts/output`).


---

