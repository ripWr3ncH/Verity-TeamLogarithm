/**
 * VERITY — ledger key layout and typed state access.
 *
 * Composite keys, so a partial-key range query can walk one exposure's event
 * trail without a rich query. That is why the peer runs LevelDB rather than
 * CouchDB: rich queries live in the off-chain read model (services/listener),
 * rebuilt from block 0 on demand.
 */

import { Context } from 'fabric-contract-api';

export const KEY = {
  LOAN: 'LOAN',
  EVENT: 'EVENT',
  DIRECTOR: 'DIRECTOR',
  GOVPARAM: 'GOVPARAM',
  PROPOSAL: 'PROPOSAL',
  ACCESSLOG: 'ACCESSLOG',
} as const;

/** Zero-padded so lexicographic order matches numeric order in range queries. */
const seqKey = (seq: number): string => seq.toString().padStart(6, '0');

export const loanKey = (ctx: Context, commitmentId: string): string =>
  ctx.stub.createCompositeKey(KEY.LOAN, [commitmentId]);

export const eventKey = (ctx: Context, commitmentId: string, seq: number): string =>
  ctx.stub.createCompositeKey(KEY.EVENT, [commitmentId, seqKey(seq)]);

export const directorKey = (ctx: Context, mspId: string, keyId: string): string =>
  ctx.stub.createCompositeKey(KEY.DIRECTOR, [mspId, keyId]);

export const paramKey = (ctx: Context, name: string): string =>
  ctx.stub.createCompositeKey(KEY.GOVPARAM, [name]);

export const proposalKey = (ctx: Context, id: string): string =>
  ctx.stub.createCompositeKey(KEY.PROPOSAL, [id]);

export const accessLogKey = (ctx: Context, timestamp: string, txId: string): string =>
  ctx.stub.createCompositeKey(KEY.ACCESSLOG, [timestamp, txId]);

// --------------------------------------------------------------------------

export async function getJson<T>(ctx: Context, key: string): Promise<T | undefined> {
  const bytes = await ctx.stub.getState(key);
  if (!bytes || bytes.length === 0) return undefined;
  return JSON.parse(bytes.toString()) as T;
}

export async function putJson(ctx: Context, key: string, value: unknown): Promise<void> {
  await ctx.stub.putState(key, Buffer.from(JSON.stringify(value)));
}

/** Every object under one partial composite key, in key order. */
export async function listByPartialKey<T>(
  ctx: Context,
  objectType: string,
  attributes: string[],
): Promise<T[]> {
  const out: T[] = [];
  const iterator = await ctx.stub.getStateByPartialCompositeKey(objectType, attributes);
  try {
    for (let res = await iterator.next(); !res.done; res = await iterator.next()) {
      const value = res.value?.value;
      if (value && value.length > 0) out.push(JSON.parse(value.toString()) as T);
    }
  } finally {
    await iterator.close();
  }
  return out;
}

/**
 * Deterministic transaction timestamp. NEVER use Date.now() in chaincode: every
 * endorsing peer would produce a different value and endorsement would fail.
 */
export function txTimestamp(ctx: Context): string {
  const ts = ctx.stub.getTxTimestamp();
  const millis = Number(ts.seconds) * 1000 + Math.floor(ts.nanos / 1_000_000);
  return new Date(millis).toISOString();
}

/**
 * A human-readable position in the chain, used in refusal messages so a judge
 * can see WHEN a check was made ("...at that block height", §3.7.1).
 */
export function blockHint(ctx: Context): string {
  return `tx ${ctx.stub.getTxID().slice(0, 12)}`;
}

// --------------------------------------------------------------------------
//  Caller identity — read from the CERTIFICATE, never from the payload
// --------------------------------------------------------------------------

export interface Caller {
  id: string;
  mspId: string;
  role: string;
  seniority: number;
  institution: string;
}

/**
 * §4.4: "Bank officers carry role attributes (sanctioning officer, reviewing
 * officer, MD/CEO, director) that chaincode reads when validating authority
 * evidence."
 *
 * These come from the X.509 attributes the org's Fabric CA issued. A client
 * cannot set them — that is the whole point.
 */
export function caller(ctx: Context): Caller {
  const cid = ctx.clientIdentity;
  const seniorityRaw = cid.getAttributeValue('seniority');
  return {
    id: cid.getID(),
    mspId: cid.getMSPID(),
    role: cid.getAttributeValue('role') ?? '',
    seniority: seniorityRaw ? Number(seniorityRaw) : 0,
    institution: cid.getAttributeValue('institution') ?? cid.getMSPID(),
  };
}
