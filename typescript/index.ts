export interface M2MSentinelClientOptions {
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  paymentSignature?: string;
}

interface M2MSentinelRequestOptions extends M2MSentinelClientOptions {
  operatorToken?: string;
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
  body?: any;
  retryAfter?: string | null;
  paymentRequired?: any;
  paymentResponse?: any;
}

export class M2MSentinelError extends Error {
  public readonly status?: number;
  public readonly body?: any;
  public readonly retryAfter?: string | null;
  public readonly paymentRequired?: any;
  public readonly paymentResponse?: any;

  constructor(message: string, options: M2MSentinelErrorOptions = {}) {
    super(message);
    this.name = new.target.name;
    this.status = options.status;
    this.body = options.body;
    this.retryAfter = options.retryAfter || null;
    this.paymentRequired = options.paymentRequired || null;
    this.paymentResponse = options.paymentResponse || null;
  }
}

export class PaymentRequiredError extends M2MSentinelError {}
export class RateLimitedError extends M2MSentinelError {}
export class DataSourceUnavailableError extends M2MSentinelError {}

const DEFAULT_BASE_URL = 'https://api.m2msentinel.com';
const DEFAULT_TIMEOUT_MS = 30000;

function parseX402Header(value: string | null): any {
  if (!value) return null;
  try { return JSON.parse(value); } catch { /* try v2 encoding */ }
  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
    const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

export class M2MSentinelClient {
  private baseUrl: string;
  private apiKey?: string;
  private timeoutMs: number;
  private paymentSignature?: string;

  constructor(optionsOrBaseUrl: M2MSentinelClientOptions | string = {}, apiKey?: string) {
    const options = typeof optionsOrBaseUrl === 'string'
      ? { baseUrl: optionsOrBaseUrl, apiKey }
      : optionsOrBaseUrl;
    this.baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.paymentSignature = options.paymentSignature;
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: any, options: M2MSentinelRequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = {
      Accept: 'application/json'
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const key = options.apiKey || this.apiKey;
    if (key) headers['x-api-key'] = key;
    if (options.operatorToken) headers.Authorization = `Bearer ${options.operatorToken}`;
    const paymentSignature = options.paymentSignature || this.paymentSignature;
    if (paymentSignature) headers['PAYMENT-SIGNATURE'] = paymentSignature;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs || this.timeoutMs);
    let response: Response;
    try {
      response = await fetch(this.baseUrl + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }

    const text = await response.text();
    let data: any = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = { raw: text }; }
    }
    if (response.ok) return data as T;

    const errorOptions = {
      status: response.status,
      body: data,
      retryAfter: response.headers.get('Retry-After'),
      paymentRequired: parseX402Header(response.headers.get('PAYMENT-REQUIRED')),
      paymentResponse: parseX402Header(response.headers.get('PAYMENT-RESPONSE')) || response.headers.get('PAYMENT-RESPONSE')
    };
    const message = data?.message || `M2M Sentinel HTTP ${response.status}`;
    if (response.status === 402) throw new PaymentRequiredError(message, errorOptions);
    if (response.status === 429) throw new RateLimitedError(message, errorOptions);
    if (response.status === 503 && data?.error === 'DATA_SOURCE_UNAVAILABLE') throw new DataSourceUnavailableError(message, errorOptions);
    throw new M2MSentinelError(message, errorOptions);
  }

  public getStatus() { return this.request<any>('GET', '/v1/status'); }
  public getPublicStats(days = 30) { return this.request<any>('GET', `/v1/stats?days=${encodeURIComponent(days)}`); }
  public getAggregateStats(days = 30) { return this.getPublicStats(days); }
  public getOperatorAggregateStats(days: number, operatorToken: string) {
    return this.request<any>('GET', `/v1/stats?days=${encodeURIComponent(days || 30)}`, undefined, { operatorToken });
  }
  public getPlans() { return this.request<any>('GET', '/v1/plans'); }
  public demoAudit(address: string) { return this.request<any>('GET', `/v1/demo/audit/${encodeURIComponent(address)}`); }
  public createFreeChallenge(userWallet: string) { return this.request<any>('POST', '/v1/subscribe/free/challenge', { userWallet }); }
  public claimFreeTier(intentId: string, signature: string) { return this.request<any>('POST', '/v1/subscribe/free/claim', { intentId, signature }); }
  public createSubscriptionIntent(tier: string, userWallet: string, options: CreateSubscriptionIntentOptions = {}) {
    const body: Record<string, any> = { tier, userWallet };
    if (options.durationDays !== undefined) body.durationDays = options.durationDays;
    if (options.renewExistingKey !== undefined) body.renewExistingKey = options.renewExistingKey;
    return this.request<any>('POST', '/v1/subscribe/intents', body, options);
  }
  public claimSubscription(intentId: string, signature: string, txHash: string) { return this.request<any>('POST', '/v1/subscribe/crypto', { intentId, signature, txHash }); }
  public createRecoveryChallenge(userWallet: string, options: RecoveryChallengeOptions = {}) {
    const body: Record<string, string> = { userWallet };
    if (options.txHash !== undefined) body.txHash = options.txHash;
    return this.request<any>('POST', '/v1/keys/recovery/challenge', body);
  }
  public claimRecoveredKey(intentId: string, signature: string) {
    return this.request<any>('POST', '/v1/keys/recovery/claim', { intentId, signature });
  }
  public auditContract(address: string, options?: M2MSentinelClientOptions) { return this.request<any>('GET', `/v1/audit/${encodeURIComponent(address)}`, undefined, options); }
  public getCapabilityScore(address: string, options?: M2MSentinelClientOptions) { return this.request<any>('GET', `/v1/security/score/${encodeURIComponent(address)}`, undefined, options); }
  /** Legacy name. The response is a capability coverage index, not a safety score. */
  public getSecurityScore(address: string, options?: M2MSentinelClientOptions) { return this.request<any>('GET', `/v1/security/score/${encodeURIComponent(address)}`, undefined, options); }
  public getGasFees(options?: M2MSentinelClientOptions) { return this.request<any>('GET', '/v1/gas/fees', undefined, options); }
  public getDexMetrics(options?: M2MSentinelClientOptions) { return this.request<any>('GET', '/v1/dex/metrics', undefined, options); }
  public getTokenPrice(symbol: string, options?: M2MSentinelClientOptions) { return this.request<any>('GET', `/v1/token/price/${encodeURIComponent(symbol)}`, undefined, options); }
  public getWhaleSignals(options?: M2MSentinelClientOptions) { return this.request<any>('GET', '/v1/whales/signals', undefined, options); }
  public getKeySelf() { return this.request<any>('GET', '/v1/keys/self'); }
  public revokeKey(confirm = true) { return this.request<any>('POST', '/v1/keys/revoke', { confirm }); }
}

