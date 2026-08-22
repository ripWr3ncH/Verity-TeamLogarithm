/**
 * VERITY — `commitment` channel chaincode.
 *
 * One package, three contracts. Fabric supports several Contract classes in a
 * single chaincode, so we package one chaincode PER CHANNEL rather than one per
 * contract: ten chaincode containers across the network instead of seventeen,
 * and the boundary is honest, because a chaincode cannot read another channel's
 * state anyway. See HANDOFF/PHASE_00_FOUNDATION.md §2.3.
 *
 * Invoke with the contract name qualified:
 *   peer chaincode invoke ... -c '{"Args":["LifecycleContract:AppendEvent", ...]}'
 */

import { AccessLogContract } from './contracts/accesslog';
import { GovernanceContract } from './contracts/governance';
import { LifecycleContract } from './contracts/lifecycle';

export { AccessLogContract, GovernanceContract, LifecycleContract };

export const contracts = [LifecycleContract, GovernanceContract, AccessLogContract];
