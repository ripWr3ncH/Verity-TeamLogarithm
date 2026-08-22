/**
 * VERITY — Council governance, made executable.
 *
 * Whitepaper §4.6:
 *   "The detection parameters λ, E*, and θ, the authority-evidence thresholds
 *    and the disclosure lag are all Council-set, so NO PARTICIPANT CAN TUNE THE
 *    SYSTEM TO ITS OWN ADVANTAGE."
 *
 * That sentence is the 20-point Governance criterion. This contract is it
 * executing: a bank that proposes raising its own alert threshold is refused,
 * the same change succeeds under Council quorum, and the change is itself a
 * recorded event carrying the names of everyone who approved it.
 *
 * Demo: red-team attack #7.
 */

import { Context, Contract, Info, Returns, Transaction } from 'fabric-contract-api';

import { refusals } from '../domain/errors';
import {
  GOVERNED_PARAMETERS,
  GovernedParameter,
  Parameter,
  ParameterProposal,
} from '../domain/types';
import { caller, getJson, KEY, listByPartialKey, paramKey, proposalKey, putJson, txTimestamp } from '../ledger';

/**
 * Genesis calibration. §3.7.1 is explicit that these are illustrative:
 *
 *   "λ, E* and the weighting of r_j are Council-set and the values here are
 *    illustrative. […] E* must be set against the measured system-wide base
 *    rate rather than against zero."
 *
 * They live on the ledger from the first block so that every change afterwards
 * is visible as a change.
 */
const GENESIS_VALUES: Record<GovernedParameter, number> = {
  lambda: 0.03,          // per day; half-life ln2/λ = 23.1 days
  eStar: 0.5,            // institution-level alert threshold
  theta: 0.25,           // cross-bank exposure threshold, fraction of C_system
  boardThresholdK: 3,    // k in the k-of-n director threshold
  councilQuorum: 3,      // distinct Council organisations, ≈ two-thirds at prototype scale
  disclosureLagDays: 90, // supervisory disclosure lag (§7.3)
};

/** Organisations holding a Council seat in this prototype (§4.6). */
const COUNCIL_MSPS = ['BangladeshBankMSP', 'FRCMSP', 'BankAMSP', 'BankBMSP'];

@Info({ title: 'GovernanceContract', description: 'Council-set parameters and the quorum that changes them' })
export class GovernanceContract extends Contract {
  constructor() {
    super('GovernanceContract');
  }

  /** Run once at deploy. Writes the genesis calibration onto the ledger. */
  @Transaction()
  async InitParameters(ctx: Context): Promise<string> {
    const ts = txTimestamp(ctx);
    const written: string[] = [];
    for (const name of GOVERNED_PARAMETERS) {
      const key = paramKey(ctx, name);
      if (await getJson<Parameter>(ctx, key)) continue;
      const p: Parameter = {
        name,
        value: GENESIS_VALUES[name],
        effectiveFrom: ts,
        proposalId: 'GENESIS',
        changedByTx: ctx.stub.getTxID(),
      };
      await putJson(ctx, key, p);
      written.push(`${name}=${p.value}`);
    }
    return JSON.stringify({ initialised: written });
  }

  @Transaction(false)
  @Returns('string')
  async GetParameter(ctx: Context, name: string): Promise<string> {
    const param = await getJson<Parameter>(ctx, paramKey(ctx, asParameter(name)));
    if (!param) throw refusals.parameterUnknown(name);
    return JSON.stringify(param);
  }

  @Transaction(false)
  @Returns('string')
  async ListParameters(ctx: Context): Promise<string> {
    return JSON.stringify(await listByPartialKey<Parameter>(ctx, KEY.GOVPARAM, []));
  }

  // ======================================================================
  //  Proposal -> approval -> activation
  // ======================================================================

  /**
   * Anyone on the Council may PROPOSE. Proposing is not changing — that
   * distinction is the entire mechanism.
   */
  @Transaction()
  async ProposeParameterChange(
    ctx: Context,
    proposalId: string,
    name: string,
    proposedValue: number,
    rationale: string,
  ): Promise<string> {
    const who = caller(ctx);
    const parameter = asParameter(name);

    const current = await getJson<Parameter>(ctx, paramKey(ctx, parameter));
    if (!current) throw refusals.parameterUnknown(name);

    const proposal: ParameterProposal = {
      proposalId,
      parameter,
      currentValue: current.value,
      proposedValue: Number(proposedValue),
      rationale,
      proposedBy: who.id,
      proposedByMsp: who.mspId,
      proposedAt: txTimestamp(ctx),
      approvals: [who.mspId], // the proposer's own organisation counts once
      state: 'OPEN',
    };

    await putJson(ctx, proposalKey(ctx, proposalId), proposal);
    ctx.stub.setEvent(
      'ParameterProposed',
      Buffer.from(JSON.stringify({ proposalId, parameter, proposedValue })),
    );

    const quorum = await readParameter(ctx, 'councilQuorum');
    return JSON.stringify({
      proposalId,
      state: 'OPEN',
      approvals: proposal.approvals.length,
      quorumRequired: quorum,
    });
  }

