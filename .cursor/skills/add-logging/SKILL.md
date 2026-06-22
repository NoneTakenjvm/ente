---
name: add-logging
description: >-
  Adds development and diagnostic logging to the custom Photos PWA and core,
  with strict privacy rules. Use when the user asks to add logging, improve
  observability, trace sync/auth flows, or debug a feature — always proposes
  logging sites for user approval before writing code.
disable-model-invocation: true
---

# Add Diagnostic Logging

Add **privacy-safe, investigation-grade** log lines that help reconstruct sync, auth, or metadata flows during development — without leaking secrets or flooding the console.

Read [AGENTS.md](../../../AGENTS.md) § Logging and § Security before editing. This skill extends those sections with workflow and site-selection rules.

## Hard rules (never violate)

**Never log:**

- Master keys, collection keys, file keys, KEK, SRP secrets, mnemonics, passwords
- Auth tokens, session cookies, or `X-Auth-Token` values
- Decrypted file bytes, thumbnails, captions, tags, or full metadata JSON
- Email addresses or other PII unless the user explicitly approves for a specific debug session

**Safe to log (opaque identifiers only):**

- File IDs, collection IDs, sync cursor timestamps, HTTP status codes
- Operation outcomes (`sync complete`, `metadata conflict`, `login step: srp-verify`)
- Counts and durations (`pulled 42 files in 380ms`)
- Error types and messages that contain no user content

Prefer a small `createLogger(scope: string)` helper in `custom-frontend/core/` that strips in production builds if one exists; otherwise use `console.debug` / `console.warn` behind a `import.meta.env.DEV` guard.

## Goal

Each log line should answer: **what operation ran, with what outcome, on which opaque ids** — at a moment that matters for debugging sync, auth, or metadata conflicts.

Balance investigation value against volume and privacy. A log on every thumbnail decrypt or scroll event is unusable and unsafe. Prefer fewer, higher-signal lines that chain into a timeline.

## Workflow

**Hard gate:** exploration and proposal happen first; implementation only after the user approves the proposed sites. Never add logging code in the same response as the initial proposal.

### 1. Scope discovery (required first step)

Before reading code or adding logs, ask the user what to cover. Use **AskQuestion** when available; otherwise ask in chat.

Offer concrete options derived from the request, e.g.:

- A package or path (`custom-frontend/core/sync`, `mobileapp/src/components/gallery`)
- Subsystem (`EnteCore.login`, diff sync, tag index rebuild, metadata PUT)
- Specific flows (SRP login, collection pull, pubMagicMetadata update, conflict detection)

Confirm:

- **In scope** — packages, modules, or user journeys to improve
- **Out of scope** — adjacent systems to leave alone
- **Environment** — dev-only (`import.meta.env.DEV`) vs always-on warn/error for failures

Do not guess scope. Do not add logs outside the agreed area.

### 2. Explore the feature

For the scoped area:

1. Find entry points: login, sync pull, decrypt, metadata update, cache read/write.
2. Trace **state-changing** paths: successful login, sync batch applied, metadata merged and PUT, conflict detected.
3. Note existing logging and gaps.
4. Read one **well-instrumented sibling** in Ente's reference code for message style (without copying secret-bearing patterns).

Search aids:

```bash
rg "console\.(debug|info|warn|error)" custom-frontend/
rg "createLogger|logger\." custom-frontend/
```

### 3. Select logging sites

For each candidate location, apply **both** tests:

| Test | Question | If yes → |
|------|----------|----------|
| **Frequency** | Would this fire more than a handful of times per session (per scroll, per thumbnail, per file in a large library)? | **Do not log** at info/debug (warn on unexpected errors only) |
| **Privacy** | Could this line expose keys, tokens, or user content if logged? | **Do not log** — redesign fields or skip |
| **Investigation** | Would this line help reconstruct a sync/auth/metadata flow in order? | **Strong candidate** |

**Log at success or failure boundary**, after validation, where the outcome is final.

**Prefer these site types:**

- Login milestones (SRP complete, 2FA verified, session established) — step names only, no tokens
- Sync batch summary (files added/updated/deleted count, sinceTime cursor)
- Metadata PUT success or version conflict (file id + version numbers, not payload)
- Cache miss/hit summaries at module level, not per-key
- Panic / re-auth / cache-wipe triggers

