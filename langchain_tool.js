'use strict';

/**
 * LangChain & LangGraph Tool Provider for M2M Sentinel.
 *
 * Compatible with @langchain/core/tools StructuredTool and DynamicStructuredTool.
 */

const { M2MSentinelClient } = require('./index.js');

class M2MSentinelLangChainTools {
  /**
   * @param {Object} [options]
   * @param {string} [options.apiKey] M2M Sentinel API Key
   * @param {string} [options.baseUrl] M2M Sentinel Base URL
   */
  constructor(options = {}) {
    this.client = new M2MSentinelClient(options);
  }

  /**
   * Return a list of tool definitions compatible with LangChain agents.
   * Can be passed directly to `createOpenAIToolsAgent({ tools })` or `AgentExecutor`.
   */
  getTools() {
    return [
      {
        name: 'm2m_audit_contract',
        description: 'Deterministic EVM bytecode capability analysis and proxy resolution for Base contracts. Run before signing or sending transactions to unverified contracts.',
        schema: {
          type: 'object',
          properties: {
            address: {
              type: 'string',
              description: 'The 0x-prefixed 40-hex Ethereum address on Base (Chain ID 8453) to inspect.'
            }
          },
          required: ['address']
        },
        func: async ({ address }) => {
          try {
            const res = await this.client.auditContract(address);
            return JSON.stringify(res);
          } catch (err) {
            return JSON.stringify({ error: err.message, status: err.status || 500 });
          }
        }
      },
      {
        name: 'm2m_get_gas_metrics',
        description: 'Fetch current Base gas price in wei/gwei with RPC provenance. Read-only telemetry; does not authorize or submit transactions.',
        schema: {
          type: 'object',
          properties: {}
        },
        func: async () => {
          try {
            const res = await this.client.getGasFees();
            return JSON.stringify(res);
          } catch (err) {
            return JSON.stringify({ error: err.message, status: err.status || 500 });
          }
        }
      },
      {
        name: 'm2m_get_token_price',
        description: 'Fetch sourced Base DEX spot price for one allowlisted token symbol (e.g. USDC, WETH), with pool provenance and no historical price series.',
        schema: {
          type: 'object',
          properties: {
            symbol: {
              type: 'string',
              description: 'The asset symbol (e.g., USDC, WETH).'
            }
          },
          required: ['symbol']
        },
        func: async ({ symbol }) => {
          try {
            const res = await this.client.getTokenPrice(symbol);
            return JSON.stringify(res);
          } catch (err) {
            return JSON.stringify({ error: err.message, status: err.status || 500 });
          }
        }
      }
    ];
  }
}

module.exports = {
  M2MSentinelLangChainTools
};
