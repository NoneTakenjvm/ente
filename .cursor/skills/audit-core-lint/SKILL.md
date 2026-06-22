---
name: audit-core-lint
description: >-
  Run ESLint, TypeScript, and Rust fmt/clippy on the custom frontend core and
  Rust crypto crates, auto-fix what you can, manually fix the rest, and report.
  Use when the user runs /audit-core-lint, asks to lint the core/crypto layer,
  or wants automated style checks on custom-frontend/core or rust/.
disable-model-invocation: true
---

# Audit Core Lint

Fix lint violations in the **crypto/auth/API core** — primarily `custom-frontend/core/` and, when touched, `rust/` (especially `ente-wasm` and `ente-core`).

**Apply fixes in source.** Do not stop at a findings-only report unless a violation needs a design decision from the user.

## Workflow (follow in order)

Resolve **scope** first (see below), then:

### 1. Lint (baseline)

Run lint **without** auto-fix and note the error count.

**Custom TypeScript core** — from `custom-frontend/core/`:

```bash
npm run lint
```

If `lint` is not yet scaffolded, run individually:

```bash
npx eslint .
npx tsc --noEmit
```

**Rust** — from `rust/` (when Rust files are in scope):

```bash
cargo fmt --check
cargo clippy -- -D warnings
```

**Scoped TypeScript** — lint only the path the user named:

```bash
cd custom-frontend/core
npx eslint path/to/file.ts
npx tsc --noEmit
```

### 1b. Confirm when there are many failures

After step 1, if violations are **many** (guide: **>20 errors** on a full run, **>10 affected files**, or **>10 errors** in a scoped run), **stop here**. Summarize the count and, if obvious from output, the worst files or rules. Use **AskQuestion** (or ask in chat and wait) so the user picks **before** step 2:

| Option | Next steps |
|--------|------------|
| **Full scope** | Steps 2–7; fix every violation in scope |
| **Auto-fix only** | Steps 2–3, then report; skip manual fixes |
| **Narrow scope** | User gives path, folder, or staged files; restart from step 1 |
| **Partial / let some slide** | User says what to skip (files, rules, etc.); fix the rest; list deferred items under **Remaining** |

Skip this prompt when the user already stated intent (e.g. "fix all", "auto-fix only", "just `custom-frontend/core/src/crypto/`").

### 2. Auto-fix

**TypeScript** — from `custom-frontend/core/`:

```bash
npm run lint:fix
```

Or:

```bash
npx eslint . --fix
```

**Rust:**

```bash
cargo fmt
```

### 3. Lint again

Re-run the **non-fix** commands from step 1. Note the new count.

### 4. Manual fixes

Edit source files to fix every remaining violation in scope. Typical manual work:

- Add explicit return types and parameter types
- Replace `any` with concrete types
- Break or refactor lines over 120 characters
- Fix `@typescript-eslint/*` strict-type-checked violations
- Resolve Clippy lints Clippy cannot auto-fix

Prefer the smallest change. Match nearby files in the same module. Do not use `eslint-disable` or `#[allow(...)]` unless the user explicitly asked.

### 5. Lint until clean (or blocked)

Re-run step 1. If violations remain in scope, repeat step 4 and lint again until clean or blocked.

### 6. Verify (when needed)

If manual fixes touched compile-relevant code:

**TypeScript** — from `custom-frontend/core/`:

```bash
npm test
```

**Rust** — from `rust/`:

```bash
cargo test
```

Fix any errors your edits introduced, then re-run step 5 if needed.

### 7. Report

Produce the report below **after** steps 1–5 (and step 6 if run). Include baseline vs final counts.

## Scope

| User intent | Commands |
|-------------|----------|
| No path given | Full `custom-frontend/core/` lint + `cargo fmt --check` / `clippy` if Rust changed |
| Package or file | Scoped eslint/tsc; verify with full lint when practical |
| Staged only | Fix only staged paths under `custom-frontend/core/` or `rust/` |

Do not edit generated WASM bindings, `web/packages/` (use `/audit-web-lint`), or `web/apps/photos/`.

When editing imported Ente packages in `web/packages/` directly, run lint from `web/` instead:

```bash
cd web && npm run lint
```

## Fix rules

- Fix violations; do not refactor unrelated code.
- Remove imports your fixes make unused.
- Do not run `git commit` or `git add` unless the user asks.

## Report format

```markdown
# Core Lint Audit

**Scope:** [all | staged | path]
**User choice:** [full scope | auto-fix only | narrow scope | partial — omit if step 1b skipped]
**Baseline:** N issues (step 1) → M after auto-fix (step 3) → K after manual fixes (step 5)

## Summary
[1–3 sentences: what auto-fix handled, what you fixed by hand, whether lint is clean]

## Auto-fixed (step 2)
[Brief note]

## Manually fixed (step 4)

### path/to/file.ts
- **Fixed** (line N): `rule-name` — [what changed]

## Remaining (needs decision or rule change)

### path/to/file.rs
- **Remaining** (line N): `clippy::lint_name` — [why not fixed]

## Clean
- [paths with no issues in scope, if any]
```

If lint passes for the audited scope, say so explicitly in **Summary**.
