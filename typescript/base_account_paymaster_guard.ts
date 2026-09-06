import type { M2MSentinelClient, TransactionPreflightRequest } from './index';

export interface WalletSendCallsCall {
  to: string;
  data: string;
  /** Base Account uses canonical 0x quantities for call value. */
  value?: string;
  capabilities?: Record<string, Record<string, unknown>>;
  flowControl?: Record<string, unknown>;
}

export interface WalletSendCallsParams {
  version: '1.0';
  id?: string;
  from: string;
  /** Deliberately restricted to Base's canonical wallet_sendCalls value. */
  chainId: '0x2105';
  atomicRequired?: boolean;
  calls: WalletSendCallsCall[];
  capabilities?: Record<string, Record<string, unknown>>;
}

export interface WalletSendCallsRequest {
  method: 'wallet_sendCalls';
  params: [WalletSendCallsParams];
}

export interface Eip1193Provider {
  request(request: WalletSendCallsRequest): Promise<unknown>;
}

export type BaseTrustLevel = 'HIGH_TRUST_PRIMARY' | 'QUORUM_PUBLIC';

export interface BaseObservationBlock {
  status: 'PINNED';
  chainId: number | string;
  network: 'eip155:8453';
  blockNumber: number | string;
  blockHash: string;
  blockTag: string;
  trustLevel: BaseTrustLevel;
  [key: string]: unknown;
}

export interface BaseSimulationObservation {
  attempted: true;
  trusted: true;
  outcome: 'NOT_ATTEMPTED' | 'SUCCEEDED' | 'REVERTED' | 'UNAVAILABLE' | 'MALFORMED';
  blockTag: string;
  evidenceOnly: true;
  [key: string]: unknown;
}

export interface BaseRpcObservation {
  pinnedBlockTag: string;
  stateBearingCallCount: number;
  failedReadCount: 0;
  failures: unknown[];
  calls: BaseRpcObservationCall[];
  [key: string]: unknown;
}

export interface BaseRpcObservationCall {
  method?: string;
  params?: unknown[];
  blockTag?: string | null;
  status?: 'OK' | 'UNSUPPORTED_OPTIONAL_METHOD' | 'EXECUTION_ERROR' | string;
  trustLevel?: BaseTrustLevel | 'DEGRADED_LOW_TRUST';
  [key: string]: unknown;
}

export interface BaseCapabilityEvidence {
  sourceAddress: string;
  executionRole: 'RESOLVED_EXECUTING_CODE' | 'SELECTED_DIAMOND_FACET';
  transactionSelector: string | null;
  dissection: BaseDissection;
  notASafetyGuarantee: true;
  reachability: 'NOT_ESTABLISHED';
  [key: string]: unknown;
}

export interface BaseDissectionCapability {
  type: string;
  [key: string]: unknown;
}

export interface BaseDissection {
  isValidContract: true;
  bytecodeSizeBytes: number;
  targetBytecodeHash: string;
  capabilities: BaseDissectionCapability[];
  detectedCapabilities: string[];
  [key: string]: unknown;
}

export interface BaseBytecodeHashes {
  runtimeBytecodeHash: string | null;
  finalTargetBytecodeHash: string;
  facetBytecodeHash: string | null;
  facetBytecodeHashes: unknown[];
  [key: string]: unknown;
}

export interface BaseAccountPreflightObservation {
  status: 'SUCCESS';
  operation: 'TRANSACTION_PREFLIGHT_OBSERVATION';
  request: TransactionPreflightRequest;
  selectorHex: string | null;
  surfaceTarget: string;
  resolvedExecutionTarget: string;
  resolution: Record<string, unknown> & { status: 'COMPLETE'; resolutionComplete: true };
  evidenceGrade: true;
  evidenceStatus: 'VERIFIED';
  effectiveTrust: BaseTrustLevel;
  observationBlock: BaseObservationBlock;
  simulationObservation: BaseSimulationObservation;
  rpcObservation: BaseRpcObservation;
  capabilityEvidence: BaseCapabilityEvidence;
  bytecodeHashes: BaseBytecodeHashes;
  notASafetyGuarantee: true;
  reachability: 'NOT_ESTABLISHED';
  limitations: string[];
  conclusion: null;
  [key: string]: unknown;
}

export interface BaseAccountGuardContext {
  callIndex: number;
  index: number;
  call: WalletSendCallsCall;
  transaction: TransactionPreflightRequest;
  request: WalletSendCallsRequest;
  params: WalletSendCallsParams;
  [key: string]: unknown;
}

export type BaseAccountCallerPolicyResult =
  | true
  | false
  | null
  | undefined
  | { allow: true; reason?: string }
  | { allow: false; reason?: string };

export type BaseAccountCallerPolicy = (
  observation: BaseAccountPreflightObservation,
  context: BaseAccountGuardContext
) => BaseAccountCallerPolicyResult | Promise<BaseAccountCallerPolicyResult>;

