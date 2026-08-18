const DEFAULT_BASE_URL = 'https://api.m2msentinel.com';
const DEFAULT_TIMEOUT_MS = 30000;

class M2MSentinelError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = this.constructor.name;
    this.status = options.status;
    this.body = options.body;
    this.retryAfter = options.retryAfter || null;
    this.paymentRequired = options.paymentRequired || null;
    this.paymentResponse = options.paymentResponse || null;
  }
}

class PaymentRequiredError extends M2MSentinelError {}
class RateLimitedError extends M2MSentinelError {}
class DataSourceUnavailableError extends M2MSentinelError {}

function parseX402Header(value) {
  if (!value) return null;
  // x402 v2 transports protocol objects as base64 JSON. Retain raw-JSON
  // compatibility for older M2M Sentinel deployments during upgrades.
  try { return JSON.parse(value); } catch (_) { /* try v2 encoding */ }
  try {
    const normalized = String(value).replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch (_) {
    return null;
  }
}

function normalizeOptions(optionsOrApiKey, baseUrl) {
  if (optionsOrApiKey && typeof optionsOrApiKey === 'object') return { ...optionsOrApiKey };
  return { apiKey: optionsOrApiKey || undefined, baseUrl: baseUrl || DEFAULT_BASE_URL };
}

class M2MSentinelClient {
  constructor(optionsOrApiKey, baseUrl) {
    const options = normalizeOptions(optionsOrApiKey, baseUrl);
    this.baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.apiKey = options.apiKey || undefined;
    this.timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.paymentSignature = options.paymentSignature || undefined;
  }

  async request(method, path, body, options = {}) {
    const headers = {
      'Accept': 'application/json'
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const apiKey = options.apiKey || this.apiKey;
    if (apiKey) headers['x-api-key'] = apiKey;
    if (options.operatorToken) headers.Authorization = 'Bearer ' + options.operatorToken;
    const paymentSignature = options.paymentSignature || this.paymentSignature;
    if (paymentSignature) headers['PAYMENT-SIGNATURE'] = paymentSignature;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs || this.timeoutMs);
    let response;
    try {
      response = await fetch(this.baseUrl + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal
      });
    } catch (err) {
      if (err && err.name === 'AbortError') throw new M2MSentinelError('M2M Sentinel request timed out', { status: 0 });
      throw err;
    } finally {
      clearTimeout(timeout);
    }

    const text = await response.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch (_) { data = { raw: text }; }
    }

    const paymentRequired = parseX402Header(response.headers.get('PAYMENT-REQUIRED'));
    const paymentResponse = parseX402Header(response.headers.get('PAYMENT-RESPONSE')) || response.headers.get('PAYMENT-RESPONSE');
    if (response.ok) return data;

    const details = {
      status: response.status,
      body: data,
      retryAfter: response.headers.get('Retry-After'),
      paymentRequired,
      paymentResponse
    };
    const message = data && data.message ? data.message : 'M2M Sentinel HTTP ' + response.status;
    if (response.status === 402) throw new PaymentRequiredError(message, details);
    if (response.status === 429) throw new RateLimitedError(message, details);
    if (response.status === 503 && data && data.error === 'DATA_SOURCE_UNAVAILABLE') throw new DataSourceUnavailableError(message, details);
    throw new M2MSentinelError(message, details);
  }

  getStatus() { return this.request('GET', '/v1/status'); }
  getPublicStats(days = 30) { return this.request('GET', '/v1/stats?days=' + encodeURIComponent(days)); }
  // Backward-compatible alias. Ordinary/customer credentials still receive
  // only the counter-free public privacy envelope.
  getAggregateStats(days = 30) { return this.getPublicStats(days); }
  getOperatorAggregateStats(days, operatorToken) {
    return this.request('GET', '/v1/stats?days=' + encodeURIComponent(days || 30), undefined, { operatorToken });
  }
  getPlans() { return this.request('GET', '/v1/plans'); }
  demoAudit(address) { return this.request('GET', '/v1/demo/audit/' + encodeURIComponent(address)); }
  createFreeChallenge(userWallet) { return this.request('POST', '/v1/subscribe/free/challenge', { userWallet }); }
  claimFreeTier(intentId, signature) { return this.request('POST', '/v1/subscribe/free/claim', { intentId, signature }); }
  createSubscriptionIntent(tier, userWallet, options = {}) {
    const body = { tier, userWallet };
    if (options.durationDays !== undefined) body.durationDays = options.durationDays;
    if (options.renewExistingKey !== undefined) body.renewExistingKey = options.renewExistingKey;
    return this.request('POST', '/v1/subscribe/intents', body, options);
  }
  claimSubscription(intentId, signature, txHash) { return this.request('POST', '/v1/subscribe/crypto', { intentId, signature, txHash }); }
  createRecoveryChallenge(userWallet, options = {}) {
    const body = { userWallet };
    if (options.txHash !== undefined) body.txHash = options.txHash;
    return this.request('POST', '/v1/keys/recovery/challenge', body);
  }
  claimRecoveredKey(intentId, signature) {
    return this.request('POST', '/v1/keys/recovery/claim', { intentId, signature });
  }
  auditContract(address, options) { return this.request('GET', '/v1/audit/' + encodeURIComponent(address), undefined, options); }
  getCapabilityScore(address, options) { return this.request('GET', '/v1/security/score/' + encodeURIComponent(address), undefined, options); }
  // Legacy method name; the response is a capability coverage index, not a safety score.
  getSecurityScore(address, options) { return this.request('GET', '/v1/security/score/' + encodeURIComponent(address), undefined, options); }
  getGasFees(options) { return this.request('GET', '/v1/gas/fees', undefined, options); }
  getDexMetrics(options) { return this.request('GET', '/v1/dex/metrics', undefined, options); }
  getTokenPrice(symbol, options) { return this.request('GET', '/v1/token/price/' + encodeURIComponent(symbol), undefined, options); }
  getWhaleSignals(options) { return this.request('GET', '/v1/whales/signals', undefined, options); }
  getKeySelf() { return this.request('GET', '/v1/keys/self'); }
  revokeKey(confirm = true) { return this.request('POST', '/v1/keys/revoke', { confirm }); }
}

