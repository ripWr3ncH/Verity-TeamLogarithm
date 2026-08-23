/**
 * VERITY — API client.
 *
 * Every call carries X-Verity-Identity naming the acting officer. There is no
 * default and no fallback, deliberately: the API rejects a request without one,
 * and that rejection is a feature. A portal that could act "as the bank" rather
 * than as a named person would quietly undo Act 1, Act 3a and red-team #8.
 */

export const API_BASE =
  process.env['NEXT_PUBLIC_VERITY_API'] ?? process.env['VERITY_API'] ?? 'http://localhost:4000';

export interface Receipt {
  txId: string;
  blockNumber: string;
  endorsers: string[];
  timestamp: string;
  channel: string;
  chaincode: string;
  contract: string;
  transaction: string;
}

export interface Refusal {
  refused: true;
  code: string;
  message: string;
}

export interface Committed<T> {
  refused: false;
  result: T;
  receipt: Receipt;
}

export type Outcome<T> = Committed<T> | Refusal;

export const isRefusal = <T,>(o: Outcome<T>): o is Refusal => o.refused === true;

export interface Identity {
  id: string;
  displayName: string;
  role: string;
  seniority: number;
  mspId: string;
  portal: 'bank' | 'supervisor' | 'depositor' | 'none';
}

export interface Loan {
  commitmentId: string;
  institutionMsp: string;
  currentTier: string;
  prevStateHash: string;
  rsSequence: number;
  outstandingBand: string;
  originationTs: string;
  sanctioningOfficerRole: string;
  sanctioningSeniority: number;
  groupTokenAttestation: string;
  eventCount: number;
  status: string;
}

export interface LifecycleEvent {
  commitmentId: string;
  seq: number;
  type: string;
  timestamp: string;
  classificationRefDate: string;
  daysToNextRefDate: number;
  rsSeq: number;
  tierBefore: string;
  tierAfter: string;
  prevStateHash: string;
  newStateHash: string;
  payloadHash: string;
  authorityEvidence?: { kind?: string; directorSignatures?: unknown[] };
  signatures?: { assigning?: { officerId?: string }; reviewing?: { officerId?: string } };
  txId: string;
  committedByMsp: string;
  note?: string;
}

export interface Parameter {
  name: string;
  value: number;
  effectiveFrom: string;
  proposalId: string;
  changedByTx: string;
}

export interface PayloadRead {
  authorised: boolean;
  callerMsp: string;
  collection: string;
  payloadHash: string;
  payload?: Record<string, unknown>;
  reason?: string;
}

class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function request<T>(
  path: string,
  identity: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'X-Verity-Identity': identity,
      ...(init?.headers ?? {}),
    },
    cache: 'no-store',
  });

  const text = await response.text();
  const body = text.length > 0 ? JSON.parse(text) : undefined;

  if (!response.ok) {
    // A 422 is a chaincode refusal — the system working. Hand it back as data
    // so the UI can render it as a decision rather than an accident.
    if (response.status === 422 && body?.refused) return body as T;
    throw new ApiError(body?.error ?? `HTTP ${response.status}`, response.status);
  }
  return body as T;
}

