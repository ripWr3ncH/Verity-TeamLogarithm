/**
 * VERITY — synthetic portfolio generator.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  ALL DATA PRODUCED HERE IS SYNTHETIC. No real borrower, depositor or
 *  institution appears. Institution names are the placeholder set used
 *  throughout the prototype; the whitepaper carries no participation
 *  commitment from any organisation (§5.3, §7.4 #8).
 * ══════════════════════════════════════════════════════════════════════════
 *
 * The generator has one job beyond filling a database: MAKE THE BASE RATE REAL.
 *
 * §3.7.1 concedes the point that decides whether the demo survives questioning:
 *
 *   "Rescheduling also clusters near period-ends for legitimate operational
 *    reasons, so a naive index would flag ordinary administrative rhythm as
 *    evergreening. E* must be set against the measured system-wide base rate
 *    rather than against zero."
 *
 * If this generator produced a population where only the planted evergreening
 * loans ever reschedule near quarter-end, the base-rate histogram in Act 2
 * would be a prop. So the ordinary population DOES cluster somewhat — roughly a
 * quarter of ordinary reschedulings fall within 30 days of a reference date,
 * for the operational reasons practitioners describe — and the planted cases
 * still separate, because they combine tight timing WITH repetition.
 *
 * That is the honest version of the demo, and it is the one that survives
 * "won't this flag everybody?"
 */

import { Rng } from './rng';

export interface SeedEvent {
  type: 'RESCHEDULE' | 'RECLASSIFY_DOWN' | 'RECLASSIFY_UP' | 'RECOVERY' | 'COLLATERAL_REVALUATION';
  eventDate: string;
  rsSeq: number;
  tierBefore: Tier;
  tierAfter: Tier;
}

export interface SeedLoan {
  commitmentId: string;
  institutionMsp: string;
  outstanding: number;
  originationDate: string;
  initialTier: Tier;
  currentTier: Tier;
  outstandingBand: string;
  groupToken: string;
  sanctioningOfficerRole: string;
  sanctioningSeniority: number;
  rsSequence: number;
  events: SeedEvent[];
  /** Set only on the planted whitepaper fixtures, for the demo's own labelling. */
  narrative?: 'TABLE_2_EVERGREENING' | 'TABLE_2_CONTROL' | 'PLANTED_EVERGREENING';
}

export interface SeedDepositor {
  accountRef: string;
  institutionMsp: string;
  balancePoisha: string;
  priorityClass: 'PROTECTED' | 'ORDINARY_DEPOSITOR';
}

export interface SeedGroup {
  groupToken: string;
  /** Per-institution exposure in crore. Module II sums these under encryption. */
  exposureByBank: Record<string, number>;
  /** True for the nominee structure that sits below every single-bank limit. */
  breachesSystemLimit: boolean;
}

export interface SeedData {
  generatedWith: { seed: string; version: number };
  synthetic: true;
  institutions: string[];
  loans: SeedLoan[];
  depositors: SeedDepositor[];
  groups: SeedGroup[];
}

export type Tier = 'STANDARD' | 'SMA' | 'SUB_STANDARD' | 'DOUBTFUL' | 'BAD_LOSS';

const INSTITUTIONS = ['BankAMSP', 'BankBMSP'] as const;

/** Statutory classification reference dates, BRPD 15/2024. */
const REF_DATES = ['03-31', '06-30', '09-30', '12-31'] as const;
const YEARS = [2027, 2028, 2029] as const;

// --------------------------------------------------------------------------
//  The whitepaper fixtures — exact, never randomised
// --------------------------------------------------------------------------

/**
 * §3.7.1 Table 2. Every quarterly return in this sequence reports the exposure
 * as Unclassified; the score climbs 0.698 -> 2.136 -> 4.048 -> 6.055.
 *
 * These dates are load-bearing. They appear in the submitted whitepaper, on the
 * poster, and in the pitch deck. DO NOT ADJUST THEM.
 */