export type SentinelPolicy = (analysis: any, context: { targetAddress: string; integration: string }) =>
  boolean | { allow: boolean; reason?: string } | Promise<boolean | { allow: boolean; reason?: string }>;

export async function enforceCallerPolicy(policy: SentinelPolicy | undefined, analysis: any, context: { targetAddress: string; integration: string }) {
  if (typeof policy !== 'function') {
    throw new Error('[M2M Sentinel] A caller-defined policy function is required. Static capability observations are not a safety decision.');
  }
  const result = await policy(analysis, context);
  if (result === false || (typeof result === 'object' && result !== null && result.allow === false)) {
    const reason = typeof result === 'object' && result !== null && result.reason
      ? result.reason
      : 'caller-defined policy rejected the transaction';
    throw new Error(`[M2M Sentinel] Transaction blocked: ${reason}.`);
  }
}

export function createEthersSentinelMiddleware(apiKey?: string, baseUrl?: string, policy?: SentinelPolicy) {
  const client = new M2MSentinelClient({ apiKey, baseUrl });
  return {
    client,
    verifyContractBeforeTx: async (targetAddress: string, policyOverride?: SentinelPolicy) => {
      const audit = await client.auditContract(targetAddress);
      await enforceCallerPolicy(policyOverride || policy, audit, { targetAddress, integration: 'ethers' });
      return audit;
    }
  };
}

export function createViemSentinelInterceptor(apiKey?: string, baseUrl?: string, policy?: SentinelPolicy) {
  const client = new M2MSentinelClient({ apiKey, baseUrl });
  return {
    client,
    inspectSwapTarget: async (address: string, policyOverride?: SentinelPolicy) => {
      const analysis = await client.getCapabilityScore(address);
      await enforceCallerPolicy(policyOverride || policy, analysis, { targetAddress: address, integration: 'viem' });
      return analysis;
    }
  };
}

export {
  BASE_USDC_CONTRACT,
  BASE_CHAIN_ID,
  EXPECTED_PAYOUT_RECIPIENT,
  DEFAULT_MAX_PRICE_USD,
  X402SignerClientOptions,
  X402PaymentChallenge,
  X402SignedAuthorization,
  parsePriceToUnits,
  parsePaymentHeader,
  X402SignerClient,
  x402SignerClient
} from './x402';