**Avoid these site types:**

- Per-thumbnail or per-file decrypt in gallery scroll
- Per-keystroke or per-filter tag query
- Logging full API request/response bodies
- Loops over collections or files (log one summary instead)
- Debug traces of normal control flow

When unsure, default to **no log**.

### 4. Propose logging sites (required — no code changes yet)

**Do not add log statements or helpers until the user approves the proposal below.**

Present a complete logging plan and **stop**. Wait for explicit user approval before proceeding to step 5.

**Proposal format** — one row per proposed log site:

```markdown
## Proposed logging sites — [scope]

| # | Location | Event | Level | Fields logged | Example message |
|---|----------|-------|-------|---------------|-----------------|
| 1 | `syncCollectionFiles` | Batch pull complete | debug | collectionId, added, updated, sinceTime | `[sync] collection {id}: +{added} ~{updated} since {t}` |
| 2 | `updatePublicMetadata` | Version conflict | warn | fileId, localVersion, remoteVersion | `[metadata] conflict file {id}: local v{local} vs remote v{remote}` |

**Skipped (hot path / privacy):**
- `decryptThumbnail` — fires on every grid cell
- `login` token response — contains secrets

Approve these sites, or tell me which to add/remove/change.
```

Also list **skipped** candidates with a one-line reason.

**Approval gate:**

- **No approval → no implementation.**
- **Partial approval → implement only approved rows.**
- **Requested changes → update the table and wait again.**

### 5. Implement (after user approval only)

**Guard**

- Wrap dev diagnostics in `if (import.meta.env.DEV) { ... }` unless the user approved production warn/error for failures.
- Use a scoped prefix: `[sync]`, `[auth]`, `[metadata]`, `[cache]`.

**Level**

- `console.debug` — successful milestones and summaries (dev only)
- `console.warn` — conflicts, retries, unexpected-but-handled conditions
- `console.error` — failures needing attention; include `Error` as last arg when present

**Message format**

- Template literals or concatenation with **opaque ids only** — never interpolate decrypted content
- Lead with **scope prefix**, then **action**, then **ids/counts**
- One line per event

**Placement**

- Log **after** the operation succeeds or fails definitively
- One log per logical user/system action — not one per internal helper call
- Do not log the same fact in both a child helper and its caller

**Scope discipline**

- Touch only classes in the agreed scope
- Do not refactor, reformat, or add logs to unrelated features
- Remove imports your changes orphan

### 6. Verify and report

From the relevant package:

```bash
cd custom-frontend/core && npm run lint && npm test
# or
cd mobileapp && npm run lint && npm run build
```

Report:

```markdown
# Logging added — [scope]

**Sites added:** N | **Skipped (hot path / privacy):** M

## Added
- `module.function` — what is logged and why

## Skipped (with reason)
- `module.function` — e.g. per-thumbnail decrypt

## Example timeline
[2–4 sample log lines showing how debugging would read for one flow — no secrets]
```

---

## Good vs bad examples

### Good — infrequent, opaque, investigable

```typescript
if (import.meta.env.DEV) {
    console.debug(
        `[sync] collection ${collectionId}: +${added} ~${updated} since ${sinceTime}`,
    );
}

console.warn(
    `[metadata] conflict file ${fileId}: local v${localVersion} vs remote v${remoteVersion}`,
);

console.error(`[auth] SRP verify failed`, error);
```

### Bad — privacy violation or hot path

```typescript
// NEVER — exposes key material
console.debug("collection key", collectionKey);

// NEVER — exposes token
console.debug("auth token", token);

// NEVER — per thumbnail in grid
console.debug("decrypted thumb", fileId, bytes);

// NEVER — full metadata payload
console.debug("pubMagicMetadata", file.pubMagicMetadata?.data);

// Redundant with parent
console.debug("calling decryptRemoteFile");
```

---

## Rules

- **Ask scope first** — never assume the feature boundary.
- **Explore before writing** — understand call paths and existing logs.
- **Propose before implementing** — present every site, level, fields, and example message; wait for explicit approval.
- **Privacy gate** — if it could leak secrets or content, do not log.
- **Frequency gate** — if it fires constantly, do not log at debug/info.
- **Minimum diff** — only add guards and log lines required by the approved plan.
- **No commit** unless the user asks.
