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
  getGasFees(options?: M2MSentinelClientOptions): Promise<any>;
  getDexMetrics(options?: M2MSentinelClientOptions): Promise<any>;
  getTokenPrice(symbol: string, options?: M2MSentinelClientOptions): Promise<any>;
  getWhaleSignals(options?: M2MSentinelClientOptions): Promise<any>;
  getKeySelf(): Promise<any>;
  revokeKey(confirm?: boolean): Promise<any>;
}

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
