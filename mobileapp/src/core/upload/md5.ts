/**
 * Incremental MD5 for the base64 `Content-MD5` of upload payloads.
 *
 * [Note: Upload MD5]
 *
 * Checksum-bound upload URLs need the MD5 of the encrypted bytes before the
 * PUT, so this runs over every uploaded byte. It reads 32-bit words straight
 * out of the input (no per-byte iteration, no full-size copy) and can be fed
 * chunk by chunk while the file is being encrypted.
 */

export interface Md5 {
    update: (data: Uint8Array) => void;
    digestBase64: () => string;
}

const shifts = new Uint8Array([
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5,
    9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11,
    16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10,
    15, 21,
]);

const constants = ((): Int32Array => {
    const k = new Int32Array(64);
    for (let i = 0; i < 64; i++) {
        k[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) | 0;
    }
    return k;
})();

/** Index of the message word mixed into each of the 64 steps. */
const wordIndexes = ((): Uint8Array => {
    const g = new Uint8Array(64);
    for (let j = 0; j < 64; j++) {
        if (j < 16) {
            g[j] = j;
        } else if (j < 32) {
            g[j] = (5 * j + 1) % 16;
        } else if (j < 48) {
            g[j] = (3 * j + 5) % 16;
        } else {
            g[j] = (7 * j) % 16;
        }
    }
    return g;
})();

/**
 * Start an incremental MD5. Feed bytes with `update`, then call
 * `digestBase64` once.
 */
export const createMd5 = (): Md5 => {
    const state = new Int32Array([
        0x67452301, 0xefcdab89 | 0, 0x98badcfe | 0, 0x10325476,
    ]);
    const words = new Int32Array(16);
    const pending = new Uint8Array(64);
    const pendingView = new DataView(pending.buffer);
    let pendingLength = 0;
    let totalLength = 0;

    const processBlock = (view: DataView, offset: number): void => {
        for (let w = 0; w < 16; w++) {
            words[w] = view.getInt32(offset + w * 4, true);
        }
        let a = state[0]!;
        let b = state[1]!;
        let c = state[2]!;
        let d = state[3]!;
        for (let j = 0; j < 64; j++) {
            let f: number;
            if (j < 16) {
                f = (b & c) | (~b & d);
            } else if (j < 32) {
                f = (d & b) | (~d & c);
            } else if (j < 48) {
                f = b ^ c ^ d;
            } else {
                f = c ^ (b | ~d);
            }
            const sum = (a + f + constants[j]! + words[wordIndexes[j]!]!) | 0;
            const shift = shifts[j]!;
            a = d;
            d = c;
            c = b;
            b = (b + ((sum << shift) | (sum >>> (32 - shift)))) | 0;
        }
        state[0] = (state[0]! + a) | 0;
        state[1] = (state[1]! + b) | 0;
        state[2] = (state[2]! + c) | 0;
        state[3] = (state[3]! + d) | 0;
    };

    const update = (data: Uint8Array): void => {
        totalLength += data.length;
        let offset = 0;
        if (pendingLength > 0) {
            offset = Math.min(64 - pendingLength, data.length);
            pending.set(data.subarray(0, offset), pendingLength);
            pendingLength += offset;
            if (pendingLength < 64) {
                return;
            }
            processBlock(pendingView, 0);
            pendingLength = 0;
        }
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        for (; offset + 64 <= data.length; offset += 64) {
            processBlock(view, offset);
        }
        pending.set(data.subarray(offset));
        pendingLength = data.length - offset;
    };

    const digestBase64 = (): string => {
        const bitLength = totalLength * 8;
        const tail = new Uint8Array(pendingLength < 56 ? 64 : 128);
        tail.set(pending.subarray(0, pendingLength));
        tail[pendingLength] = 0x80;
        const tailView = new DataView(tail.buffer);
        tailView.setUint32(tail.length - 8, bitLength >>> 0, true);
        tailView.setUint32(tail.length - 4, Math.floor(bitLength / 2 ** 32), true);
        for (let offset = 0; offset < tail.length; offset += 64) {
            processBlock(tailView, offset);
        }
        const digest = new DataView(new ArrayBuffer(16));
        for (let i = 0; i < 4; i++) {
            digest.setInt32(i * 4, state[i]!, true);
        }
        return bytesToBase64(new Uint8Array(digest.buffer));
    };

    return { update, digestBase64 };
};

/**
 * Base64 MD5 of {@link data} in one call. See {@link createMd5}.
 */
export const computeMd5Base64 = (data: Uint8Array): string => {
    const md5 = createMd5();
    md5.update(data);
    return md5.digestBase64();
};

const bytesToBase64 = (bytes: Uint8Array): string => {
    let binary = "";
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary);
};
