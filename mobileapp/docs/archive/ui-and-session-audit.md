# UI, session-cloud & gallery deep dive

**Date:** 2026-09-11  
**Scope:** Cross-device “session” state, gallery interaction bugs, tools chrome, gallery perf, broader UX. Companion to [`deep-backend-audit.md`](./deep-backend-audit.md).  
**Method:** Multi-agent codebase scour + targeted verification of high-impact paths.

---

## 1. Session / app state on cloud (cross-device)

### Short answer

**You cannot replace per-device auth/session with cloud storage** without breaking E2EE. Master key + wrap key must stay on-device. What *can* sync is organizer prefs (already partly does) and expensive derived indexes (CLIP via `mldata`). Recents/view-sessions are the best “session-like” cloud candidates.

### What “session” actually means here

| Meaning | Today | Cloud? |
|---------|-------|--------|
| Auth (`authToken` + `masterKey` wrapped by `ntphotos-wrap-key`) | `localStorage`, 1h TTL, 15m idle lock | **Never** |
| Crypto `cacheKey` (master-derived) | Memory only | **Never** |
| Organizer config (kits, tag types, query albums, `appSettings`) | `.organizer` collection `_organizer_app_v1` | **Already synced** |
| Per-file tags | `pubMagicMetadata._organizer_v1` | **Already synced** |
| Favourites / trash / archive | Ente APIs | **Already synced** (local outboxes = retry only) |
| View sessions / Recents | Encrypted IDB `viewSessions` | **Good cloud candidate** → extend `_organizer_app_v1` |
| Recent tags (RAM) | `tag-speed-store` | **Good small candidate** |
| Active sorts / nearness / shuffle / viewport fit | Zustand session-only | **Stay local** (device/context specific) |
| Mutation outboxes | IDB | **Stay local** (cross-device would duplicate intents) |
| Library / thumbs / ciphertexts / sync cursors | IDB caches | **Stay local** (pull from Ente on new device) |
| CLIP / phash / quality | Local IDB | **CLIP → `mldata`** (see deep-backend audit); others optional |

### Recommended split

**Must stay device-local:** credentials, wrap key, cacheKey, outboxes, full library IDB snapshot, media caches, sync cursors, ephemeral UI modes.

**Already synced:** kits, tag types, app settings, tags, favourites, trash.

**Worth syncing next:**
1. View sessions / Recents → `_organizer_app_v1.viewSessions` (capped list)
2. CLIP embeddings → Ente `mldata` key `organizer_clip`
3. Optional polish: video volume + compress min-size into `appSettings`

**Do not:** ship master keys via collection magic, user-entity, remotestore, or third-party cloud.

---

## 2. Known bug: tap opens wrong / unloaded photo

### Owner report

> Switch to library, click top of screen → registers a click on an image that hasn’t loaded and won’t be in that location when it does.

### Root cause (verified)

Not header click-through. The Media tab **remounts** with scroll at 0. Skeleton cells are **fully clickable** (`ThumbnailCell` button always present). Shortly after mount, **order and/or layout settles**:

1. **`useDeferredValue(files)`** (`gallery.tsx` ~928–932) — grid can show **stale order** for 1+ frames while `files` already updated. Guard only forces live files when deferred is *empty*, not when deferred is *stale*.
2. **Async sorts** — nearness / learned margins / relative worker swap order after paint → masonry `y` positions jump (`ThumbnailGrid` `viewOrderKey`).
3. **Fit-mode masonry** — missing `w`/`h` defaults aspect to `1`, then reflows when real dims appear.
4. **Masonry scroll visibility RAF-lag** — `visibleItems` uses throttled `scrollTop` while hit targets are absolute (amplifies wrong-cell during fling).

Tap hits the **intermediate** cell; the thumbnail that later appears in that slot is a **different** file.

### Minimal fixes (ranked)

