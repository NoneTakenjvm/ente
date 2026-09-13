# UX bugs investigation (2026-09-13)

Investigation-only notes for nine reported mobileapp issues. No code changes in this pass.

---

## 1. Stuck on “Redirecting to sign in…” after backgrounding

### Symptoms
After leaving the PWA in the background for a while, foregrounding shows a full-page loader: “Redirecting to sign in…” and it never completes.

### Relevant code
- Auth gate on Media / Albums / Recents / Manage: `isSessionAuthenticated()` → `PageLoader` + `router.replace("/login")` in a **mount-only** `useEffect` (e.g. `gallery.tsx`).
- `SessionProvider`: async `restoreFromPersistence()` on mount; idle timer (`idleLockMs` = **15 min**) calls `lock()` then `router.replace("/login")`.
- `lock()` is **async** (awaits `flushAllDurableState()` before clearing keys / marking locked).
- `isSessionAuthenticated()` reads **in-memory** Ente core keys, not Zustand status.
- Login page *does* await restore before deciding unlock vs redirect to gallery.

### Findings
1. **Idle lock + router race (high confidence)**  
   Idle handler calls `lock()` (fire-and-forget async) and immediately `router.replace("/login")`. While flush runs, core may still report authenticated. Login bootstrap can then `replace("/gallery")`. When lock finishes, core is cleared → gallery re-renders the Redirecting loader. Gallery’s auth `useEffect` only runs on mount; if the page did not remount, **nothing re-attempts navigation to `/login`**. That matches a stuck Redirecting screen.

2. **Backgrounded `router.replace` may not commit**  
   On iOS standalone PWAs, Next client navigation while JS was suspended often fails silently. Lock’s `setState` still clears keys → UI shows Redirecting, but no successful navigation and no retry on `visibilitychange` / `pageshow`.

3. **Cold start / remount race (secondary)**  
   Protected pages call `replace("/login")` as soon as core is empty, without waiting for `SessionProvider`’s restore. Usually login then restores and sends you back; combined with (1)/(2) it worsens the stuck state.

4. **TTL context**  
   Persisted session max age is **60 min**; idle lock is **15 min** (credentials kept, keys wiped, unlock UI expected). Stuck Redirecting is not “session expired” UX — unlock never appears.

### Likely fix direction
- Await lock completion before navigating; on auth loss always `replace("/login")` (effect keyed on auth, or redirect from the Redirecting render path).
- On `visibilitychange` / `pageshow`, re-check core auth and redirect or restore.
- Optionally gate protected pages on “restore attempted” so they don’t flash Redirecting during bootstrap.

---

## 2. Top messages / banners blocked by Dynamic Island

### Symptoms
On iPhone, toasts and top banners sit under the island / status area and cannot be tapped reliably.

### Relevant code
- `pages/_app.tsx`: `<Toaster position="top-center" … />` — **no** `offset` / `mobileOffset`, no `env(safe-area-inset-top)`.
- `components/ui/sonner.tsx`: theme/icons only; no safe-area styling.
- `apple-mobile-web-app-status-bar-style` = `black-translucent` + `viewport-fit=cover` → content draws under the island; safe-area insets are required.
- In-flow `SyncBanner` sits under `AppShell` header (header already has `pt-[env(safe-area-inset-top)]`) — usually fine.
- PhotoViewer top chrome uses `pt-[max(0.5rem,env(safe-area-inset-top))]` correctly.

### Findings
1. **Sonner toasts are the main offender** — fixed overlay at the top of the viewport with default offset (~16px), ignoring safe-area. Close button / Undo actions land in the dead zone under the island.
2. In-document banners below the shell header are unlikely to be island-blocked unless something else is `position: fixed; top: 0` without inset.
3. Sheets with `data-[side=top]` also use `top-0` without safe-area (less common).

### Likely fix direction
- Pass Sonner `offset` / `mobileOffset` to at least `max(16px, env(safe-area-inset-top) + 8px)`, or CSS on `[data-sonner-toaster]` / `.cn-toast`.
- Audit any other `fixed`/`sticky` top overlays the same way.

---

## 3. Bottom nav initially pushed up; settles after interaction

### Symptoms
On first open (mobile), the bottom tab bar sits too high with a gap below. Changing tabs, scrolling the gallery, or dragging the nav down corrects it.

### Relevant code
- `AppShell.tsx` already documents the old bug: **`position: fixed` bottom nav** sat above the true bottom until reflow. Current approach: `flex h-dvh flex-col` with nav as last flex child + `pb-[env(safe-area-inset-bottom)]`.
- No binding to `window.visualViewport` for the shell (unlike `use-visual-viewport-sheet-layout.ts` for the tag sheet).

