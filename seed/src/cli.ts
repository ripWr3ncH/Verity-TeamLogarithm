#!/usr/bin/env node
/**
 * VERITY — seed CLI.
 *
 *   npm run generate                       # writes seed/out/seed.json
 *   npm run generate -- --seed=demo        # a different population
 *   npm run generate -- --loans=100        # smaller, for a laptop
 *
 * Deterministic: the same flags always produce the same bytes. That is what
 * makes `scripts/reset-to-seed.sh` a reset rather than a re-roll.
 */

import { mkdirSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';

import { generate } from './generate';

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k!, v ?? 'true'] as const;
  }),
);

const data = generate({
  seed: args.get('seed') ?? 'verity-bcolbd-2026',
  loansPerBank: Number(args.get('loans') ?? 400),
  depositorsPerBank: Number(args.get('depositors') ?? 250),
  groupCount: Number(args.get('groups') ?? 60),
});

const outPath = resolve(args.get('out') ?? 'out/seed.json');
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(data, null, 1));

const rescheduled = data.loans.filter((l) => l.rsSequence > 0).length;
const planted = data.loans.filter((l) => l.narrative).length;

process.stdout.write(
  [
    '',
    `  seed        ${data.generatedWith.seed}`,
    `  loans       ${data.loans.length}  (${rescheduled} with at least one rescheduling, ${planted} labelled fixtures)`,
    `  depositors  ${data.depositors.length}`,
    `  groups      ${data.groups.length}`,
    `  written     ${outPath}`,
    '',
    '  All data is synthetic. No real borrower, depositor or institution appears.',
    '',
  ].join('\n'),
);
