---
name: audit-all-changes
description: >-
  Audit staged and unpushed git changes for AGENTS.md compliance and fix
  violations. Use when the user runs /audit-all-changes, asks to check staged
  files and unpushed commits against project conventions, or wants a full local
  AGENTS.md compliance pass before pushing.
disable-model-invocation: true
---

# Audit and Fix Staged & Unpushed Changes Against AGENTS.md

Review every **staged** file and every file changed in **committed but not yet pushed** commits for compliance with [AGENTS.md](../../../AGENTS.md). **Fix all clear violations** in those files, then report what was changed and what remains.

Same rules, checklist, severity, and fix rules as `/audit-changes`, but the file scope also includes unpushed commits.

**Apply fixes automatically.** Edit files as violations are found — do not present a findings-only report and wait for approval. The user invoked this command to have issues fixed, not just listed. Produce the report after all applicable fixes are written to disk.

## Workflow

1. Read `AGENTS.md` at the repository root.
2. Resolve the upstream tracking branch (quote `'@{upstream}'` — PowerShell parses it as a hashtable literal otherwise):
   ```bash
   git rev-parse --abbrev-ref '@{upstream}'
   ```
   If this fails, say so and stop. Suggest setting upstream (`git push -u origin <branch>`) or using `/audit-changes` for staged-only review.
3. Collect files to audit (union, deduplicated):
   ```bash
   git diff --cached --name-only
   git diff --name-only '@{upstream}...HEAD'
   ```
4. If no files are found, say so and stop.
5. For each file, read the full file and its relevant diffs:
   - Unpushed commits (if the file appears in the unpushed list):
     ```bash
     git diff '@{upstream}...HEAD' -- path/to/file.ts
     ```
   - Staged changes (if the file is staged):
     ```bash
     git diff --cached -- path/to/file.ts
     ```
6. For each changed module, read one nearby file in the same package/feature that solves a similar problem. Judge against **local** convention as well as AGENTS.md.
7. **Fix every clear violation** in scoped files. Prefer fixing lines in the relevant diffs; fix other lines in the same file only when the violation is unambiguous and the fix is mechanical.
8. Re-read changed files and confirm violations are resolved.
9. If your fixes touched compile-relevant files, verify once per AGENTS.md § Build & Verify:
   - `custom-frontend/core/`: `npm run lint` and `npm test` when crypto/metadata changed
   - `mobileapp/`: `npm run lint` and `npm run build`
   - `rust/`: `cargo clippy -- -D warnings` and `cargo test`
   - `web/packages/`: `npm run lint` from `web/`
   
   Skip when only docs/comments changed. Fix any errors your edits introduced before reporting.
10. Produce the report (format below).

## Audit Checklist

Check only what applies to each file. Fix violations; leave suggestions for the report unless the user would obviously want them fixed too.

| Area | What to check |
|------|----------------|
| **Security** | No logging or persisting keys, passwords, mnemonics, tokens, or decrypted content. Metadata writes merge (`{ ...existing, ...updates }`), never replace whole objects. |
| **Scope** | Changes stay in `custom-frontend/` unless explicitly extending imported Ente packages. No forked UI from `web/apps/photos/`. |
| **Naming** | Clear, not terse, not verbose. Matches nearby code in the feature. |
| **Types** | Explicit exported signatures; no `any`. Discriminated unions over string flags. |
| **Boilerplate** | No useless single-use variables or single-call extracted helpers. Braces on all control flow. |
| **Documentation** | JSDoc on exported functions; `[Note: …]` for non-obvious crypto/sync behaviour. Match Ente style in neighbouring files. |
| **Conventions** | Files in the right package (`custom-frontend/core/` vs `mobileapp/`). Logic mirrors Ente reference implementations in `web/packages/`. |
| **Surrounding context** | Uses crypto worker pattern, existing HTTP/session helpers, and official API endpoints — no hand-rolled crypto or metadata encryption. |
| **Performance** | Crypto off main thread; thumbnails not full-res in grids; no redundant collection scans. |
| **Scope discipline** | No speculative features, over-abstraction, or unrelated cleanup. |

## Severity

- **Violation** — clearly breaks AGENTS.md or local convention. **Fix it.**
- **Suggestion** — debatable or minor. Report it; do not fix unless trivial and risk-free.
- **Pass** — no issues for that area.

## Fix Rules

- **Fix violations; don't refactor.** Make the smallest change that brings the code into compliance.
- **Stay in scope.** Only edit files in the staged + unpushed set unless the user says otherwise. Within a file, prioritise diff lines; fix other lines in that file only for clear, mechanical violations.
- **Don't fix pre-existing issues** in untouched files or unrelated areas of the codebase.
- **Don't rename symbols** unless your changes already touch that symbol.
- **Don't move classes or restructure packages** — report those as suggestions.
- **Match local convention** when AGENTS.md allows flexibility. Read a neighbour module before rewriting patterns.
- Remove imports, variables, or functions that **your fixes** make unused.
- Do not run `git commit` or `git add` unless the user asks.

## Report Format

```markdown
# AGENTS.md Audit — Staged & Unpushed Changes

**Upstream:** origin/main (or whatever @{upstream} resolved to)
**Staged files:** N | **Unpushed files:** M | **Total audited:** T
**Fixed:** X violations | **Remaining suggestions:** Y

## Summary
[1–3 sentences on what was fixed and overall compliance]

## Fixed

### path/to/file.ts
- **Fixed** (line N): [rule] — [what was wrong → what you changed]

## Suggestions (not fixed)

### path/to/file.ts
- **Suggestion** (line N): [optional improvement and why it was left alone]

## Clean files
- [files with no findings, if any]
```

If all audited code files pass after fixes, say so explicitly.

## Rules

- Audit and fix **staged files and unpushed-commit files** only unless the user specifies otherwise.
- Be specific in the report: name the AGENTS.md section and describe each fix.
- If a violation needs a non-trivial design decision, don't guess — report it as a suggestion instead.
