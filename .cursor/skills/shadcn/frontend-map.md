# mobileapp frontend map

All UI work targets **`mobileapp/`** (Next.js Pages Router, React 19). Do not edit `web/apps/photos/`.

## Pages (`mobileapp/src/pages/`)

| Route | File | Purpose |
|-------|------|---------|
| `/` | `index.tsx` | Redirects to gallery or login |
| `/gallery` | `gallery.tsx` | Main photo grid, viewer, tag filters |
| `/tags` | `tags.tsx` | Tag create / rename / merge / delete |
| `/favourites` | `favourites.tsx` | Favourites collection view |
| `/dedup` | `dedup.tsx` | Exact + similarity duplicate review |
| `/login` | `login.tsx` | SRP sign-in |
| `/dev-login` | `dev-login.tsx` | Dev-only test account (non-production) |
| `/offline` | `offline.tsx` | Offline fallback |
| Shell | `_app.tsx` | Global head, CSS import, page wrapper |

## Shared components (`mobileapp/src/components/`)

| Component | File | Used by |
|-----------|------|---------|
| Thumbnail grid | `ThumbnailGrid.tsx`, `ThumbnailCell.tsx` | Gallery, favourites |
| Photo viewer | `PhotoViewer.tsx` | Gallery, favourites |
| Tag filter bar | `TagFilterBar.tsx` | Gallery |
| Login form | `LoginForm.tsx` | Login |
| Sync banner | `SyncBanner.tsx` | Gallery |
| Collection picker | `CollectionPicker.tsx` | Gallery |
| Dedup group card | `dedup/DedupGroupCard.tsx` | Dedup |
| Confirm trash modal | `dedup/ConfirmTrashModal.tsx` | Dedup |

## Styling today

- Global tokens: `src/styles/globals.css` (`--color-bg`, `--color-accent`, …)
- Feature CSS modules: `*.module.css` next to components/pages
- **No Tailwind / shadcn yet** unless `components.json` exists at `mobileapp/components.json`

## State (read-only for UI — do not refactor unless asked)

| Store | File | UI concerns |
|-------|------|-------------|
| Session | `stores/session-store.ts` | Auth gate, lock |
| Library | `stores/library-store.ts` | File list, sync |
| Tags | `stores/tag-store.ts` | Filter chips, tag index |
| Favourites | `stores/favorites-store.ts` | Heart state |
| UI chrome | `stores/ui-store.ts` | Viewer open, selection |

Wire UI to existing stores; do not move crypto or metadata logic into components.

## Project constraints (from AGENTS.md)

- E2EE: never log keys, passwords, or decrypted content
- Metadata writes merge `pubMagicMetadata.data` — UI-only skill should not change metadata unless the user explicitly asks
- Mobile-first PWA; keep main thread free (crypto stays in workers/core)
- After compile-relevant edits: `npm run lint` and `npm run build` from `mobileapp/`
