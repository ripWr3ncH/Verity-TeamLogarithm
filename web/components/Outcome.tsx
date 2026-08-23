'use client';

/**
 * VERITY — the two things a submission can produce.
 *
 * These two components carry more of the demo than any other code in the
 * repository, so they are deliberately separate from everything else:
 *
 *   <RefusalPanel/>   a rule fired. It names the rule, its circular, and what
 *                     was supplied against what was required. A stack trace
 *                     here reads as an accident; a clean refusal reads as
 *                     design, and that difference is worth real points.
 *
 *   <ReceiptPanel/>   a transaction landed. Transaction id, block height and
 *                     the ENDORSING ORGANISATIONS — which is how a judge sees
 *                     that the bank's peer alone was not enough, and that
 *                     Bangladesh Bank's endorsement is a precondition of
 *                     commitment rather than a review afterwards (§3.8 step 4).
 */

import type { Receipt, Refusal } from '@/lib/api';

export function RefusalPanel({ refusal }: { refusal: Refusal }): React.ReactNode {
  // The catalogue writes messages as "CODE: explanation". Split so the code can
  // be read from across a room.
  const explanation = refusal.message.startsWith(`${refusal.code}:`)
    ? refusal.message.slice(refusal.code.length + 1).trim()
    : refusal.message;

  return (
    <div className="outcome refused" role="alert">
      <span className="code">⛔ {refusal.code}</span>
      <p className="text">{explanation}</p>
    </div>
  );
}

export function ReceiptPanel({
  receipt,
  result,
}: {
  receipt: Receipt;
  result?: unknown;
}): React.ReactNode {
  const stateHash =
    result && typeof result === 'object' && 'stateHash' in result
      ? String((result as { stateHash: unknown }).stateHash)
      : undefined;

  return (
    <div className="outcome committed">
      <span className="code">✓ COMMITTED TO THE LEDGER</span>
      <dl className="receipt">
        <dt>Transaction</dt>
        <dd>{receipt.txId}</dd>

        <dt>Block</dt>
        <dd>{receipt.blockNumber}</dd>

        <dt>Endorsed by</dt>
        <dd>{receipt.endorsers.join(' + ')}</dd>

        <dt>Channel</dt>
        <dd>
          {receipt.channel} · {receipt.contract}.{receipt.transaction}
        </dd>

        {stateHash && (
          <>
            <dt>New state</dt>
            <dd>{stateHash}</dd>
          </>
        )}

        <dt>Time</dt>
        <dd>{new Date(receipt.timestamp).toISOString().replace('T', ' ').slice(0, 19)} UTC</dd>
      </dl>
    </div>
  );
}
