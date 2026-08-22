/**
 * VERITY — the supervisory access log.
 *
 * Whitepaper §4.7:
 *   "Access requests are logged append-only, so supervisory queries leave a
 *    permanent trace."
 *
 * And §3.5, answering the sharpest question a judge can ask — if Bangladesh
 * Bank endorses every event, has it not become the custodian after all?
 *
 *   "No — endorsement and ordering are separate powers. It can refuse an event,
 *    but cannot author a bank's record, rewrite a committed one, or decrypt an
 *    aggregate on its own, AND ITS OWN QUERIES ARE LOGGED."
 *
 * This contract is the last clause of that sentence. In the demo, the
 * supervisor's read from Act 2 appears on the loan's own trail in Act 5.
 */

import { Context, Contract, Info, Returns, Transaction } from 'fabric-contract-api';

import { AccessLogEntry } from '../domain/types';
import { accessLogKey, caller, KEY, listByPartialKey, putJson, txTimestamp } from '../ledger';

@Info({ title: 'AccessLogContract', description: 'Append-only record of supervisory reads (§4.7)' })
export class AccessLogContract extends Contract {
  constructor() {
    super('AccessLogContract');
  }

  @Transaction(false)
  @Returns('string')
  async ListAccessLog(ctx: Context): Promise<string> {
    const entries = await listByPartialKey<AccessLogEntry>(ctx, KEY.ACCESSLOG, []);
    return JSON.stringify(entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp)));
  }

  /** Every supervisory read of one exposure — shown beside its event trail. */
  @Transaction(false)
  @Returns('string')
  async AccessLogFor(ctx: Context, resource: string): Promise<string> {
    const entries = await listByPartialKey<AccessLogEntry>(ctx, KEY.ACCESSLOG, []);
    return JSON.stringify(
      entries
        .filter((e) => e.resource === resource)
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp)),
    );
  }
}

/**
 * Write one access entry. Called from LifecycleContract.SuperviseLoan, which is
 * a submit transaction precisely so that this write can happen — an evaluate
 * transaction cannot leave a trace, and a trace nobody can verify is not one.
 */
export async function recordAccess(
  ctx: Context,
  resource: string,
  action: AccessLogEntry['action'],
): Promise<void> {
  const who = caller(ctx);
  const timestamp = txTimestamp(ctx);
  const txId = ctx.stub.getTxID();

  const entry: AccessLogEntry = {
    timestamp,
    actorId: who.id,
    actorMsp: who.mspId,
    resource,
    action,
    txId,
  };

  await putJson(ctx, accessLogKey(ctx, timestamp, txId), entry);
}
