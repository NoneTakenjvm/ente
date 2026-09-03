# Agent Guidelines

**Simplicity, scalability, and maintainability are non-negotiable.** The bar is code a teammate can read once and change safely — not impressive architecture, not clever indirection, not volume for its own sake. When in doubt, do less and name things plainly.

This repo is the [Ente](https://ente.com) monorepo. The active work here is a **custom mobile-first Photos PWA** — viewing, organizing, and curating an existing Ente library with richer tags and tools than the official app. Uploads stay in Ente's native app. Read [`new-frontend.md`](new-frontend.md) for milestones, repo map, and the agent progress report (update it at the start and end of every session).

**Default scope:** Unless a prompt specifies another path or area, treat all user requests as targeting `mobileapp/` — search, edit, and verify there by default.

**PWA build version:** Every shippable batch of `mobileapp/` changes must bump `APP_VERSION` in `mobileapp/src/lib/app-version.ts` (shown at the bottom of Manage). One bump per batch is enough; do this before finishing so phone QA can confirm which build is live.

**End-to-end encryption is load-bearing.** All decryption happens client-side. Never log, persist, or transmit keys, passwords, mnemonics, decrypted blobs, or raw metadata outside the user's device. When changing crypto or metadata writes, run the crypto test suite and preserve Ente's merge semantics on `pubMagicMetadata`.

---

## 1. Behavior

- **Ask mode — answer precisely.** In read-only mode, respond to the question asked: concisely, directly, and without padding. No tangential context, unrelated subsystems, or speculative detail unless the user asks for it.
- **Think before coding, don't over-plan.** State assumptions explicitly. Ask when something critical is unclear — never guess silently. Pick the simplest valid approach and say why. Don't produce step-by-step plans or loop structures unless the task is genuinely complex and multi-phase.
- **Write the minimum code that solves the problem.** No speculative features, no abstractions for single-use code, no error handling for impossible scenarios. If you wrote 200 lines and it could be 50, rewrite it.
- **No backward compatibility unless explicitly requested.** No migration paths, dual-format loaders, deprecated-key fallbacks, or legacy shims when changing configs, persisted documents, serialized fields, or APIs. Default to the new shape. If a change could break something live, ask first.
- **Never commit automatically.** Suggest a short, plain commit message (no `feat:`/`fix:` prefixes), then let the user commit.
- **Touch only what you must.** Don't "improve" adjacent code, formatting, or comments. Don't refactor working code you weren't asked to change. Remove imports/variables/methods that *your* changes made unused; leave pre-existing dead code alone unless asked.
- **Scope larger than the ask — stop and ask.** If implementing the prompt would clearly require a broader refactor, new modules, or many unrelated files, surface that before proceeding. Let the user decide how the larger edit should go ahead.
- **Deliverables — minimal, maintainable, structurally sane.** Excessive or over-engineered code is a failure mode, not a style choice. Only what the task needs; clear control flow and obvious boundaries; simple designs that can grow without premature abstraction. Document methods per **Documentation** below. One obvious home per concern — no scattering related logic or inventing one-off folders. If the diff feels complicated, simplify before shipping.
- **Do not fork Ente's Photos UI.** Build fresh UI in `mobileapp/`. Import crypto, auth, and API seams from `custom-frontend/core/` and existing `web/packages/` — do not copy `web/apps/photos/` React components or MUI shell.

---

## 2. Build & Verify

Monorepo layout for this project:

| Area | Path | Stack |
|---|---|---|
| Custom core (crypto/auth/API seam) | `custom-frontend/core/` | TypeScript, Vitest |
| Custom Photos UI | `mobileapp/` | Next.js, React, TypeScript |
| Ente packages (read/import, rarely edit) | `web/packages/` | TypeScript workspaces |
| Rust crypto + WASM | `rust/` | Cargo, `ente-wasm` |
| Reference only | `web/apps/photos/`, `cli/`, `server/` | Do not fork UI; use as reference |

### Compile verification (default)

- **Run compile verification once** at the end of the task — not after every edit. Use IDE/linter diagnostics during iteration; full lint/build catches cross-module and type errors the linter misses.
- **Skip compile verification** when the changelist has no compile-relevant files (markdown, docs, comments-only, etc.).

**Custom core** — from `custom-frontend/core/`:

```sh
npm run lint          # eslint + tsc (once scaffolded)
npm test              # crypto test suite — required after crypto/metadata changes
```

**Mobile app UI** — from `mobileapp/`:

```sh
npm run lint
npm run build         # production compile check
```

**Ente web packages** (when you edit `web/packages/` directly) — from `web/`:

```sh
npm run lint
npm run build:wasm    # if Rust/WASM bindings changed
```

**Rust** — from `rust/` (when touching `ente-wasm` or core crates):

```sh
cargo fmt --check
cargo clippy -- -D warnings
cargo test
```

CI uses `RUSTFLAGS="-D warnings"` — treat warnings as errors.

---

## 3. Project Conventions

**Follow existing conventions exactly.** Read nearby modules in the same package or feature and mirror their style, structure, and integration paths. Do not introduce alternate structures or stylistic choices that diverge from Ente's established patterns.

### Where things live

| Concern | Primary location | Notes |
|---|---|---|
| Crypto (libsodium wrappers) | `web/packages/base/crypto/` | Box / Blob / Stream; Argon2id KEK |
| Auth + SRP + 2FA | `web/packages/accounts/services/` | `srp.ts`, `user.ts` |
| File + metadata types | `web/packages/media/` | `EnteFile`, three metadata layers |
| Download + decrypt | `web/packages/gallery/services/download.ts` | Thumbnails, full files |
| Photos API + sync | `web/packages/new/photos/services/` | Diff sync, metadata PUT, favourites |
| Key hierarchy | `architecture/README.md` | masterKey → collectionKey → fileKey |
| Clean auth reference | `cli/pkg/sign_in.go` | SRP without React |

Extract into `custom-frontend/core/` behind a small `EnteCore`-style interface (see `new-frontend.md` M1). The UI in `mobileapp/` talks only to that seam.

### Metadata writes (critical)

Each file has three encrypted metadata blobs. Tags live in **`pubMagicMetadata.data`** (merge unknown keys — never replace the whole object). Updates go through versioned PUT with optimistic locking. Spread existing keys: `{ ...pubMagicMetadata?.data, ...updates }`. Verify behaviour against `web/packages/new/photos/services/file.ts`.

Favourites are a **collection** (`type: "favorites"`), not a per-file flag — see `web/packages/media/collection.ts`.

---

## 4. TypeScript & Module Design

**Model variation with types, not branching.** When behaviour differs by kind, use discriminated unions, separate functions, or small strategy modules — not string discriminators or flag fields that need comments to interpret.

```typescript
// bad — behaviour encoded in branches
if (metadataType === "public") { ... }
else if (metadataType === "private") { ... }

// good — typed handlers per layer
const decryptPublicMagicMetadata = (file: EnteFile) => { ... };
const decryptPrivateMagicMetadata = (file: EnteFile) => { ... };
```

- Prefer plain functions and explicit types over classes unless Ente's surrounding code already uses a class pattern.
- Use `zod` schemas where Ente packages already validate remote payloads.
- Use `ensure()` from `ente-utils/ensure` (or equivalent guards) for invariants that must hold.
- **Abstract only where it earns its keep.** A single implementation with no realistic second variant stays concrete.

---

## 5. Surrounding Context

**Read the subsystem before you write code.** A change sits inside crypto, sync, cache, or UI layers — explore existing implementations first.

- **Follow integration points.** Mirror how Ente packages register HTTP calls (`ente-base/http`), session tokens (`ente-base/token`), and crypto worker delegation (`ente-base/crypto/index.ts`).
- **No loose workarounds.** Don't bypass the crypto worker for CPU-heavy ops on the main thread. Don't hand-roll metadata encryption when `encryptMagicMetadata` / `decryptRemoteFile` already exist.
- **Mirror a nearby example end-to-end:** types → decrypt → local index → UI. `web/packages/new/photos/services/file.ts` and `collection.ts` are the canonical API patterns.
- **Two-writer safety.** The official Ente app may edit the same `pubMagicMetadata` concurrently. Always merge; detect version conflicts and surface them to the user.

---

## 6. Code Style

Mandatory for all new and changed code in `custom-frontend/`. When editing `web/packages/`, match the local file's existing style.

### Naming (critical)

Names are the main readability tool.

- **Plain and specific:** `collectionKey`, `decryptedThumbnail`, `tagIndexByFileId` — not `ck`, `thumb`, `idx`.
- **Not excessively long:** one clear noun or verb phrase is enough.
- **No invented abbreviations** unless already established in Ente code (`b64`, `srp`, `kek` where consistent).
- Prefer readable call sites over "clever" short names.

### File and export order

1. Imports (external, then internal/workspace packages)
2. Types and interfaces
3. Constants
4. Primary exported functions (high-level entry points first)
5. Helpers (private or module-local)
6. Small colocated types at the bottom if not exported

### TypeScript specifics

- **Explicit types** on exported function signatures and non-obvious locals. Avoid `any`; use `unknown` + narrowing when needed.
- **No `var`.** Prefer `const`; use `let` only when reassigned.
- **Always use braces** for `if`/`else`/`for`/`while`/`do`, even single statements.
- **Combine return statements** — return expressions directly instead of single-use temporaries.
- **No useless variables or extractions** — don't assign or extract a helper used exactly once unless it clarifies a complex block.
- **Async:** handle rejections; don't fire-and-forget Promises in UI event paths without intentional global handlers.

### Logging

See **Security** below. In development, use structured `console.debug` / `console.warn` sparingly. Never log credentials, keys, tokens, decrypted bytes, or full metadata payloads. Log operation outcomes and opaque IDs only when debugging sync or auth flows.

### Documentation

Concise, not absent. Match Ente's JSDoc style in neighbouring files.

**Document exported functions** in plain language (one or two sentences); add `@param`/`@returns`/`@throws` only when they add something the signature doesn't. Skip docs on:

- Trivial one-line re-exports
- `@Override`-equivalent implementations that exactly fulfil a declared contract
- Obvious React component props when the prop names are self-explanatory

Use `[Note: …]` blocks for non-obvious crypto, sync, or metadata behaviour (Ente convention — see `web/packages/base/crypto/index.ts`, `web/packages/accounts/services/srp.ts`).

```typescript
/**
 * Decrypt the file's public magic metadata and return the parsed data object.
 *
 * @param file an {@link EnteFile} with key and encrypted pubMagicMetadata
 */
export const getPublicMetadata = (file: EnteFile): FilePublicMagicMetadataData => { ... }
```

Reference Ente types and API names with `{@link TypeName}` or backticks. Cross-link related functions with `@see`.

---

## 7. Security & Privacy

This is a zero-knowledge client. Treat every line as security-sensitive.

- **Keys stay in memory** — minimize retention; wipe sensitive buffers when practical. Never persist master keys or collection keys to localStorage unencrypted.
- **Cache encryption** — local IndexedDB/cache entries must be encrypted at rest (see M3 in `new-frontend.md`).
- **No telemetry of content** — no analytics on filenames, captions, tags, or image bytes.
- **Crypto tests are mandatory** — after changing derivation, box/blob encrypt, metadata merge, or file decrypt: run `custom-frontend/core` tests (KAT, round-trip, tamper detection).
- **Official app coexistence** — metadata writes must merge and respect version fields so the native app doesn't lose data.

---

## 8. Performance

The PWA runs in a browser on mobile hardware.

- Run crypto on **web workers** (`ente-base/crypto` already delegates — follow that pattern in the core seam).
- Don't decrypt full-resolution images for grid thumbnails — use thumbnail blobs.
- Batch sync requests; respect rate limits (429 + retry with backoff).
- Don't iterate collections multiple times when one pass builds the index.
- Prefer `Map` / `Set` for hot lookups; avoid redundant object allocation in scroll/render paths.
- If two approaches are otherwise equal, pick the one that keeps the main thread free.