| # | Fix | Effort |
|---|-----|--------|
| 1 | Gate `pointer-events: none` until order/layout stable (2 rAF after `viewOrderKey` / width change); also while `deferredFiles !== files` | Low |
| 2 | Prefer live `files` for grid order, or disable clicks during deferred lag | Low |
| 3 | Sync masonry visibility to scroll (drop RAF lag on `scrollTop` for hit-test) | Low |
| 4 | `overflow-anchor: none` on masonry scroller | Trivial |
| 5 | `AppShell` `main`: `overflow-hidden` instead of `overflow-y-auto` (grid owns scroll) | Low |
| 6 | Fit mode: don’t place until dims known (or stable min height) | Medium |

### Related races

- Filter change: deferred grid can show **wrong set** while match count is live (`displayFiles` asymmetry).
- Cache-first paint: grid clickable during `syncRemote` → reorder when pull lands.
- One-frame empty flash before bootstrap effect sets loading status.

---

## 3. Tools chrome UX (Select / Stamp / Rotate)

### Current stack (gallery)

```
Header → SyncBanner → TagFilterBar (+ Tools wrench)
→ ThumbnailGrid
→ Tool footer (fixed, above nav) when mode active
→ Bottom tab nav (~4rem + safe area) ALWAYS visible
```

Modes are mutually exclusive. Query is filter UI, not a grid mode.

| Mode | Footer | Exit on mobile |
|------|--------|----------------|
| Select, 0 picks | **None** — easy to get stuck | Wrench → Select only |
| Select, ≥1 | Actions (no Done) | Action or wrench |
| Stamp | **Always full** kit/tag UI (`max-h-[45dvh]`) | Footer Close or wrench |
| Rotate | Hint + Discard/Apply/Close | Footer or wrench |
| Desktop `md+` | Per-icon toggles | Tap same icon |

`SELECTION_FOOTER_INSET_PX = 168` is **fixed** — under-counts tall stamp kit list, over-counts slim rotate row.

### Owner feedback → proposals

| Feedback | Proposal | Impact / effort |
|----------|----------|-----------------|
| Stamp bar always present, too tall | **Collapsible** stamp footer (label + chevron + Close; expand for kits/tags) | High / Med |
| Disable mode without dropdown | Mobile: **tap wrench again exits** current mode (long-press opens menu), or show active tool × chip | High / Low |
| Tool chrome replace bottom nav | While tool active: **hide tab nav**, pin footer to safe-area bottom, Done/Media escape in bar | High / Med–High |
| Select invisible at 0 picks | Slim “Select · tap photos” + **Done** always when select armed | Med / Low |
| Footer covers last rows | `ResizeObserver` → dynamic `footerInsetPx` | Med / Med |

**Suggested ship order:** (1) collapsible stamp + one-tap exit, (2) select Done bar, (3) hide nav during tools, (4) measured insets.

---

## 4. Gallery performance (what still hurts on phone)

### Already good (0.3.124 / 0.3.125)

Posting-list filter, per-column masonry visibility, deferred grid updates, layout keyed by id order, no LRU stamp on every snapshot, frozen sort caches.

### Remaining high-ROI issues

| Issue | Why it hurts | Fix direction |
|-------|--------------|---------------|
| Gallery page ~25 Zustand subscriptions | Any sync/scan/selection re-renders filter bar + grid + viewer shell | Split thin page + memoized `GalleryGrid` child |
| Selection rebuilds `gridSelection` every tap | New `Set` + object → all visible cells re-render | Stable Set / version counter, or subscribe inside cell |
| Fit masonry mount/unmount on scroll | Subscribe/decrypt churn when cells leave overscan | Column virtual lists or lower overscan on low RAM |
| `viewOrderKey = files.map(id).join(",")` | O(n) string on every `files` ref change | Hash / length+first+last+revision |
| PhotoViewer not memo’d | Sync/scan behind overlay re-runs ~2400-line viewer | `memo(PhotoViewer)` + stable files while open |
| Relative snake on main thread | O(n²) before worker (≥400) | Always off-thread; cap main fallback |
| Shared crypto/IDB with thumbs + viewer + jobs | Scroll jank when viewer preloads / Manage scans | Global concurrency governor (also in backend audit) |
| TagFilterBar re-subscribes to full embedding Map | Re-renders during CLIP scan | Drop Map sub; debounce job only |

