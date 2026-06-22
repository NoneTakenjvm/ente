# Frontend ESLint

Style and TypeScript rules aligned with repo `AGENTS.md` (4-space indent, K&R braces, dense logic, explicit types).

## Files

| File | Edit when… |
|------|------------|
| `eslint.config.mjs` | Adding plugins, changing ignores, or parser setup |
| `eslint.style.mjs` | Changing layout (indent, line length, spacing, blank lines) |
| `eslint.rules.mjs` | Changing logic, TypeScript, or explicit-type rules |

## Commands

From `mobileapp/`:

```bash
npm run lint       # check
npm run lint:fix   # auto-fix layout rules
```

Scoped:

```bash
npx eslint src/pages --fix --config config/eslint/eslint.config.mjs
```

## Editor (Cursor / VS Code)

Workspace settings in `.vscode/settings.json` point the ESLint extension at this config. Reload the window after cloning if squiggles do not appear. Fix-on-save is enabled for auto-fixable rules.

## Ignored paths

- `.next/**`, `out/**`, `build/**`
- `node_modules/**`
- `next-env.d.ts`
- `scripts/**` (Node tooling; not app TypeScript)

## Agent workflow

Use `/audit-frontend-lint` to run `lint:fix`, fix remaining violations, and verify with `npm run build` when needed.

Subjective conventions (member order, JSDoc quality) stay in `/audit-changes`.

## Rule layering

1. **Presets** — `eslint.configs.recommended`, `typescript-eslint` recommended, `react-hooks` recommended
2. **eslint.rules.mjs** — overrides and TypeScript rules (wins over presets)
3. **eslint.style.mjs** — formatting (applied last)

## Known tradeoffs

- **`typedef`** — deprecated in typescript-eslint but still required for parameter/local type annotations; no replacement yet.
- **`explicit-function-return-type`** — required on `.ts` / `.mts` (utils, stores, hooks); **off** on `.tsx` (React components). `typedef` still requires param/local types everywhere.
- **`consistent-type-definitions`** — not enforced; use `interface` or `type` as fits.
- **`consistent-type-imports`** — uses separate `import type` lines; core `no-duplicate-imports` is disabled because it conflicts.
- **Line endings** — `linebreak-style` is off so Windows CRLF does not fail lint.
