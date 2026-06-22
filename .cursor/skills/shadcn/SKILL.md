---
name: shadcn
description: >-
  Interactive workflow to change the mobileapp Photos PWA UI with shadcn/ui.
  Asks which page or component to modify, what kind of change, then implements
  it. Use when the user runs /shadcn, asks to change frontend UI, restyle a
  page, add shadcn components, improve layout, or polish mobileapp design.
disable-model-invocation: true
allowed-tools: Bash(npx shadcn@latest *), Bash(pnpm dlx shadcn@latest *), Bash(bunx --bun shadcn@latest *)
---

# Frontend UI (shadcn)

Guided workflow for changing **`mobileapp/`** UI. Follow steps **in order**. Skip a discovery step only when the user's message already names the area **and** the change clearly.

Read [frontend-map.md](./frontend-map.md) first for pages, components, stores, and project constraints.

## Workflow checklist

Copy and track:

```
- [ ] Step 0 — Project + shadcn context
- [ ] Step 1 — Area (AskQuestion)
- [ ] Step 2 — Change type (AskQuestion)
- [ ] Step 3 — Specifics (if needed)
- [ ] Step 4 — Implement
- [ ] Step 5 — Verify
- [ ] Step 6 — Report
```

---

## Step 0 — Project + shadcn context

All shell commands run from **`mobileapp/`**.

