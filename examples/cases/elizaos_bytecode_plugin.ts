/**
 * ElizaOS (ai16z) Plugin: M2M Sentinel EVM Preflight Guard
 * 
 * Protects autonomous ElizaOS agents operating on Base from interacting with:
 * - Uninstantiated or broken proxy delegates (implementation slot = 0x0)
 * - Contracts with active freeze or blacklist selectors
 * - Self-destructable or malicious fallback hooks
 */

import { Plugin, Action, IAgentRuntime, Memory, State, HandlerCallback } from '@elizaos/core';

export interface M2MAuditResponse {
  address: string;
  hasCode: boolean;
  proxy: {
    isProxy: boolean;
    proxyType?: string;
    implementationAddress?: string;
  };
  observedCapabilities: string[];
  trustLevel: string;
  analysisKind: string;
  notASafetyGuarantee: string;
}

export const auditContractAction: Action = {
  name: 'M2M_AUDIT_CONTRACT',
  similes: ['CHECK_CONTRACT_SECURITY', 'INSPECT_TOKEN_BYTECODE', 'VERIFY_BASE_PROXY'],
  description: 'Audits an EVM contract on Base in <35ms for proxy implementation validity and observed capabilities.',
  
  validate: async (runtime: IAgentRuntime, message: Memory) => {
    const text = message.content?.text || '';
    return /0x[a-fA-F0-9]{40}/.test(text);
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    _options: any,
    callback: HandlerCallback
  ) => {
    const text = message.content?.text || '';
    const match = text.match(/0x[a-fA-F0-9]{40}/);
    if (!match) {
      callback({ text: 'Error: No valid EVM contract address detected in prompt.' });
      return false;
    }

    const address = match[0];
    const apiKey = runtime.getSetting('M2M_SENTINEL_API_KEY');
    const endpoint = `https://m2msentinel.vercel.app/v1/audit/${address}`;

    try {
      const headers: Record<string, string> = { 'Accept': 'application/json' };
      if (apiKey) headers['x-api-key'] = apiKey;

      const res = await fetch(endpoint, { headers });
      if (!res.ok) {
        callback({ text: `Preflight audit failed: HTTP ${res.status} from M2M Sentinel.` });
        return false;
      }

      const audit: M2MAuditResponse = await res.json();
      
      const isProxy = audit.proxy?.isProxy || false;
      const impl = audit.proxy?.implementationAddress || 'None';
      const capabilities = audit.observedCapabilities?.join(', ') || 'Standard ERC-20';

      const summary = [
        `🛡️ **M2M Sentinel Preflight Report for ${address.slice(0, 8)}...**`,
        `- **Bytecode Present**: ${audit.hasCode ? '✅ Yes' : '❌ No (EOA)'}`,
        `- **Proxy Pattern**: ${isProxy ? `⚡ ${audit.proxy.proxyType || 'Proxy'} (Impl: ${impl})` : 'Direct Contract'}`,
        `- **Capabilities**: ${capabilities}`,
        `- **Trust Provenance**: ${audit.trustLevel}`,
        `\n*Notice: ${audit.notASafetyGuarantee}*`
      ].join('\n');

      callback({ text: summary, content: audit });
      return true;
    } catch (err: any) {
      callback({ text: `Preflight audit exception: ${err.message}` });
      return false;
    }
  },

  examples: [
    [
      {
        user: '{{user1}}',
        content: { text: 'Audit contract 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 before swap' }
      },
      {
        user: '{{agentName}}',
        content: { text: 'Executing M2M Sentinel preflight bytecode check for 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913...' }
      }
    ]
  ]
};

export const m2mSentinelPlugin: Plugin = {
  name: 'm2m-sentinel',
  description: 'Pre-transaction bytecode capability intelligence for Base AI agents.',
  actions: [auditContractAction]
};

export default m2mSentinelPlugin;