export const TABLE_2_EVERGREENING: SeedLoan = {
  commitmentId: 'BD-4471',
  institutionMsp: 'BankAMSP',
  outstanding: 100_00_00_000,
  originationDate: '2027-01-15',
  initialTier: 'STANDARD',
  currentTier: 'STANDARD',
  outstandingBand: 'Tk 100-150 crore',
  groupToken: 'G-0447',
  sanctioningOfficerRole: 'sanctioning_officer',
  sanctioningSeniority: 2,
  rsSequence: 4,
  narrative: 'TABLE_2_EVERGREENING',
  events: [
    { type: 'RESCHEDULE', eventDate: '2027-06-18', rsSeq: 1, tierBefore: 'STANDARD', tierAfter: 'STANDARD' },
    { type: 'RESCHEDULE', eventDate: '2027-12-20', rsSeq: 2, tierBefore: 'STANDARD', tierAfter: 'STANDARD' },
    { type: 'RESCHEDULE', eventDate: '2028-09-15', rsSeq: 3, tierBefore: 'STANDARD', tierAfter: 'STANDARD' },
    { type: 'RESCHEDULE', eventDate: '2029-03-08', rsSeq: 4, tierBefore: 'STANDARD', tierAfter: 'STANDARD' },
  ],
};

/** The control: ordinary forbearance over the same period. Reaches 0.534. */
export const TABLE_2_CONTROL: SeedLoan = {
  commitmentId: 'BD-5512',
  institutionMsp: 'BankAMSP',
  outstanding: 100_00_00_000,
  originationDate: '2027-01-20',
  initialTier: 'STANDARD',
  currentTier: 'STANDARD',
  outstandingBand: 'Tk 100-150 crore',
  groupToken: 'G-1180',
  sanctioningOfficerRole: 'sanctioning_officer',
  sanctioningSeniority: 2,
  rsSequence: 2,
  narrative: 'TABLE_2_CONTROL',
  events: [
    { type: 'RESCHEDULE', eventDate: '2027-04-22', rsSeq: 1, tierBefore: 'STANDARD', tierAfter: 'STANDARD' },
    { type: 'RESCHEDULE', eventDate: '2027-11-08', rsSeq: 2, tierBefore: 'STANDARD', tierAfter: 'STANDARD' },
  ],
};

// --------------------------------------------------------------------------

export interface GenerateOptions {
  seed?: string;
  loansPerBank?: number;
  depositorsPerBank?: number;
  groupCount?: number;
}

export function generate(options: GenerateOptions = {}): SeedData {
  const seed = options.seed ?? 'verity-bcolbd-2026';
  const loansPerBank = options.loansPerBank ?? 400;
  const depositorsPerBank = options.depositorsPerBank ?? 250;
  const groupCount = options.groupCount ?? 60;

  const rng = new Rng(seed);

  const loans: SeedLoan[] = [TABLE_2_EVERGREENING, TABLE_2_CONTROL];
  const groups = generateGroups(rng, groupCount);
  const groupTokens = groups.map((g) => g.groupToken);

  for (const institutionMsp of INSTITUTIONS) {
    const target = institutionMsp === 'BankAMSP' ? loansPerBank - 2 : loansPerBank;
    for (let i = 0; i < target; i++) {
      loans.push(ordinaryLoan(rng, institutionMsp, i, groupTokens));
    }
    // A handful of additional evergreening cases, so the supervisor's ranked
    // list is a list rather than a single planted row.
    for (let i = 0; i < 3; i++) {
      loans.push(plantedEvergreening(rng, institutionMsp, i));
    }
  }

  const depositors: SeedDepositor[] = [];
  for (const institutionMsp of INSTITUTIONS) {
    for (let i = 0; i < depositorsPerBank; i++) {
      depositors.push(depositor(rng, institutionMsp, i));
    }
  }

  return {
    generatedWith: { seed, version: 1 },
    synthetic: true,
    institutions: [...INSTITUTIONS],
    loans,
    depositors,
    groups,
  };
}

// --------------------------------------------------------------------------
//  Ordinary population — the base rate
// --------------------------------------------------------------------------