### Findings
1. Flex + `h-dvh` fixed the classic `fixed; bottom: 0` issue, but **first-paint `dvh` / layout viewport still disagrees** with the visible PWA viewport on iOS (especially `viewport-fit=cover` + translucent status bar).
2. Gap below the nav ⇒ shell height is **shorter than the visual viewport** on first paint; later resize/reflow (route change, scroll, touch) updates `dvh` and the flex column fills correctly.
3. Same class of bug the sheet hook already works around with `visualViewport`.

### Likely fix direction
- Drive shell height from `visualViewport.height` (CSS variable updated on `resize`/`scroll`), or force a layout pass on `pageshow` / first `visualViewport` event.
- Prefer matching the sheet hook’s approach rather than reverting to `position: fixed`.

---

## 4. Tap does not dismiss overlay when photo is zoomed

### Symptoms
Single tap toggles chrome when not zoomed; when zoomed, tap does not hide/show the overlay.

### Relevant code
- Unzoomed taps: carousel pointer up → `handleMediaTap()`.
- Zoomed taps: carousel pointer down **bails** when `zoomScale > 1.01`; zoom layer `handleZoomPointerUp` should call `handleMediaTap()`.
- `handleMediaDoubleTap` sets `skipChromeTapRef.current = true` (suppress chrome toggle on the double-tap that zooms).
- `skipChromeTapRef` is cleared only in `handleCarouselPointerUp`.
- While zoomed, carousel handlers return early and zoom handlers `stopPropagation` when capturing → **carousel up never runs** → flag never clears.

### Findings
1. **Clear bug after double-tap zoom:** `skipChromeTapRef` stays `true` for the rest of the zoomed session → every subsequent tap in `handleZoomPointerUp` returns early → chrome cannot toggle.
2. Pinch-to-zoom without double-tap may still allow chrome toggle (flag false); user report fits the common double-tap-to-zoom path.
3. `handleZoomPointerUp` also does not clear the flag on the early-return path.

### Likely fix direction
- Clear `skipChromeTapRef` inside `handleZoomPointerUp` (always), and/or only skip the immediate pointer-up that completes the double-tap.
- Keep chrome toggle on single tap while zoomed; double-tap should remain zoom-only.

---

## 5. Desktop scroll-wheel zoom (arbitrary zoom)

### Symptoms
Want mouse wheel zoom on desktop; currently inadequate / missing for normal wheel use.

### Relevant code
- `use-pinch-zoom.ts` `onWheel`: only runs when `event.ctrlKey` (trackpad pinch); ±0.1 scale steps; clamp 1–4.
- `PhotoViewer` attaches `onWheel` only when `zoomScale > 1.01` — **cannot start zoom from 1.0 with the wheel**.

### Findings
1. Two blockers: **ctrlKey gate** and **handler only mounted when already zoomed**.
2. Discrete ±0.1 steps are fine once enabled; “arbitrary” mainly means continuous wheel control from fit level, not only ctrl/pinch.

### Likely fix direction
- Attach `onWheel` whenever zoom is enabled (including scale === 1).
- Accept plain wheel (and optionally still handle ctrl/pinch); `preventDefault` to avoid page scroll.
- Optional: zoom toward cursor using clientX/Y (nicer desktop UX).

---

## 6. Video zoom + same overlay / wheel fixes

### Symptoms
Videos lack zoom (and thus the zoomed chrome / wheel behaviour) on mobile and desktop.

### Relevant code
- `zoomEnabled = mediaKind === "image" || mediaKind === "gif"` — **videos excluded**.
- Per-slide `slideZoomEnabled` repeats the same check.
- Video element: `pointer-events-none`; no pinch transform wrapper like images.
- `getObjectContainSize` already supports `HTMLVideoElement`, but `PinchLayout` types only `HTMLImageElement`.
- Video playback chrome / scrubbing will conflict with pan/zoom gestures if enabled naively.

### Findings
1. Zoom is intentionally image/gif-only today — not an accidental omission in one branch.
2. Enabling video zoom needs: include video in `zoomEnabled` / `slideZoomEnabled`, wrap `<video>` in the same transform + pointer handlers, point `pinchLayoutRef` at the video element (widen types), and decide gesture priority vs scrubber / controls (e.g. chrome visible → controls win; chrome hidden or zoomed → pan/zoom).
3. Issues 4–5 fixes should apply to the shared zoom path once videos use it.

### Likely fix direction
- Reuse `usePinchZoom` for video slides; keep `pointer-events-none` on the media element and handle gestures on the wrapper (as images do).
- Gate scrubber hit targets so they don’t steal pan when zoomed.

---

## 7. Stamp tool drags like select (dangerous)

### Symptoms
In stamp mode, drag-marquee selects/stamps many cells like the select tool. Unwanted and unsafe (bulk tag apply while dragging).

