/**
 * VERITY — `exposure` channel chaincode (Module II).
 *
 * Members: BankA, BankB, BangladeshBank. The FRC is deliberately NOT on this
 * channel — §4.4 Table 3 gives it no access to exposure ciphertexts.
 */

import { ExposureContract } from './contracts/exposure';

export { ExposureContract };
export const contracts = [ExposureContract];