function ordinaryLoan(rng: Rng, institutionMsp: string, index: number, groupTokens: string[]): SeedLoan {
  const bankCode = institutionMsp === 'BankAMSP' ? 'A' : 'B';
  const commitmentId = `BD-${bankCode}${String(index + 1000).padStart(5, '0')}`;

  // Most exposures are small; a long tail is large. Log-uniform, in crore.
  const crore = Math.round(Math.exp(rng.float(Math.log(0.5), Math.log(300))) * 100) / 100;
  const outstanding = Math.round(crore * 1_00_00_000);

  const originationDate = isoDate(2027, rng.int(1, 3), rng.int(1, 28));

  /**
   * Rescheduling frequency. Deliberately long-tailed and mostly zero: an index
   * calibrated against a population where everyone reschedules would be
   * meaningless.
   */
  const rsCount = Number(
    rng.weighted({ 0: 0.7, 1: 0.2, 2: 0.07, 3: 0.025, 4: 0.005 }),
  );

  const events: SeedEvent[] = [];
  let tier: Tier = 'STANDARD';

  for (let n = 1; n <= rsCount; n++) {
    const eventDate = rescheduleDate(rng, n);
    events.push({ type: 'RESCHEDULE', eventDate, rsSeq: n, tierBefore: tier, tierAfter: 'STANDARD' });
    tier = 'STANDARD'; // rescheduling removes a loan from classification immediately (§1.1)
  }

  // Some exposures deteriorate on days past due — mechanical, no approval.
  if (rsCount === 0 && rng.chance(0.12)) {
    const worse = rng.pick(['SMA', 'SUB_STANDARD', 'DOUBTFUL', 'BAD_LOSS'] as const);
    events.push({
      type: 'RECLASSIFY_DOWN',
      eventDate: isoDate(rng.pick(YEARS), rng.int(1, 12), rng.int(1, 28)),
      rsSeq: 0,
      tierBefore: 'STANDARD',
      tierAfter: worse,
    });
    tier = worse;
  }

  events.sort((a, b) => a.eventDate.localeCompare(b.eventDate));

  return {
    commitmentId,
    institutionMsp,
    outstanding,
    originationDate,
    initialTier: 'STANDARD',
    currentTier: tier,
    outstandingBand: band(crore),
    groupToken: rng.pick(groupTokens),
    sanctioningOfficerRole: 'sanctioning_officer',
    sanctioningSeniority: 2,
    rsSequence: rsCount,
    events,
  };
}

/**
 * When does an ORDINARY rescheduling happen?
 *
 * A mixture, not a uniform. Roughly a quarter fall within 30 days of a
 * reference date for the operational reasons §3.7.1 concedes — period-end
 * administrative rhythm is real, and pretending otherwise would make the
 * base-rate histogram a prop rather than evidence.
 */