---

## 5. Broader UX oversights (sweep)

### High

1. **Select mode:** no Done until first pick; wrench easy to miss.
2. **Rotate drafts:** lost on tab switch / Close with no confirm.
3. **Sync failure banner:** text only — no Retry / Force resync.
4. **Manage Archived / Trash:** tap selects only — cannot preview before restore/delete.

### Medium

5. Empty grid copy wrong when `selection` prop present (“No compressible files…”).
6. Filter bar overloaded on phone — consider one Filters & sort sheet.
7. Viewer header: many 28px targets — collapse to Close / nav / favourite + More.
8. Viewer chrome auto-hides after 2s — undiscoverable on touch.
9. Login bootstrap can flash blank (no spinner).
10. Manage bulk footers not pinned above tab bar (inconsistent with gallery).
11. Advanced sorts (nearness/relative) reorder with no “Sorting…” indicator.
12. “Tag matching…” wrongly enables select mode (`TagFilterBar` → `setEnabled(true)`).

### Low

13. `aria-label` uses opaque file ids; empty `alt`.
14. Album save/delete no success toast (cover update has one).
15. Album reorder mode easy to miss.
16. Top-center toasts fight header/safe area during bottom tool use.
17. Sign out no confirm (panic wipe does).

---

## 6. Recommended priority batches

### Batch A — Ghost click + feel safe (1–2 sessions)

- Interaction gate until layout/order stable + deferred lag
- Prefer live `files` for grid (or click-disable while deferred ≠ live)
- `overflow-hidden` on AppShell main; masonry `overflow-anchor: none`
- Sync masonry scroll visibility

### Batch B — Tools chrome (owner UX)

- Collapsible StampToolFooter
- Mobile: wrench re-tap exits tool / Done on select at 0 picks
- Hide bottom nav while tool active; recompute insets
- Dynamic footer height measurement

### Batch C — Perceived performance

- Memo PhotoViewer; split gallery subscriptions
- Stabilize selection props for grid
- Cheaper `viewOrderKey`
- Global thumb/viewer/job concurrency cap

### Batch D — Cross-device continuity

- Recents → `_organizer_app_v1`
- CLIP → `mldata` `organizer_clip` (see deep-backend audit)

### Batch E — UX polish

- Sync Retry button
- Manage archived/trash preview
- Rotate discard confirm
- Context-aware empty states
- Stop Tag matching from enabling select

---

## 8. Shipped: frontend perf pass (0.3.155)

Implemented from this audit (2026-09-11):

- Live grid order (removed `useDeferredValue` for interactive grid)
- Masonry order hash instead of comma-joined ids; sync scroll visibility; interaction gate (2 rAF); `overflow-anchor: none`
- Gallery/album `mainScrolls={false}` so grid owns scroll
- `memo(PhotoViewer)` ignoring `files` identity; freeze viewer files on open
- Memoized `selectedIdSet` + shared empty Set for stamp/rotate
- TagFilterBar: subscribe to embedding `size`, read Map via `getState()` in worker job
- Fixed grid `overscanCount` 4 → 2

Still open for later: global concurrency governor, split gallery subscriptions, relative snake always off-thread, full-library encrypt.

---

## Shipped in `0.3.156` (2026-09-11)

Owner-decision batch: durable flush + any-outbox beforeunload; logout/lock flush; 401→logout; favourite local patch + persist rollback; trash outbox clear; pull visibility overlay; collection magic +1; hard-pause scans while gallery scrolling; Sync Retry; tools chrome (wrench re-tap, Select Done, stamp collapsed, hide nav, rotate confirm). CLIP sync and incremental library IDB still deferred. Tests: `durable-flush` / `rotate-draft` unit + `e2e-durability-tools.ts`.

## Owner decisions (2026-09-11)

Recorded from owner replies. “Defaults” used where they deferred.

### Backend / durability