1. Read [frontend-map.md](./frontend-map.md).
2. Check for `mobileapp/components.json`.
3. **If shadcn is initialized:** run `npx shadcn@latest info --json` (or the project's package runner from `packageManager`). Use `aliases`, `resolvedPaths`, `iconLibrary`, `base`, and `isRSC` for imports and `"use client"`.
4. **If shadcn is not initialized:** use **AskQuestion** before UI work:

| Option | Action |
|--------|--------|
| **Initialize shadcn** | Run `npx shadcn@latest init` in `mobileapp/`. Use Next.js + TypeScript defaults. Ask preset only if the user cares (`nova` is a sensible default). Then re-run `info --json`. |
| **CSS-only (no shadcn)** | Keep existing CSS modules / `globals.css`. Skip shadcn CLI steps in Step 4. |
| **Stop** | Explain that component-based shadcn UI needs init first. |

Do not silently init shadcn without the user's choice.

---

## Step 1 — What part of the frontend?

Use **AskQuestion** unless the user already named the target (e.g. "restyle the gallery page").

**Primary options** (single choice):

| Option | Target |
|--------|--------|
| **Gallery** | `src/pages/gallery.tsx` + grid/viewer/filter components |
| **Tags** | `src/pages/tags.tsx` |
| **Favourites** | `src/pages/favourites.tsx` |
| **Dedup** | `src/pages/dedup.tsx` + `components/dedup/*` |
| **Login / auth** | `src/pages/login.tsx`, `components/LoginForm.tsx` |
| **App shell** | `src/pages/_app.tsx`, global nav, layout chrome |
| **Shared component** | → follow-up AskQuestion (see below) |
| **Global theme** | `src/styles/globals.css`, design tokens |
| **New page or feature** | User describes; confirm route and file path |
| **Other** | User specifies path in chat |

**Shared component follow-up** options:

- ThumbnailGrid / ThumbnailCell
- PhotoViewer
- TagFilterBar
- SyncBanner
- CollectionPicker
- DedupGroupCard / ConfirmTrashModal
- Other (user names file)

After selection, read the target file(s) and their CSS modules before Step 4.

---

## Step 2 — What kind of change?

Use **AskQuestion** unless obvious from the user's message.

| Option | Typical work |
|--------|----------------|
| **Restyle** | Replace ad-hoc markup/CSS with shadcn components; preserve behaviour |
| **Add UI element** | Dialog, sheet, drawer, toast, form field, badge, skeleton, etc. |
| **Layout / navigation** | Tabs, sidebar, bottom nav, page structure |
| **Install component** | `npx shadcn@latest add …` from registry (ask registry if ambiguous) |
| **Fix / debug** | Broken composition, a11y, styling bugs |
| **Other** | User describes in chat |

If the user chose **Install component** or the work needs primitives not yet in the project, continue to Step 4 CLI steps.

---

## Step 3 — Specifics

Ask in chat (or one short AskQuestion) when anything is still unclear:

- What should look or behave differently?
- Keep existing behaviour exactly, or change interaction?
- Any reference (screenshot, "like the tags page", registry block name)?

**Do not** change crypto, metadata writes, or store logic unless the user explicitly asked. This skill is UI-focused.

---

## Step 4 — Implement

> **CLI runner:** Use `npx shadcn@latest`, `pnpm dlx shadcn@latest`, or `bunx --bun shadcn@latest` per `packageManager`.

### 4a. Before writing UI

1. Check installed components (`info --json` or list `resolvedPaths.ui`).
2. Run `npx shadcn@latest docs <component>` and fetch returned URLs — do not guess APIs.
3. Search registries when unsure: `npx shadcn@latest search @shadcn -q "…"`.
4. Add only missing components: `npx shadcn@latest add button dialog …`.
5. If adding from a community registry and no registry was specified, **ask** — never default silently.

### 4b. Critical rules (always)

Detailed Incorrect/Correct pairs live in linked rule files — read the relevant file when touching that area.

| Area | Rules file |
|------|------------|
| Tailwind / spacing / colors | [rules/styling.md](./rules/styling.md) |
| Forms | [rules/forms.md](./rules/forms.md) |
| Composition, overlays, empty states | [rules/composition.md](./rules/composition.md) |
| Icons in buttons | [rules/icons.md](./rules/icons.md) |
| Radix vs base (`asChild` vs `render`) | [rules/base-vs-radix.md](./rules/base-vs-radix.md) |

**Non-negotiable shortcuts:**

- Use existing shadcn components before custom styled `div`s.
- `flex` + `gap-*`, not `space-x-*` / `space-y-*`.
- Semantic tokens (`bg-background`, `text-muted-foreground`), not raw palette classes.
- `cn()` for conditional classes.
- Dialog / Sheet / Drawer need a Title (sr-only if hidden).
- Forms: `FieldGroup` + `Field`, not raw stacked divs.
- Toasts: `sonner`. Loading: `Skeleton` / `Spinner`.
- `"use client"` when `isRSC` is true and the file uses hooks or event handlers.

### 4c. Component pick (common needs)

| Need | Use |
|------|-----|
| Actions | `Button` |
| Forms | `Input`, `Select`, `Checkbox`, `Switch`, `Textarea`, `FieldGroup` |
| 2–5 toggles | `ToggleGroup` |
| Data | `Card`, `Badge`, `Table`, `Avatar` |
| Nav | `Tabs`, `Sidebar`, `Breadcrumb` |
| Overlays | `Dialog`, `Sheet`, `Drawer`, `AlertDialog` |
| Feedback | `sonner`, `Alert`, `Skeleton`, `Spinner` |
| Empty | `Empty` |

Full table and CLI reference: [cli.md](./cli.md), [customization.md](./customization.md).

### 4d. Project integration

- Match nearby file structure (Pages Router, colocated `*.module.css` until migrated off CSS modules).
- Import paths from `info --json` aliases — never hardcode `@/components/ui` if the project uses another alias.
- Wire to existing Zustand stores; do not duplicate fetch/decrypt logic in components.
- After adding registry blocks, read generated files — fix imports, icon library, and composition violations.
- Smallest diff that satisfies the request; no unrelated refactors.

### 4e. After adding components

Review every added/changed file for missing groups (`SelectItem` in `SelectGroup`), wrong icon imports, and rule violations. Fix before Step 5.

---

## Step 5 — Verify

From `mobileapp/` when Step 4 touched compile-relevant files:

```bash
npm run lint
npm run build
```

Fix errors your edits introduced. Re-run until clean or blocked on a user decision.

---

## Step 6 — Report

```markdown
# Frontend UI change

**Area:** [page / component / theme]
**Change:** [restyle | add element | layout | install | fix]
**shadcn:** [initialized | CSS-only | components added: …]

## Summary
[1–3 sentences: what changed and why]

## Files changed
- `path/to/file.tsx` — [brief note]

## shadcn CLI (if any)
- [commands run, e.g. add dialog, init]

## Verify
- lint: [pass | N issues]
- build: [pass | skipped | failed — reason]

## Follow-ups
[Optional: deferred items, preset/theme choices, user decisions needed]
```

---

## Additional reference

- [frontend-map.md](./frontend-map.md) — routes, components, stores
- [cli.md](./cli.md) — full CLI, presets, updating components (`--dry-run`, `--diff`)
- [registry.md](./registry.md) — registry authoring
- [rules/](./rules/) — styling, forms, composition, icons

**Updating installed components:** never `--overwrite` without explicit user approval; use `--dry-run` and `--diff` per [cli.md](./cli.md).

**Presets:** ask overwrite / partial / merge / skip before `apply` or `init --preset`.