async function enforceCallerPolicy(policy, analysis, context) {
  if (typeof policy !== 'function') {
    throw new Error('[M2M Sentinel] A caller-defined policy function is required. Static capability observations are not a safety decision.');
  }
  const result = await policy(analysis, context);
  if (result === false || (result && result.allow === false)) {
    const reason = result && result.reason ? result.reason : 'caller-defined policy rejected the transaction';
    throw new Error('[M2M Sentinel] Transaction blocked: ' + reason + '.');
  }
}

function createEthersSentinelMiddleware(apiKey, baseUrl, policy) {
  const client = new M2MSentinelClient({ apiKey, baseUrl });
  return {
    client,
    verifyContractBeforeTx: async (targetAddress, policyOverride) => {
      const audit = await client.auditContract(targetAddress);
      await enforceCallerPolicy(policyOverride || policy, audit, { targetAddress, integration: 'ethers' });
      return audit;
    }
  };
}

function createViemSentinelInterceptor(apiKey, baseUrl, policy) {
  const client = new M2MSentinelClient({ apiKey, baseUrl });
  return {
    client,
    inspectSwapTarget: async (address, policyOverride) => {
      const analysis = await client.getCapabilityScore(address);
      await enforceCallerPolicy(policyOverride || policy, analysis, { targetAddress: address, integration: 'viem' });
      return analysis;
    }
  };
}

const { M2MSentinelActionProvider, m2mSentinelActionProvider } = require('./agent_adapter.js');
const { X402SignerClient, x402SignerClient, parsePaymentHeader, parsePriceToUnits } = require('./x402_signer.js');

module.exports = {
  M2MSentinelClient,
  M2MSentinelError,
  PaymentRequiredError,
  RateLimitedError,
  DataSourceUnavailableError,
  enforceCallerPolicy,
  createEthersSentinelMiddleware,
  createViemSentinelInterceptor,
  M2MSentinelActionProvider,
  m2mSentinelActionProvider,
  X402SignerClient,
  x402SignerClient,
  parsePaymentHeader,
  parsePriceToUnits
};