| Topic | Decision |
|-------|----------|
| Tab-close warn | **Any** non-empty outbox (not just favourites) |
| HTTP 401/403 | **Force re-login / logout** (not idle lock) — stored session token is dead; unlock would restore the same revoked token |
| Rotate | **In-place + repair**; must preserve tags, favourite, and view-session / recents identity (same file id) |
| Favourite drain after success | **Local patch** favourites set; do **not** kick full `syncRemote` (see explanation below) |
| Library IDB rewrite | **Done `0.3.158`** — `fileShards` fileId%64 dirty writes; monolith migrate |
| IO budget on scroll | **Hard-pause** background scans while flinging; soft deprioritize when idle-scrolling |
| CLIP upload format | **float32 gzip JSON** first |
| CLIP model | **Stay Xenova** + `organizer_clip` key (unless later choosing ONNX migration) |
| CLIP sync timing | **Done `0.3.157`** — `mldata` `organizer_clip` upload/pull; local IDB remains cache |
| Optimistic mutations | Await outbox persist + rollback/toast on failure |
| Lock (idle) | Flush durable state before clearing memory |
| Bulk tag UX | Wording “Queued/Saving…” — don’t block UI |
| Auth retry | Allowlist idempotent/safe calls first |
| CLIP RAM | Pack Float32Array first |
| Video replace concurrency | Cap at **1** on mobile |

### UI

| Topic | Decision |
|-------|----------|
| Tool exit (mobile) | **Re-tap wrench exits** active tool; long-press (or second control) opens menu (**A**) |
| Hide bottom nav in tools | **Yes** (Select / Stamp / Rotate) |
| Select Done | **Exits mode** |
| Stamp footer | **Default collapsed** |
| Slim filter during tools | **Yes** on mobile |
| Fit overscan | Quick lower overscan first; virtualize only if still bad |
| Rotate leave (pending drafts) | **Confirm discard** if pending &gt; 0 (nav hide is separate — yes while rotate active) |
| Sync Retry | Soft retry button; long-press force resync |
| Manage archived/trash | Preview like gallery (tap open, select for bulk) |
| Filters on phone | **Sheet** (“Filters & sort”) |
| Viewer chrome | **Keep auto-hide** (owner preference) |
| Sign out confirm | Yes on mobile |
| Recents cloud | Cap **50**; LWW per session id (when implemented) |
| Sync recent tags | Defer |
| Fit missing dims | Gate placement until dims known |
| Sorting… chip | Yes when order rebuilding |
| Block taps until first sync | No — keep cache-first |

---

## Fix plans (every finding)

Legend: **Effort** S / M / L · **Owner choice** = needs your decision.  
**Done in 0.3.155** noted where applicable.

### Cross-device session

| Item | Plan | Owner choice |
|------|------|--------------|
| Auth / wrap key | Never sync. Keep device-local wrap + SRP per device. | None |
| Recents / view sessions | Add capped `viewSessions` (or summaries) to `_organizer_app_v1`; merge by session id + `updatedAt`; hydrate into `view-sessions-store` on sync. | Cap size: **50 vs 200 sessions**? Recommend 50. Merge: **LWW vs union entries**? Recommend LWW per session id. |
| Recent tags | Optional small string[] on `_organizer_app_v1`. | Sync recent tags **yes/no**? Low value — defer unless you care. |
| Volume / compress min-size | Move into `appSettings` (already cloud). | Sync these **yes/no**? Cosmetic. |
| CLIP | See deep-backend CLIP plan (`mldata`). | See deep-backend owner choices |
| Outboxes / IDB caches | Stay local. | None |

---

### Ghost click / layout races

