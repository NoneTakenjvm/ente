/**
 * Node-compatible re-export of ente-base crypto.
 *
 * ente-base/crypto/index.ts delegates to a Web Worker on the main thread,
 * which fails under tsx/Vitest. Redirect ente-base/crypto imports here.
 */
export * from "ente-base/crypto/libsodium";
