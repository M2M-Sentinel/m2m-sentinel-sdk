'use strict';

/**
 * Coinbase AgentKit Action Provider for M2M Sentinel.
 *
 * Exposes pre-transaction contract bytecode capability inspection, proxy resolution,
 * and market observations to autonomous Base agents using @coinbase/agentkit.
 */

const https = require('https');
const http = require('http');

const DEFAULT_BASE_URL = process.env.M2M_SENTINEL_BASE_URL || 'https://api.m2msentinel.com';
const DEFAULT_TIMEOUT_MS = Number(process.env.M2M_SENTINEL_TIMEOUT_MS || 30000);

class M2MSentinelActionProvider {
  constructor(options = {}) {
    this.name = 'm2m_sentinel';
    this.actionProviderName = 'm2m_sentinel';
    this.baseUrl = options.baseUrl || DEFAULT_BASE_URL;
    this.apiKey = options.apiKey || process.env.M2M_SENTINEL_API_KEY || '';
    this.timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS);
  }

  supportsNetwork(network) {
    if (!network) return true;
    const chainId = String(network.chainId || network.networkId || '');
    const protocolFamily = String(network.protocolFamily || 'evm').toLowerCase();
    return protocolFamily === 'evm' && (
      chainId === '8453' ||
      chainId === 'base' ||
      chainId === 'base-mainnet' ||
      chainId === 'base-sepolia' ||
      chainId === '84532'
    );
  }

  async _queryApi(endpointPath, options = {}) {
    const url = new URL(endpointPath, this.baseUrl);
    const isHttps = url.protocol === 'https:';
    const transport = isHttps ? https : http;

    const headers = {
      Accept: 'application/json',
      'User-Agent': 'M2MSentinel-AgentKit/1.1.1',
      ...options.headers
    };
    if (this.apiKey && !headers['x-api-key']) {
      headers['x-api-key'] = this.apiKey;
    }

    return new Promise((resolve, reject) => {
      const req = transport.request(url, {
        method: 'GET',
        headers,
        timeout: this.timeoutMs
      }, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          let body = null;
          if (data) {
            try { body = JSON.parse(data); } catch (_) { body = { raw: data }; }
          }
          resolve({
            statusCode: res.statusCode,
            ok: res.statusCode >= 200 && res.statusCode < 300,
            body
          });
        });
      });

      req.on('timeout', () => req.destroy(new Error('M2M Sentinel request timed out')));
      req.on('error', reject);
      req.end();
    });
  }

  async auditContract(args) {
    const address = String(args.address || args.contractAddress || '').trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
      return JSON.stringify({
        status: 'ERROR',
        error: 'INVALID_ADDRESS',
        message: 'A valid 40-hex 0x-prefixed Base contract address is required.'
      });
    }

    const res = await this._queryApi(`/v1/audit/${encodeURIComponent(address)}`);
    if (!res.ok) {
      return JSON.stringify({
        status: 'ERROR',
        statusCode: res.statusCode,
        error: res.body && res.body.error ? res.body.error : 'API_ERROR',
        message: res.body && res.body.message ? res.body.message : 'Contract audit query failed',
        notASafetyGuarantee: true
      });
    }

    return JSON.stringify({
      status: 'SUCCESS',
      data: res.body,
      notASafetyGuarantee: true,
      observationSummary: `Contract ${address}: Type=${res.body.bytecodeAnalysis?.contractType || 'UNKNOWN'}, isProxy=${Boolean(res.body.proxyDetection?.isProxy)}`
    });
  }

  async getGasMetrics() {
    const res = await this._queryApi('/v1/gas/fees');
    if (!res.ok) {
      return JSON.stringify({ status: 'ERROR', statusCode: res.statusCode, message: 'Failed to retrieve gas fees' });
    }
    return JSON.stringify(res.body);
  }

  async getTokenPrice(args) {
    const symbol = String(args.symbol || args.tokenSymbol || '').trim().toUpperCase();
    if (!symbol) {
      return JSON.stringify({ status: 'ERROR', message: 'Token symbol is required (e.g. USDC, WETH)' });
    }
    const res = await this._queryApi(`/v1/token/price/${encodeURIComponent(symbol)}`);
    if (!res.ok) {
      return JSON.stringify({ status: 'ERROR', statusCode: res.statusCode, message: `Failed to retrieve price for ${symbol}` });
    }
    return JSON.stringify(res.body);
  }

  async getServiceStatus() {
    const res = await this._queryApi('/v1/status');
    if (!res.ok) {
      return JSON.stringify({ status: 'UNAVAILABLE', statusCode: res.statusCode });
    }
    return JSON.stringify(res.body);
  }

  getActions(_walletProvider) {
    return [
      {
        name: 'm2m_audit_contract',
        description: 'Inspect Base target contract bytecode capability observations, proxy implementation slots, and limitations before executing transactions. Returns factual evidence, not a safety guarantee.',
        schema: {
          type: 'object',
          properties: {
            address: {
              type: 'string',
              description: 'Target Base contract address (0x-prefixed 40-hex)'
            }
          },
          required: ['address']
        },
        invoke: (args) => this.auditContract(args)
      },
      {
        name: 'm2m_get_gas_metrics',
        description: 'Get real-time Base network gas execution metrics and recommendations before submitting on-chain transactions.',
        schema: {
          type: 'object',
          properties: {}
        },
        invoke: () => this.getGasMetrics()
      },
      {
        name: 'm2m_get_token_price',
        description: 'Observe real-time Base DEX token price for slippage check and valuation.',
        schema: {
          type: 'object',
          properties: {
            symbol: {
              type: 'string',
              description: 'Token symbol on Base (e.g. USDC, WETH)'
            }
          },
          required: ['symbol']
        },
        invoke: (args) => this.getTokenPrice(args)
      },
      {
        name: 'm2m_get_service_status',
        description: 'Check operational status of M2M Sentinel upstream verification rails.',
        schema: {
          type: 'object',
          properties: {}
        },
        invoke: () => this.getServiceStatus()
      }
    ];
  }
}

function m2mSentinelActionProvider(options = {}) {
  return new M2MSentinelActionProvider(options);
}

// Backward compatibility alias
class M2MSentinelAgentTool extends M2MSentinelActionProvider {}

module.exports = {
  M2MSentinelActionProvider,
  m2mSentinelActionProvider,
  M2MSentinelAgentTool
};