function rescheduleDate(rng: Rng, occurrence: number): string {
  const year = YEARS[Math.min(YEARS.length - 1, Math.floor((occurrence - 1) / 2))]!;
  const refDate = rng.pick(REF_DATES);
  const [refMonth, refDay] = refDate.split('-').map(Number) as [number, number];

  const daysBefore = rng.chance(0.25)
    ? rng.int(3, 30) // legitimate period-end clustering
    : rng.int(31, 89); // demand- and capacity-driven, spread across the quarter

  const ref = Date.UTC(year, refMonth - 1, refDay);
  return new Date(ref - daysBefore * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Additional evergreening cases, so Act 2's ranked list has depth. Tight timing
 * AND repetition — the combination the index is designed to separate.
 */
function plantedEvergreening(rng: Rng, institutionMsp: string, index: number): SeedLoan {
  const bankCode = institutionMsp === 'BankAMSP' ? 'A' : 'B';
  const commitmentId = `BD-${bankCode}E${String(index + 1).padStart(4, '0')}`;
  const crore = rng.float(40, 220);

  const rsCount = rng.int(3, 4);
  const events: SeedEvent[] = [];
  for (let n = 1; n <= rsCount; n++) {
    const year = YEARS[Math.min(YEARS.length - 1, Math.floor((n - 1) / 2))]!;
    const refDate = REF_DATES[(n - 1) % REF_DATES.length]!;
    const [refMonth, refDay] = refDate.split('-').map(Number) as [number, number];
    const ref = Date.UTC(year, refMonth - 1, refDay);
    const eventDate = new Date(ref - rng.int(6, 26) * 86_400_000).toISOString().slice(0, 10);
    events.push({ type: 'RESCHEDULE', eventDate, rsSeq: n, tierBefore: 'STANDARD', tierAfter: 'STANDARD' });
  }
  events.sort((a, b) => a.eventDate.localeCompare(b.eventDate));

  return {
    commitmentId,
    institutionMsp,
    outstanding: Math.round(crore * 1_00_00_000),
    originationDate: isoDate(2027, rng.int(1, 2), rng.int(1, 28)),
    initialTier: 'STANDARD',
    currentTier: 'STANDARD',
    outstandingBand: band(crore),
    groupToken: `G-${String(rng.int(100, 999)).padStart(4, '0')}`,
    sanctioningOfficerRole: 'sanctioning_officer',
    sanctioningSeniority: 2,
    rsSequence: rsCount,
    events,
    narrative: 'PLANTED_EVERGREENING',
  };
}

// --------------------------------------------------------------------------
//  Borrower groups — Module II
// --------------------------------------------------------------------------

/**
 * §1.1: "A group borrowing through nominees across many banks may sit below all
 * of them." G-0447 is exactly that structure: comfortably inside every
 * single-bank limit, over the line once summed.
 */
function generateGroups(rng: Rng, count: number): SeedGroup[] {
  const groups: SeedGroup[] = [
    {
      groupToken: 'G-0447',
      exposureByBank: { BankAMSP: 520, BankBMSP: 430, BankCMSP: 290 },
      breachesSystemLimit: true,
    },
  ];

  for (let i = 1; i < count; i++) {
    const token = `G-${String(rng.int(1000, 9999)).padStart(4, '0')}`;
    const exposureByBank: Record<string, number> = {};
    for (const bank of ['BankAMSP', 'BankBMSP', 'BankCMSP']) {
      if (rng.chance(0.55)) exposureByBank[bank] = Math.round(rng.float(5, 180));
    }
    if (Object.keys(exposureByBank).length < 2) exposureByBank['BankAMSP'] = Math.round(rng.float(5, 180));

    const total = Object.values(exposureByBank).reduce((s, v) => s + v, 0);
    groups.push({ groupToken: token, exposureByBank, breachesSystemLimit: total > 1000 });
  }
  return groups;
}

// --------------------------------------------------------------------------
//  Depositors — Module III
// --------------------------------------------------------------------------

/**
 * §3.7.4: the Deposit Protection Act, 2026 covers Tk 2,00,000 per depositor per
 * institution, "fully covering roughly 93% of bank accounts. What it leaves
 * open is the balances above Tk 2 lakh, where most deposit VALUE sits."
 *
 * The distribution reflects that: most accounts protected, most money not.
 */
function depositor(rng: Rng, institutionMsp: string, index: number): SeedDepositor {
  const bankCode = institutionMsp === 'BankAMSP' ? 'A' : 'B';
  const protectedAccount = rng.chance(0.93);

  const taka = protectedAccount
    ? rng.float(500, 200_000)
    : Math.exp(rng.float(Math.log(200_000), Math.log(15_000_000)));

  return {
    accountRef: `acct-${bankCode}-${String(index).padStart(5, '0')}`,
    institutionMsp,
    balancePoisha: String(Math.round(taka * 100)),
    priorityClass: protectedAccount ? 'PROTECTED' : 'ORDINARY_DEPOSITOR',
  };
}

// --------------------------------------------------------------------------

function isoDate(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** §4.2 keeps exact amounts off-chain; the ledger carries a band. */
function band(crore: number): string {
  if (crore < 1) return 'Under Tk 1 crore';
  if (crore < 10) return 'Tk 1-10 crore';
  if (crore < 50) return 'Tk 10-50 crore';
  if (crore < 100) return 'Tk 50-100 crore';
  if (crore < 150) return 'Tk 100-150 crore';
  return 'Over Tk 150 crore';
}