### Relevant code
- `buildMediaGridSelection` for stamp sets **`onSelectMany`** → `bulkAddTags(fileIds, tags)`.
- Rotate mode explicitly omits `onSelectMany` (“Tap-only”).
- `ThumbnailGrid`: `marqueeEnabled = Boolean(selection?.onSelectMany) && !disabled`.
- Marquee path for stamp is add-only (no retract) but still applies tags to every newly intersected id while dragging.

### Findings
1. Stamp marquee is **by design in current code**, not a select-mode leak — stamp registers the same marquee hook via `onSelectMany`.
2. That bulk-applies tags with no confirm / undo-per-drag affordance beyond global undo toast — matches “dangerous”.
3. Select should keep marquee; stamp should match rotate: **tap-only**.

### Likely fix direction
- Remove `onSelectMany` from the stamp branch in `buildMediaGridSelection` (leave `onToggle` → single-file `bulkAddTags`).
- Confirm `touchAction` returns to `pan-y` in stamp mode once marquee is off.

---

## 8. Lag when selecting an image in a large gallery

### Symptoms
Noticeable UI jank when tapping to select a thumbnail in a large library view.

### Relevant code
- `toggle` → new `selectedIds` array → `selectedIdSet = new Set(...)` every change.
- `gridSelection = useMemo(buildMediaGridSelection(...))` depends on `selectedIdSet` → **new selection object + new `onToggle` closures every tap**.
- `SizedGrid` `itemData` includes `selection` → new `itemData` every tap.
- `FixedSizeList` / masonry re-renders all mounted rows when `itemData` identity changes.
- `ThumbnailCell` memo compares `onToggleSelect` by reference → **all visible cells fail memo** and re-render.
- Marquee `handlePointerDown` also depends on `selection?.selectedIds`.

### Findings
1. Primary cost: **selection object / callback identity churn** invalidates virtualized row memos across the visible window (and overscan), not decrypt/network.
2. Secondary: rebuilding a `Set` and selection config on every toggle is cheap vs thousands of cell reconciles, but still unnecessary.
3. Masonry path has the same `selection` prop pattern.

### Likely fix direction
- Stable `onToggle` / `onSelectMany` via store actions or refs (don’t put new lambdas in `itemData`).
- Keep `selectedIds` out of `itemData`; cells subscribe to “am I selected?” (e.g. tiny Zustand selector per id, or a ref + version bit).
- Ensure `itemData` changes only when files/layout/mode change, not on each toggle.

---

## 9. Tool footer (select/stamp/rotate) gap above home indicator

### Symptoms
With a tool active, the replacement bottom banner sits above the bottom with a visible gap. Pushing it flush risks home-indicator / rounded-corner occlusion of buttons.

### Relevant code
- Tool active → `AppShell` **hides** the flex tab bar (`hideBottomNav`).
- Footers use **`position: fixed; bottom: env(safe-area-inset-bottom)`**:
  - `SelectionActionFooter.tsx`
  - `StampToolFooter.tsx`
  - `RotateToolFooter.tsx`
- That lifts the **entire** footer (background included) above the safe area → empty gap showing page content.
- Tab bar pattern (correct): `bottom: 0` (flex end) + **`pb-[env(safe-area-inset-bottom)]`** so the background extends edge-to-edge and controls stay in the safe region.
- `SELECTION_FOOTER_INSET_PX = 104` pads the grid for footer height but does not fix fixed positioning.

### Findings
1. Same iOS fixed-bottom class of bug AppShell already avoided for the tab bar; tool footers were not migrated.
2. User guidance is right: don’t only reduce `bottom` to 0 without inner safe padding — buttons would sit under the home indicator.
3. Correct model = tab bar: extend chrome to the physical bottom, pad **content** with `safe-area-inset-bottom`.

### Likely fix direction
- Change footers to `bottom-0` + `pb-[max(0.75rem,env(safe-area-inset-bottom))]` (tune padding to match design).
- Or render tool chrome as an AppShell flex child (swap with tab bar) so height participates in the same `dvh`/`visualViewport` layout as issue 3.
- Re-check `SELECTION_FOOTER_INSET_PX` after footer box size changes.

---

## Cross-cutting map

| # | Area | Severity | Fix size |
|---|------|----------|----------|
| 1 | Session / idle lock / router | High (blocks app) | Medium |
| 2 | Toaster safe-area | Medium | Small |
| 3 | AppShell / visualViewport | Medium | Medium |
| 4 | PhotoViewer `skipChromeTapRef` | Medium | Small |
| 5 | Wheel zoom gates | Low–medium | Small |
| 6 | Video zoom enablement | Medium | Medium |
| 7 | Stamp `onSelectMany` | High (data risk) | Small |
| 8 | Selection `itemData` identity | Medium (perf) | Medium |
| 9 | Fixed tool footers vs safe-area | Medium | Small–medium |

Suggested implementation order if fixing next: **7 → 1 → 4 → 9 → 2 → 5 → 6 → 3 → 8** (safety and blockers first; perf last).
