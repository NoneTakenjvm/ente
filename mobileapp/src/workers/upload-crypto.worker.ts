import { expose } from "comlink";
import { logUnhandledErrorsAndRejectionsInWorker } from "ente-base/log-web";
import * as libsodium from "ente-base/crypto/libsodium";

/**
 * Crypto surface used by batch uploads (mirrors ente-base {@link CryptoWorker}).
 *
 * Mobileapp remaps `ente-base/crypto` to main-thread libsodium for tests; batch
 * uploads spawn these dedicated workers so encrypt/hash run off the UI thread
 * and in parallel across slots (official Photos upload-manager pattern).
 */
export class UploadCryptoWorker {
    toB64 = libsodium.toB64;
    generateBlobOrStreamKey = libsodium.generateBlobOrStreamKey;
    encryptBox = libsodium.encryptBox;
    encryptBlobBytes = libsodium.encryptBlobBytes;
    encryptMetadataJSON = libsodium.encryptMetadataJSON;
    encryptStreamBytes = libsodium.encryptStreamBytes;
    chunkHashInit = libsodium.chunkHashInit;
    chunkHashUpdate = libsodium.chunkHashUpdate;
    chunkHashFinal = libsodium.chunkHashFinal;
}

expose(UploadCryptoWorker);

logUnhandledErrorsAndRejectionsInWorker();
