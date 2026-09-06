export interface M2MSentinelClientOptions {
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  paymentSignature?: string;
}

export interface CreateSubscriptionIntentOptions extends M2MSentinelClientOptions {
  durationDays?: 31 | 90 | 365;
  renewExistingKey?: boolean;
}

export interface RecoveryChallengeOptions {
  txHash?: string;
}

export interface TransactionPreflightRequest {
  chainId: number | string;
  to: string;
  data: string;
  from?: string;
  value?: number | string;
  blockNumber?: number | string;
}

/** A top-level call in the documented EIP-5792 wallet_sendCalls envelope. */
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

export interface BaseAccountObservationIdentity {
  blockNumber: bigint;
  blockTag: string;
  blockHash: string;
  effectiveTrust: BaseTrustLevel;
  blockTrustLevel: BaseTrustLevel;
  finalTargetBytecodeHash: string;
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

export interface M2MSentinelErrorOptions {
  status?: number;
  body?: unknown;
  retryAfter?: string | null;
  paymentRequired?: unknown;
  paymentResponse?: unknown;
}

export class M2MSentinelError extends Error {
  readonly status?: number;
  readonly body?: unknown;
  readonly retryAfter?: string | null;
  readonly paymentRequired?: unknown;
  readonly paymentResponse?: unknown;
  constructor(message: string, options?: M2MSentinelErrorOptions);
}

export class PaymentRequiredError extends M2MSentinelError {}
export class RateLimitedError extends M2MSentinelError {}
export class DataSourceUnavailableError extends M2MSentinelError {}

export class M2MSentinelClient {
  constructor(options?: M2MSentinelClientOptions);
  constructor(apiKey?: string, baseUrl?: string);
  request(method: string, path: string, body?: unknown, options?: M2MSentinelClientOptions): Promise<any>;
  getStatus(): Promise<any>;
  getPublicStats(days?: number): Promise<any>;
  /** Backward-compatible alias for getPublicStats; customer keys never reveal operator counters. */
  getAggregateStats(days?: number): Promise<any>;
  getOperatorAggregateStats(days: number, operatorToken: string): Promise<any>;
  getPlans(): Promise<any>;
  demoAudit(address: string): Promise<any>;
  createFreeChallenge(userWallet: string): Promise<any>;
  claimFreeTier(intentId: string, signature: string): Promise<any>;
  createSubscriptionIntent(tier: string, userWallet: string, options?: CreateSubscriptionIntentOptions): Promise<any>;
  claimSubscription(intentId: string, signature: string, txHash: string): Promise<any>;
  createRecoveryChallenge(userWallet: string, options?: RecoveryChallengeOptions): Promise<any>;
  claimRecoveredKey(intentId: string, signature: string): Promise<any>;
  auditContract(address: string, options?: M2MSentinelClientOptions): Promise<any>;
  getCapabilityScore(address: string, options?: M2MSentinelClientOptions): Promise<any>;
  /** Legacy alias. The response is a capability coverage index, not a safety score. */
  getSecurityScore(address: string, options?: M2MSentinelClientOptions): Promise<any>;
  preflightTransaction(transaction: TransactionPreflightRequest, options?: M2MSentinelClientOptions): Promise<any>;
  getGasFees(options?: M2MSentinelClientOptions): Promise<any>;
  getDexMetrics(options?: M2MSentinelClientOptions): Promise<any>;
  getTokenPrice(symbol: string, options?: M2MSentinelClientOptions): Promise<any>;
  getWhaleSignals(options?: M2MSentinelClientOptions): Promise<any>;
  getKeySelf(): Promise<any>;
  revokeKey(confirm?: boolean): Promise<any>;
}

export class WalletSendCallsInputError extends TypeError {
  readonly code: 'INVALID_WALLET_SEND_CALLS_INPUT';
  readonly field: string;
  constructor(field: string, message: string);
}

export class ExecutionIdentityBlockedError extends Error {
  readonly code: string;
  constructor(code: string, message: string);
}

export const PreflightInputError: typeof WalletSendCallsInputError;
export const PreflightBlockedError: typeof ExecutionIdentityBlockedError;

export const BASE_CHAIN_ID: 8453;
export const BASE_CHAIN_HEX: '0x2105';
export const BASE_NETWORK: 'eip155:8453';
export const MAX_CALLS: number;
export const MAX_PREFLIGHT_CONCURRENCY: number;
export const MAX_RPC_OBSERVATION_CALLS: number;
export const MAX_DATA_BYTES: number;

export function isAffirmativePolicyResult(value: unknown): value is true | { allow: true; reason?: string };
export function validateWalletSendCallsRequest(request: unknown): WalletSendCallsRequest;
export const normalizeWalletSendCallsRequest: typeof validateWalletSendCallsRequest;
export function transactionFromCall(params: WalletSendCallsParams, call: WalletSendCallsCall, index?: number): TransactionPreflightRequest;
export function toPreflightTransaction(params: WalletSendCallsParams, call: WalletSendCallsCall, index?: number): TransactionPreflightRequest;
export function assertObservationReady(
  observation: unknown,
  transaction: TransactionPreflightRequest
): BaseAccountObservationIdentity;
export function guardWalletSendCalls(options: GuardWalletSendCallsOptions): Promise<unknown>;
export const preflightWalletSendCalls: typeof guardWalletSendCalls;
export const sendCallsWithPreflight: typeof guardWalletSendCalls;
export const executeWalletSendCalls: typeof guardWalletSendCalls;

export class BaseAccountPaymasterGuard {
  constructor(options: BaseAccountPaymasterGuardOptions);
  request(provider: Eip1193Provider, request: WalletSendCallsRequest, options?: BaseAccountGuardCallOptions): Promise<unknown>;
  sendCalls(provider: Eip1193Provider, request: WalletSendCallsRequest, options?: BaseAccountGuardCallOptions): Promise<unknown>;
}

export const BaseAccountExecutionGuard: typeof BaseAccountPaymasterGuard;
export function createBaseAccountPaymasterGuard(options: BaseAccountPaymasterGuardOptions): BaseAccountPaymasterGuard;
export function createExecutionIdentityGuard(options: BaseAccountPaymasterGuardOptions): BaseAccountPaymasterGuard;
export function createPublicClient(options: {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  sdk?: { M2MSentinelClient: typeof M2MSentinelClient };
}): M2MSentinelClient;

export type SentinelPolicy = (
  analysis: any,
  context: { targetAddress: string; integration: string }
) => boolean | { allow: boolean; reason?: string } | Promise<boolean | { allow: boolean; reason?: string }>;

export function enforceCallerPolicy(
  policy: SentinelPolicy | undefined,
  analysis: any,
  context: { targetAddress: string; integration: string }
): Promise<void>;

export function createEthersSentinelMiddleware(
  apiKey?: string,
  baseUrl?: string,
  policy?: SentinelPolicy
): {
  client: M2MSentinelClient;
  verifyContractBeforeTx(targetAddress: string, policyOverride?: SentinelPolicy): Promise<any>;
};

export function createViemSentinelInterceptor(
  apiKey?: string,
  baseUrl?: string,
  policy?: SentinelPolicy
): {
  client: M2MSentinelClient;
  inspectSwapTarget(address: string, policyOverride?: SentinelPolicy): Promise<any>;
};

export interface X402SignerClientOptions {
  wallet?: any;
  walletSigner?: any;
  privateKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
}

export class X402SignerClient {
  constructor(options?: X402SignerClientOptions);
  signPaymentAuthorization(challenge: any): Promise<any>;
  fetchWithAutoPayment(path: string, options?: any): Promise<any>;
}

export function x402SignerClient(options?: X402SignerClientOptions): X402SignerClient;
export function parsePaymentHeader(value: string | object | null): any;
export function parsePriceToUnits(priceStr: string | number, decimals?: number): bigint;
