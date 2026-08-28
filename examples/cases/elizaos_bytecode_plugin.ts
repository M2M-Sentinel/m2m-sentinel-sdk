/**
 * ElizaOS (ai16z) Plugin: M2M Sentinel EVM Preflight Observations
 * 
 * Returns factual static-bytecode evidence. The embedding agent must apply a
 * caller-defined policy before it decides whether to execute a transaction.
 */

import { Plugin, Action, IAgentRuntime, Memory, State, HandlerCallback } from '@elizaos/core';

export interface M2MAuditResponse {
  status: string;
  audit: {
    address: string;
    analysisKind: string;
    notASafetyGuarantee: boolean;
    limitations: string[];
    reachability?: string;
    dissection: {
      isValidContract: boolean;
      capabilities: Array<{ type: string; [key: string]: unknown }>;
    };
    verdict: {
      executableCapabilities: string[];
    };
    proxyResolution: {
      isProxy: boolean;
      proxyType?: string;
      targetAddress?: string;
    };
    provenance?: { trustLevel?: string };
  };
}

export const auditContractAction: Action = {
  name: 'M2M_AUDIT_CONTRACT',
  similes: ['INSPECT_CONTRACT_BYTECODE', 'OBSERVE_TOKEN_BYTECODE', 'RESOLVE_BASE_PROXY'],
  description: 'Observes static EVM bytecode capabilities and proxy-resolution evidence for a Base contract.',
  
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
    const endpoint = `https://api.m2msentinel.com/v1/audit/${address}`;

    try {
      const headers: Record<string, string> = { 'Accept': 'application/json' };
      if (apiKey) headers['x-api-key'] = apiKey;

      const res = await fetch(endpoint, { headers });
      if (!res.ok) {
        callback({ text: `Preflight audit failed: HTTP ${res.status} from M2M Sentinel.` });
        return false;
      }

      const response: M2MAuditResponse = await res.json();
      const audit = response.audit;
      
      const isProxy = audit.proxyResolution?.isProxy || false;
      const impl = audit.proxyResolution?.targetAddress || 'Unresolved';
      const capabilityNames = audit.verdict?.executableCapabilities
        || audit.dissection?.capabilities?.map((capability) => capability.type)
        || [];
      const capabilities = capabilityNames.join(', ') || 'None observed';

      const summary = [
        `**M2M Sentinel Static Observation for ${address.slice(0, 8)}...**`,
        `- **Bytecode Present**: ${audit.dissection?.isValidContract ? 'Yes' : 'No bytecode observed'}`,
        `- **Proxy Pattern**: ${isProxy ? `${audit.proxyResolution.proxyType || 'Proxy'} (Target: ${impl})` : 'None observed'}`,
        `- **Capabilities**: ${capabilities}`,
        `- **Trust Provenance**: ${audit.provenance?.trustLevel || 'Not reported'}`,
        `- **Reachability**: ${audit.reachability || 'NOT_ESTABLISHED'}`,
        '\n*Apply a caller-defined execution policy. Static observations are not a safety guarantee.*'
      ].join('\n');

      callback({ text: summary, content: response });
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
        content: { text: 'Retrieving M2M Sentinel static bytecode observations for 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913...' }
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