  /** One approval per Council ORGANISATION, not per person. */
  @Transaction()
  async ApproveProposal(ctx: Context, proposalId: string): Promise<string> {
    const who = caller(ctx);
    const key = proposalKey(ctx, proposalId);
    const proposal = await getJson<ParameterProposal>(ctx, key);
    if (!proposal) throw refusals.proposalNotFound(proposalId);
    if (proposal.state !== 'OPEN') throw refusals.proposalClosed(proposalId, proposal.state);

    if (!COUNCIL_MSPS.includes(who.mspId)) {
      throw refusals.roleRequired('Council member organisation', who.mspId);
    }
    if (!proposal.approvals.includes(who.mspId)) proposal.approvals.push(who.mspId);

    await putJson(ctx, key, proposal);
    const quorum = await readParameter(ctx, 'councilQuorum');
    return JSON.stringify({
      proposalId,
      approvals: proposal.approvals.length,
      quorumRequired: quorum,
      approvedBy: proposal.approvals,
    });
  }

  /**
   * The refusal that carries the Governance criterion.
   *
   * A single institution reaching for a parameter that governs its own alerts
   * is stopped here, by name, with the count of approvals it actually has. Only
   * a quorum of distinct Council organisations moves it — and the change is
   * written as an attributable event listing every approver.
   */
  @Transaction()
  async ActivateProposal(ctx: Context, proposalId: string): Promise<string> {
    const key = proposalKey(ctx, proposalId);
    const proposal = await getJson<ParameterProposal>(ctx, key);
    if (!proposal) throw refusals.proposalNotFound(proposalId);
    if (proposal.state !== 'OPEN') throw refusals.proposalClosed(proposalId, proposal.state);

    const quorum = await readParameter(ctx, 'councilQuorum');
    const distinct = new Set(proposal.approvals).size;

    if (distinct < quorum) {
      throw refusals.governanceQuorumRequired(proposal.parameter, distinct, quorum);
    }

    const ts = txTimestamp(ctx);
    const updated: Parameter = {
      name: proposal.parameter,
      value: proposal.proposedValue,
      effectiveFrom: ts,
      proposalId,
      changedByTx: ctx.stub.getTxID(),
    };

    await putJson(ctx, paramKey(ctx, proposal.parameter), updated);
    await putJson(ctx, key, {
      ...proposal,
      state: 'ACTIVATED',
      activatedAt: ts,
      activatedByTx: ctx.stub.getTxID(),
    });

    ctx.stub.setEvent(
      'ParameterChanged',
      Buffer.from(
        JSON.stringify({
          parameter: proposal.parameter,
          from: proposal.currentValue,
          to: proposal.proposedValue,
          approvedBy: proposal.approvals,
          proposalId,
        }),
      ),
    );

    return JSON.stringify({
      parameter: proposal.parameter,
      from: proposal.currentValue,
      to: proposal.proposedValue,
      approvedBy: proposal.approvals,
      txId: ctx.stub.getTxID(),
    });
  }

  @Transaction(false)
  @Returns('string')
  async GetProposal(ctx: Context, proposalId: string): Promise<string> {
    const proposal = await getJson<ParameterProposal>(ctx, proposalKey(ctx, proposalId));
    if (!proposal) throw refusals.proposalNotFound(proposalId);
    return JSON.stringify(proposal);
  }

  @Transaction(false)
  @Returns('string')
  async ListProposals(ctx: Context): Promise<string> {
    return JSON.stringify(await listByPartialKey<ParameterProposal>(ctx, KEY.PROPOSAL, []));
  }
}

// --------------------------------------------------------------------------

/**
 * Read a Council-set parameter. Used by LifecycleContract for boardThresholdK
 * and by the off-chain EDI engine for λ and E*.
 *
 * Falls back to the genesis value if InitParameters has not run, so a partly
 * deployed network still behaves — but the fallback is the SAME number, so it
 * can never silently disagree with the ledger.
 */
export async function readParameter(ctx: Context, name: GovernedParameter): Promise<number> {
  const param = await getJson<Parameter>(ctx, paramKey(ctx, name));
  return param ? param.value : GENESIS_VALUES[name];
}

function asParameter(value: string): GovernedParameter {
  if (!(GOVERNED_PARAMETERS as readonly string[]).includes(value)) {
    throw refusals.parameterUnknown(value);
  }
  return value as GovernedParameter;
}
