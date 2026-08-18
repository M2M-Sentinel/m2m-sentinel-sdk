/**
 * M2M Sentinel ElizaOS Production Adapter Plugin
 * 
 * Provides automated pre-transaction contract capability preflight and proxy inspection
 * actions for autonomous agents running on the ElizaOS runtime framework.
 */

const { M2MSentinelClient } = require('./index.js');

function clientFor(runtime) {
  const apiKey = runtime?.getSetting?.('M2M_SENTINEL_API_KEY') || process.env.M2M_SENTINEL_API_KEY;
  return new M2MSentinelClient({ apiKey });
}

function errorText(err) {
  if (err.status === 402) return 'M2M Sentinel payment required. Configure M2M_SENTINEL_API_KEY or settle the x402 challenge.';
  if (err.status === 503 && err.body?.error === 'DATA_SOURCE_UNAVAILABLE') return 'M2M Sentinel data source unavailable; no estimated fallback value is returned.';
  if (err.status === 429) return 'M2M Sentinel rate limited. Retry-After: ' + (err.retryAfter || 'not provided');
  return 'M2M Sentinel API request failed: ' + err.message;
}

const m2mSentinelPlugin = {
  name: '@elizaos/plugin-m2m-sentinel',
  description: 'Preview ElizaOS actions for M2M Sentinel protected Web3 API routes.',
  actions: [
    {
      name: 'AUDIT_CONTRACT',
      description: 'Reports selected static capability and proxy observations for a Base contract.',
      handler: async (runtime, message) => {
        const address = message.content.text.match(/0x[a-fA-F0-9]{40}/)?.[0];
        if (!address) return { text: 'Please provide a valid 42-character EVM contract address.' };
        try {
          const data = await clientFor(runtime).auditContract(address);
          const audit = data.audit || {};
          const proxy = audit.proxyResolution || {};
          return { text: `M2M Sentinel capability analysis for ${address}: ${audit.capabilityRating || 'UNVERIFIED'}; proxy=${proxy.isProxy ? proxy.proxyType : 'NO'}; notASafetyGuarantee=true; provenance=${JSON.stringify(audit.provenance || data.provenance || null)}` };
        } catch (err) { return { text: errorText(err) }; }
      }
    },
    {
      name: 'GET_CAPABILITY_SCORE',
      description: 'Returns the static capability coverage index for a Base contract. The index is not a safety score.',
      handler: async (runtime, message) => {
        const address = message.content.text.match(/0x[a-fA-F0-9]{40}/)?.[0];
        if (!address) return { text: 'Please provide a valid EVM contract address.' };
        try {
          const data = await clientFor(runtime).getCapabilityScore(address);
          const score = data.capabilityScore === null ? 'unverified' : `${data.capabilityScore}/100 capability coverage`;
          return { text: `M2M Sentinel static index for ${address}: ${score}; not a safety score. Provenance: ${JSON.stringify(data.provenance || null)}` };
        } catch (err) { return { text: errorText(err) }; }
      }
    },
    {
      name: 'GET_DEX_METRICS',
      description: 'Fetches Base DEX metrics.',
      handler: async (runtime) => {
        try { return { text: JSON.stringify(await clientFor(runtime).getDexMetrics()) }; }
        catch (err) { return { text: errorText(err) }; }
      }
    },
    {
      name: 'GET_TOKEN_PRICE',
      description: 'Queries a tracked Base token price.',
      handler: async (runtime, message) => {
        const symbol = (message.content.text.match(/price of ([a-zA-Z0-9]+)/i)?.[1] || 'USDC').toUpperCase();
        try { return { text: JSON.stringify(await clientFor(runtime).getTokenPrice(symbol)) }; }
        catch (err) { return { text: errorText(err) }; }
      }
    },
    {
      name: 'GET_GAS_FEES',
      description: 'Fetches live Base gas fees.',
      handler: async (runtime) => {
        try { return { text: JSON.stringify(await clientFor(runtime).getGasFees()) }; }
        catch (err) { return { text: errorText(err) }; }
      }
    },
    {
      name: 'GET_WHALE_SIGNALS',
      description: 'Fetches whale signals.',
      handler: async (runtime) => {
        try { return { text: JSON.stringify(await clientFor(runtime).getWhaleSignals()) }; }
        catch (err) { return { text: errorText(err) }; }
      }
    }
  ]
};

module.exports = { m2mSentinelPlugin };
