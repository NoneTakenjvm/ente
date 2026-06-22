---
name: audit-frontend-lint
description: >-
  Run ESLint on the Next.js mobileapp frontend, auto-fix what you can, manually
  fix the rest, and report. Use when the user runs /audit-frontend-lint, asks to
  lint the frontend, or wants automated style checks on TypeScript/React files.
disable-model-invocation: true
---

# Audit Frontend ESLint

Fix ESLint violations in `mobileapp/`. Rules live in [config/eslint/](../../../mobileapp/config/eslint/) (see [README.md](../../../mobileapp/config/eslint/README.md)).

**Apply fixes in source.** Do not stop at a findings-only report unless a violation needs a design decision from the user.

## Workflow (follow in order)

All commands run from `mobileapp/`. Resolve **scope** first (see below), then:

### 1. Lint (baseline)

Run ESLint **without** `--fix` and note the error/warning count.

**Full project:**
```bash
npm run lint
```

**Scoped** (staged files, a path, or a feature folder the user named):
```bash
npx eslint path/or/file.tsx --config config/eslint/eslint.config.mjs
```

### 1b. Confirm when there are many failures

After step 1, if violations are **many** (guide: **>20 errors** on a full run, **>10 affected files**, or **>10 errors** in a scoped run), **stop here**. Summarize the count and, if obvious from output, the worst files or rules. Use **AskQuestion** (or ask in chat and wait) so the user picks **before** step 2:

| Option | Next steps |
|--------|------------|
| **Full scope** | Steps 2–7; fix every violation in scope |
| **Auto-fix only** | Steps 2–3, then report; skip manual fixes |
| **Narrow scope** | User gives path, folder, or staged files; restart from step 1 |
| **Partial / let some slide** | User says what to skip (files, rules, warnings-only, etc.); fix the rest; list deferred items under **Remaining** |

Skip this prompt when the user already stated intent (e.g. "fix all", "auto-fix only", "just `src/pages/`").

### 2. Auto-fix

Run ESLint **with** `--fix` on the same scope.

**Full project:**
```bash
npm run lint:fix
```

**Scoped:**
```bash
npx eslint path/or/file.tsx --fix --config config/eslint/eslint.config.mjs
```

### 3. Lint again

Re-run the same **non-fix** command from step 1. This is the list of issues ESLint could not auto-fix. Note the new count.

### 4. Manual fixes

Edit source files to fix every remaining violation in scope. Typical manual work:

- Add return types (`: void`, `: React.ReactElement | null`, etc.)
- Add types on parameters, locals, and destructuring (`const x: Type = …`)
- Break or refactor lines over 120 characters
- Remove or add blank lines per padding rules
- Replace `any` with a concrete type

Prefer the smallest change. Match nearby files in the same feature. Do not use `eslint-disable` unless the user explicitly asked.

### 5. Lint until clean (or blocked)

Re-run step 1. If violations remain in scope, repeat step 4 and lint again until:

- `npm run lint` (or scoped lint) passes for the audited paths, **or**
- something needs a user decision (report as **Remaining**, do not guess)

### 6. Build (when needed)

If manual fixes touched compile-relevant code, run once:

```bash
npm run build
```

Fix any errors your edits introduced, then re-run step 5 if needed.

### 7. Report

Produce the report below **after** steps 1–5 (and step 6 if run). Include baseline vs final counts.

## Scope

| User intent | Lint/fix commands |
|-------------|-------------------|
| No path given | `npm run lint` / `npm run lint:fix` (full project) |
| Folder or file | `npx eslint <path> …` |
| Staged only | Lint only staged paths under `mobileapp/` |

Do not edit `web/apps/photos/` (official Ente UI) or generated `.next/**` output.

## Fix rules

- Fix violations; do not refactor unrelated code.
- Remove imports/variables your fixes make unused.
- Do not run `git commit` or `git add` unless the user asks.

## Report format

```markdown
# Frontend ESLint Audit

**Scope:** [all | staged | path]
**User choice:** [full scope | auto-fix only | narrow scope | partial — omit if step 1b skipped]
**Baseline:** N issues (step 1) → M after auto-fix (step 3) → K after manual fixes (step 5)

## Summary
[1–3 sentences: what auto-fix handled, what you fixed by hand, whether lint is clean]

## Auto-fixed (step 2)
[Brief note — e.g. indent, spacing, imports; no need to list every line]

## Manually fixed (step 4)

### path/to/file.tsx
- **Fixed** (line N): `rule-name` — [what changed]

## Remaining (needs decision or rule change)

### path/to/file.tsx
- **Remaining** (line N): `rule-name` — [why not fixed]

## Clean
- [paths with no issues in scope, if any]
```

If lint passes for the audited scope, say so explicitly in **Summary**.