| Item | Plan | Status / choice |
|------|------|-----------------|
| Deferred stale grid | Pass live `files` to grid | **Done 0.3.155** |
| Interaction gate 2 rAF | `pointer-events` until settle token matches | **Done 0.3.155** |
| Masonry scroll sync + overflow-anchor | Sync `scrollTop`; `overflowAnchor: none` | **Done 0.3.155** |
| `mainScrolls={false}` on gallery/album view | Grid owns scroll | **Done 0.3.155** |
| Fit mode aspect 1 → reflow | Defer place until `w`/`h` known, or use stable min aspect | **Open** — **Owner choice:** gate placement until dims exist (holes in grid briefly) vs accept reflow? Recommend gate for stills missing dims only. |
| Async nearness/relative reorder after paint | Keep interaction gate on `viewOrderKey` change (done); optional “Sorting…” chip | **Owner choice:** show **Sorting…** indicator when frozen order rebuilding? Recommend yes (small). |
| Cache-first clickable during sync | Optional: `pointer-events` none until first `syncRemote` completes, or allow clicks (current) | **Owner choice:** block taps until first sync (**safer**, slower first interactive) vs cache-first (**current**)? Recommend keep cache-first; gate only on order settle. |
| Empty flash before bootstrap | Loader when `syncStatus === idle && !initialLoadDone && files.length === 0` | No choice — small fix |

---

### Tools chrome

| Item | Plan | Owner choice |
|------|------|--------------|
| Collapsible stamp footer | Default collapsed: kit/tag summary + Close + chevron; expand for lists | Default **collapsed vs expanded** on enter? Recommend collapsed. Persist expand in session? Recommend session-only. |
| Exit tool without dropdown | **A)** Re-tap wrench exits active tool (long-press opens menu) **B)** Active chip with × next to wrench **C)** Expose md+ icon row on mobile | Pick **A / B / C** (or A+B). Recommend **A**. |
| Tool chrome replaces bottom nav | When tool active: hide tab nav; footer `bottom: safe-area`; Done returns to Media | **Yes/no** for hiding nav? You suggested yes — confirm. Recommend **yes**. |
| Select Done at 0 picks | Slim bar always when `selectionEnabled` | Done **exits mode** vs **only clears selection**? Recommend exits mode. |
| Dynamic `footerInsetPx` | ResizeObserver on active footer | None |
| Slim filter bar during tools | Collapse TagFilterBar to count + Clear | **Yes/no**? Recommend yes on mobile only. |

---

### Gallery performance (remaining)