export interface GuardWalletSendCallsOptions {
  client: Pick<M2MSentinelClient, 'preflightTransaction'>;
  provider: Eip1193Provider;
  request: WalletSendCallsRequest;
  policy: BaseAccountCallerPolicy;
  context?: Record<string, unknown>;
}

export interface BaseAccountPaymasterGuardOptions {
  client: Pick<M2MSentinelClient, 'preflightTransaction'>;
  policy: BaseAccountCallerPolicy;
}

export interface BaseAccountGuardCallOptions {
  policy?: BaseAccountCallerPolicy;
  context?: Record<string, unknown>;
}

export interface BaseAccountObservationIdentity {
  blockNumber: bigint;
  blockTag: string;
  blockHash: string;
  effectiveTrust: BaseTrustLevel;
  blockTrustLevel: BaseTrustLevel;
  finalTargetBytecodeHash: string;
}

interface WalletSendCallsInputErrorInstance extends TypeError {
  readonly code: 'INVALID_WALLET_SEND_CALLS_INPUT';
  readonly field: string;
}

interface ExecutionIdentityBlockedErrorInstance extends Error {
  readonly code: string;
}

interface BaseAccountPaymasterGuardInstance {
  request(provider: Eip1193Provider, request: WalletSendCallsRequest, options?: BaseAccountGuardCallOptions): Promise<unknown>;
  sendCalls(provider: Eip1193Provider, request: WalletSendCallsRequest, options?: BaseAccountGuardCallOptions): Promise<unknown>;
}

// This source-distributed TypeScript entrypoint targets Node.js/CommonJS
// (Node >=18). It intentionally loads the public runtime adapter through
// Node's require and is not a browser-targeted bundle.
function runtime(): any {
  return require('../base_account_paymaster_guard.js');
}

export const BASE_CHAIN_ID: 8453 = runtime().BASE_CHAIN_ID;
export const BASE_CHAIN_HEX: '0x2105' = runtime().BASE_CHAIN_HEX;
export const BASE_NETWORK: 'eip155:8453' = runtime().BASE_NETWORK;
export const MAX_CALLS: number = runtime().MAX_CALLS;
export const MAX_PREFLIGHT_CONCURRENCY: number = runtime().MAX_PREFLIGHT_CONCURRENCY;
export const MAX_RPC_OBSERVATION_CALLS: number = runtime().MAX_RPC_OBSERVATION_CALLS;
export const MAX_DATA_BYTES: number = runtime().MAX_DATA_BYTES;

export const WalletSendCallsInputError: {
  new (field: string, message: string): WalletSendCallsInputErrorInstance;
} = runtime().WalletSendCallsInputError;
export const ExecutionIdentityBlockedError: {
  new (code: string, message: string): ExecutionIdentityBlockedErrorInstance;
} = runtime().ExecutionIdentityBlockedError;
export const PreflightInputError = WalletSendCallsInputError;
export const PreflightBlockedError = ExecutionIdentityBlockedError;

export function isAffirmativePolicyResult(value: unknown): value is true | { allow: true; reason?: string } {
  return runtime().isAffirmativePolicyResult(value);
}

export function validateWalletSendCallsRequest(request: unknown): WalletSendCallsRequest {
  return runtime().validateWalletSendCallsRequest(request);
}

export const normalizeWalletSendCallsRequest = validateWalletSendCallsRequest;

export function transactionFromCall(params: WalletSendCallsParams, call: WalletSendCallsCall, index = 0): TransactionPreflightRequest {
  return runtime().transactionFromCall(params, call, index);
}

export const toPreflightTransaction = transactionFromCall;

export function assertObservationReady(
  observation: unknown,
  transaction: TransactionPreflightRequest
): BaseAccountObservationIdentity {
  return runtime().assertObservationReady(observation, transaction);
}

export function guardWalletSendCalls(options: GuardWalletSendCallsOptions): Promise<unknown> {
  return runtime().guardWalletSendCalls(options);
}

export const preflightWalletSendCalls = guardWalletSendCalls;
export const sendCallsWithPreflight = guardWalletSendCalls;
export const executeWalletSendCalls = guardWalletSendCalls;

export const BaseAccountPaymasterGuard: {
  new (options: BaseAccountPaymasterGuardOptions): BaseAccountPaymasterGuardInstance;
} = runtime().BaseAccountPaymasterGuard;
export const BaseAccountExecutionGuard = BaseAccountPaymasterGuard;

export function createBaseAccountPaymasterGuard(options: BaseAccountPaymasterGuardOptions): BaseAccountPaymasterGuardInstance {
  return new BaseAccountPaymasterGuard(options);
}

export const createExecutionIdentityGuard = createBaseAccountPaymasterGuard;

export function createPublicClient(options: {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  sdk?: { M2MSentinelClient: typeof M2MSentinelClient };
}): M2MSentinelClient {
  return runtime().createPublicClient(options);
}