export const api = {
  health: () => fetch(`${API_BASE}/health`, { cache: 'no-store' }).then((r) => r.json()),

  identities: async (): Promise<Identity[]> => {
    const r = await fetch(`${API_BASE}/identities`, { cache: 'no-store' });
    if (!r.ok) throw new ApiError(`HTTP ${r.status}`, r.status);
    return (await r.json()).users as Identity[];
  },

  getLoan: (identity: string, id: string) => request<Loan>(`/loans/${id}`, identity),

  getTrail: (identity: string, id: string) =>
    request<LifecycleEvent[]>(`/loans/${id}/events`, identity),

  readPayload: (identity: string, id: string, seq: number) =>
    request<PayloadRead>(`/loans/${id}/payload/${seq}`, identity),

  originate: (identity: string, body: Record<string, unknown>) =>
    request<Outcome<{ commitmentId: string; stateHash: string; txId: string }>>('/loans', identity, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  appendEvent: (identity: string, body: Record<string, unknown>) =>
    request<Outcome<Record<string, unknown>>>('/events', identity, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  supervise: (identity: string, id: string) =>
    request<Outcome<{ loan: Loan; events: LifecycleEvent[] }>>(`/supervise/${id}`, identity, {
      method: 'POST',
    }),

  /**
   * The k-of-n signing ceremony. Returns real ed25519 signatures over the
   * event hash from the named directors.
   *
   * In this build the keys sit in a wallet the API reads, so one person can
   * demonstrate a threshold; production holds them in HSMs and each director
   * signs on their own device (§4.3). The VERIFICATION is identical either
   * way — chaincode checks every signature against the registered set.
   */
  boardSign: (identity: string, eventHash: string, signers: string[]) =>
    request<{ directorSignatures: Array<{ keyId: string; signature: string }> }>(
      '/board/sign',
      identity,
      { method: 'POST', body: JSON.stringify({ eventHash, signers }) },
    ),

  parameters: (identity: string) => request<Parameter[]>('/parameters', identity),

  accessLog: (identity: string) =>
    request<Array<{ timestamp: string; actorId: string; actorMsp: string; resource: string; action: string; txId: string }>>(
      '/access-log',
      identity,
    ),

  propose: (identity: string, body: Record<string, unknown>) =>
    request<Outcome<Record<string, unknown>>>('/governance/proposals', identity, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  approve: (identity: string, id: string) =>
    request<Outcome<Record<string, unknown>>>(`/governance/proposals/${id}/approve`, identity, {
      method: 'POST',
    }),

  activate: (identity: string, id: string) =>
    request<Outcome<Record<string, unknown>>>(`/governance/proposals/${id}/activate`, identity, {
      method: 'POST',
    }),
};

/** SHA-256 over a UTF-8 string, hex. Matches the chaincode's payload hashing. */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * ══════════════════════════════════════════════════════════════════════════
 *  A FOURTH COPY OF THE EVENT HASH. Keep it byte-identical to
 *  chaincode/commitment/src/domain/hash.ts.
 *
 *  The chaincode's para 11(c) check requires each officer signature to embed
 *  the first eight hex characters of the event hash, so a signature cannot be
 *  replayed onto a different event. If this browser computes the hash over a
 *  different field set — or in a different key order — every submission is
 *  refused with PARA_11C and the refusal is OUR bug, not the bank's.
 *
 *  Keys are sorted. The field set is exactly the ten below. Do not add a field
 *  here without adding it there in the same commit.
 * ══════════════════════════════════════════════════════════════════════════
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

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

export const eventHash = (e: SignableEvent): Promise<string> =>
  sha256Hex(
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

/** The statutory reference date an event is measured against. */
export function nextReferenceDate(isoDate: string): string {
  const [y, m, d] = isoDate.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return isoDate;
  const t = Date.UTC(y, m - 1, d);
  const candidates: number[] = [];
  for (const yr of [y, y + 1]) {
    for (const [mm, dd] of [[3, 31], [6, 30], [9, 30], [12, 31]] as const) {
      candidates.push(Date.UTC(yr, mm - 1, dd));
    }
  }
  return new Date(candidates.filter((c) => c >= t).sort((a, b) => a - b)[0]!)
    .toISOString()
    .slice(0, 10);
}

/** Statutory classification reference dates, BRPD 15/2024. */
export function daysToNextReferenceDate(isoDate: string): number {
  const [y, m, d] = isoDate.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return 0;
  const t = Date.UTC(y, m - 1, d);
  const candidates: number[] = [];
  for (const yr of [y, y + 1]) {
    for (const [mm, dd] of [[3, 31], [6, 30], [9, 30], [12, 31]] as const) {
      candidates.push(Date.UTC(yr, mm - 1, dd));
    }
  }
  const next = candidates.filter((c) => c >= t).sort((a, b) => a - b)[0]!;
  return Math.round((next - t) / 86_400_000);
}
