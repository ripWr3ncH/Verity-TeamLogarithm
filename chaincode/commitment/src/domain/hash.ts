/**
 * VERITY — canonical hashing and signature verification.
 *
 * Everything here must be DETERMINISTIC. Chaincode runs on every endorsing peer
 * independently and the results have to agree byte for byte, so: no Date.now(),
 * no Math.random(), no unordered object iteration, no locale-dependent
 * formatting.
 */

import { createHash, createPublicKey, verify as cryptoVerify } from 'crypto';

/**
 * Deterministic JSON: object keys sorted at every level, so two peers building
 * the same logical value always produce the same string.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * The hash every signature is taken over.
 *
 * Deliberately covers only the fields that make the event what it is. Signatures
 * and the transaction id are excluded — a signature cannot cover itself, and the
 * txId is assigned after signing.
 */
export interface SignableEvent {
  commitmentId: string;
  seq: number;
  type: string;
  classificationRefDate: string;
  daysToNextRefDate: number;
  rsSeq: number;
  tierBefore: string;
  tierAfter: string;
  prevStateHash: string;
  payloadHash: string;
}

export function eventHash(e: SignableEvent): string {
  return sha256Hex(
    canonicalJson({
      commitmentId: e.commitmentId,
      seq: e.seq,
      type: e.type,
      classificationRefDate: e.classificationRefDate,
      daysToNextRefDate: e.daysToNextRefDate,
      rsSeq: e.rsSeq,
      tierBefore: e.tierBefore,
      tierAfter: e.tierAfter,
      prevStateHash: e.prevStateHash,
      payloadHash: e.payloadHash,
    }),
  );
}

/**
 * The new state hash, chaining this event onto the previous one. This is what
 * makes the record append-only in a checkable way: an event that claims a
 * prior-state hash the ledger does not hold is refused (STATE_DIVERGENCE).
 */
export function stateHash(prevStateHash: string, evHash: string): string {
  return sha256Hex(`${prevStateHash}:${evHash}`);
}

/** SHA-256 of a public key, used as a short stable identifier for a director. */
export function keyIdOf(publicKeyBase64: string): string {
  return sha256Hex(Buffer.from(publicKeyBase64, 'base64'));
}

/**
 * Verify an ed25519 signature over a hex digest.
 *
 * Returns false rather than throwing on malformed input: a badly-formed
 * signature is an invalid signature, and the caller turns that into a refusal
 * with the right message.
 */
export function verifyEd25519(
  publicKeyBase64: string,
  messageHex: string,
  signatureBase64: string,
): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.from(publicKeyBase64, 'base64'),
      format: 'der',
      type: 'spki',
    });
    return cryptoVerify(
      null,
      Buffer.from(messageHex, 'utf8'),
      key,
      Buffer.from(signatureBase64, 'base64'),
    );
  } catch {
    return false;
  }
}