| Item | Plan | Owner choice |
|------|------|--------------|
| Fat page subscriptions | Extract memo `GalleryGridPane`; conditional subscribe to quality/nearness only when sort active | None (see deep-backend #4 discussion — smell, conditional hit) |
| Selection cell invalidation | Per-cell `useSelectionStore(s => s.selectedIds.includes(id))` **or** selection version + ref | Prefer per-cell includes (zustand bails on unchanged bool) |
| Fit masonry churn | Lower overscan on mobile; longer LRU grace; later column virtual lists | **Quick lower overscan** now vs **column virtualization** later? Recommend quick now, virtualize if still bad. |
| Relative snake main thread | Worker-first always; keep prior frozen order until result; main only if n&lt;50 | None |
| Global IO budget | Same as deep-backend #18 | See deep-backend scroll pause choice |
| Packed / lazy CLIP RAM | Same as deep-backend #19 | See deep-backend packing vs lazy |
| Full-library encrypt | Same as deep-backend #17 | See shard vs per-file |

*(0.3.155 already: order hash, PhotoViewer memo, embedding size sub, selectedIdSet, overscan 2.)*

---

### UX sweep

| # | Plan | Owner choice |
|---|------|--------------|
| 1 Select Done bar | Covered under tools | Done exits mode? (above) |
| 2 Rotate draft loss | Confirm dialog if `pendingCount > 0` on Close / tab leave; or auto-apply | **Confirm discard** vs **auto-apply on leave** vs **block nav**? Recommend confirm discard. |
| 3 Sync Retry | Button on SyncBanner → `syncRemote` / `forceResyncLibrary` | Expose **force resync** or only soft retry? Recommend soft + long-press force. |
| 4 Manage preview | Tap opens PhotoViewer; long-press/select mode for bulk | Confirm **gallery-like** pattern? Recommend yes. |
| 5 Empty copy | `emptyVariant` prop on ThumbnailGrid | None |
| 6 Filter bar overload | Mobile: single “Filters & sort” sheet | **Sheet vs keep horizontal**? Recommend sheet on `&lt;md`. |
| 7 Viewer header | `&lt;md`: Close, nav, favourite + More overflow | None |
| 8 Chrome auto-hide | Coarse pointer: don’t auto-hide until user taps once, or disable while video playing | **Keep auto-hide** with longer delay vs **tap-to-toggle only**? Recommend tap-to-toggle on touch. |
| 9 Login blank | PageLoader during restore | None |
| 10 Manage footers pinned | Match gallery fixed footer + safe area | None |
| 11 Sorting indicator | Chip on TagFilterBar while order rebuilding | Yes/no — recommend yes |
| 12 Tag matching enables select | Remove `setEnabled(true)` | None |
| 13 a11y labels | Caption/date/kind in aria-label | None |
| 14 Album toasts | success toasts on save/delete | None |
| 15 Reorder hint | Banner when reorder mode on | None |
| 16 Toast position | bottom-center on coarse when tool active | None |
| 17 Sign out confirm | Lightweight confirm | **Yes/no**? Recommend yes on mobile |

---

### Suggested implement order (UI)

1. Tools: wrench re-tap exit + select Done bar + collapsible stamp (**needs choices above**)  
2. Hide bottom nav during tools (if you confirm)  
3. Sync Retry + Tag matching fix + rotate confirm  
4. Manage archived/trash preview  
5. GalleryGridPane split + relative worker-first  
6. Recents → organizer config (if you want cross-device next)  
7. Filters sheet / viewer chrome polish  

---

### Owner decision checklist (copy/paste)

Reply with picks (or “defaults” to accept recommends):

**Backend / durability**
- [ ] Tab-close warn: any outbox vs favourites only → *recommend any*
- [ ] Optimistic UI: await outbox + rollback vs await before paint → *recommend await outbox + rollback*
- [ ] Lock: flush vs discard → *recommend flush*
- [ ] 401: lock vs logout → *recommend lock*
- [ ] Rotate: in-place+repair vs replace-upload → *recommend in-place+repair*
- [ ] Favourite drain: local patch vs full sync → *recommend local patch*
- [ ] Bulk tags: wording vs block until drain → *recommend wording*
- [ ] Auth retry: allowlist vs all → *recommend allowlist*
- [ ] Library IDB: per-file vs shards vs defer → *recommend shards after IO budget*
- [ ] IO budget on scroll: hard pause scans vs soft → *recommend hard on fling*
- [ ] CLIP RAM: pack vs lazy → *recommend pack first*
- [ ] Video replace concurrency: 1 vs 2 → *recommend 1*
- [ ] CLIP sync now vs after perf → *your call*
- [ ] CLIP model: stay Xenova vs Ente ONNX → *your call*
- [ ] CLIP upload: float32 vs quantized → *recommend float32 first*

**UI**
- [ ] Fit missing dims: gate vs reflow → *recommend gate*
- [ ] Sorting… chip → *recommend yes*
- [ ] Block taps until first sync → *recommend no (keep cache-first)*
- [ ] Stamp default collapsed → *recommend yes*
- [ ] Tool exit: A re-tap / B chip / C icon row → *recommend A*
- [ ] Hide bottom nav in tools → *recommend yes*
- [ ] Select Done exits mode → *recommend yes*
- [ ] Slim filter during tools → *recommend yes mobile*
- [ ] Fit overscan quick vs virtualize → *recommend quick*
- [ ] Rotate leave: confirm / auto-apply / block → *recommend confirm*
- [ ] Sync force resync exposed → *recommend long-press*
- [ ] Manage preview like gallery → *recommend yes*
- [ ] Filters sheet on mobile → *recommend yes*
- [ ] Viewer auto-hide → *recommend tap-to-toggle on touch*
- [ ] Sign out confirm → *recommend yes*
- [ ] Recents cloud cap 50 vs 200 → *recommend 50*
- [ ] Sync recent tags → *recommend defer*

