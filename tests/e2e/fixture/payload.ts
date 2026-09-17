import { createHash } from 'node:crypto';

/**
 * Deterministic pseudo-random bytes.
 *
 * Generated rather than committed: a megabyte fixture in git buys nothing that a seed
 * does not, and the tests assert on the digest either way.
 */
export function deterministicPayload(seed: number, size: number): Buffer {
    const buf = Buffer.allocUnsafe(size);
    // xorshift32 — not for anything that matters, only for repeatable bytes.
    let state = seed || 1;

    for (let i = 0; i < size; i++) {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        state >>>= 0;
        buf[i] = state & 0xff;
    }

    return buf;
}

export function sha256(data: Buffer | string): string {
    return createHash('sha256').update(data).digest('hex');
}
