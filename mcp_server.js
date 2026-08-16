#!/usr/bin/env node
'use strict';

const https = require('https');
const http = require('http');
const readline = require('readline');

const BASE_URL = process.env.M2M_SENTINEL_BASE_URL || 'https://m2msentinel.vercel.app';
const API_KEY = process.env.M2M_SENTINEL_API_KEY || '';
const TIMEOUT_MS = Number(process.env.M2M_SENTINEL_TIMEOUT_MS || 30000);

const TOOLS = [
  {
    name: 'm2m_audit_contract',
    description: 'Return selected static bytecode capability observations, common proxy resolution, limitations, and provenance for a Base contract. This is factual capability observation, not a safety or exploitability guarantee.',
    inputSchema: { type: 'object', properties: { address: { type: 'string', description: 'Base contract address (0x...)' } }, required: ['address'] }
  },
  {
    name: 'm2m_get_gas_metrics',
    description: 'Return sourced Base gas fee metrics and execution recommendations.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'm2m_get_token_price',
    description: 'Return sourced Base DEX token price observation for allowlisted assets (e.g. USDC, WETH).',
    inputSchema: { type: 'object', properties: { symbol: { type: 'string', description: 'Token symbol (USDC, WETH)' } }, required: ['symbol'] }
  },
  {
    name: 'm2m_get_dex_liquidity',
    description: 'Return tracked Base DEX pool reserve and liquidity metrics.',
    inputSchema: { type: 'object', properties: { pair: { type: 'string' } } }
  },
  {
    name: 'm2m_get_whale_signals',
    description: 'Return tracked Base whale transfer signals.',
    inputSchema: { type: 'object', properties: { limit: { type: 'number' } } }
  },
  {
    name: 'm2m_get_service_status',
    description: 'Return real-time operational status of M2M Sentinel upstream RPC and persistence rails.',
    inputSchema: { type: 'object', properties: {} }
  },
  // Backwards compatibility aliases
  {
    name: 'audit_contract',
    description: 'Alias for m2m_audit_contract.',
    inputSchema: { type: 'object', properties: { address: { type: 'string' } }, required: ['address'] }
  },
  {
    name: 'get_capability_score',
    description: 'Return the static capability coverage index and provenance for a Base contract. This is not a safety score.',
    inputSchema: { type: 'object', properties: { address: { type: 'string' } }, required: ['address'] }
  },
  {
    name: 'get_gas_fees',
    description: 'Alias for m2m_get_gas_metrics.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'get_dex_metrics',
    description: 'Alias for m2m_get_dex_liquidity.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'get_token_price',
    description: 'Alias for m2m_get_token_price.',
    inputSchema: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'] }
  },
  {
    name: 'get_whale_signals',
    description: 'Alias for m2m_get_whale_signals.',
    inputSchema: { type: 'object', properties: {} }
  }
];

function parseX402Header(value) {
  if (!value) return null;
  try { return JSON.parse(value); } catch (_) {}
  try {
    const normalized = String(value).replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch (_) {
    return null;
  }
}

function queryApi(path) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const isHttps = url.protocol === 'https:';
    const transport = isHttps ? https : http;
    const headers = { Accept: 'application/json', 'User-Agent': 'M2MSentinel-MCP/1.1.0' };
    if (API_KEY) headers['x-api-key'] = API_KEY;

    const req = transport.request(url, { method: 'GET', headers, timeout: TIMEOUT_MS }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let body = null;
        if (data) {
          try { body = JSON.parse(data); } catch (_) { body = { raw: data }; }
        }
        resolve({
          status: res.statusCode,
          ok: res.statusCode >= 200 && res.statusCode < 300,
          body,
          paymentRequired: parseX402Header(res.headers['payment-required'] || res.headers['x-payment-required']),
          paymentResponse: parseX402Header(res.headers['payment-response'] || res.headers['x-payment-response']),
          retryAfter: res.headers['retry-after'] || null
        });
      });
    });
    req.on('timeout', () => req.destroy(new Error('M2M Sentinel request timed out')));
    req.on('error', reject);
    req.end();
  });
}

function pathForTool(name, args) {
  const input = args || {};
  switch (name) {
    case 'm2m_audit_contract':
    case 'audit_contract':
      if (!input.address) throw new Error('address is required');
      return '/v1/audit/' + encodeURIComponent(input.address);
    case 'get_capability_score':
      if (!input.address) throw new Error('address is required');
      return '/v1/security/score/' + encodeURIComponent(input.address);
    case 'm2m_get_gas_metrics':
    case 'get_gas_fees':
      return '/v1/gas/fees';
    case 'm2m_get_dex_liquidity':
    case 'get_dex_metrics':
      return '/v1/dex/metrics';
    case 'm2m_get_token_price':
    case 'get_token_price':
      if (!input.symbol) throw new Error('symbol is required');
      return '/v1/token/price/' + encodeURIComponent(input.symbol);
    case 'm2m_get_whale_signals':
    case 'get_whale_signals':
      return '/v1/whales/signals';
    case 'm2m_get_service_status':
      return '/v1/status';
    default:
      throw new Error('Unknown tool: ' + name);
  }
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function success(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function failure(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  send({ jsonrpc: '2.0', id, error });
}

async function handle(request) {
  if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
    failure(request && request.id !== undefined ? request.id : null, -32600, 'Invalid Request');
    return;
  }
  if (request.id === undefined || request.id === null) return;

  try {
    if (request.method === 'initialize') {
      success(request.id, {
        protocolVersion: request.params && request.params.protocolVersion ? request.params.protocolVersion : '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'm2m-sentinel-mcp', version: '1.1.0' }
      });
      return;
    }
    if (request.method === 'tools/list') {
      success(request.id, { tools: TOOLS });
      return;
    }
    if (request.method === 'tools/call') {
      const params = request.params || {};
      const path = pathForTool(params.name, params.arguments || {});
      const apiResult = await queryApi(path);
      const isError = !apiResult.ok;
      success(request.id, {
        content: [{ type: 'text', text: typeof apiResult.body === 'object' ? JSON.stringify(apiResult.body, null, 2) : String(apiResult.body) }],
        isError,
        structuredContent: apiResult.body,
        _meta: {
          httpStatus: apiResult.status,
          paymentRequired: apiResult.paymentRequired,
          paymentResponse: apiResult.paymentResponse,
          retryAfter: apiResult.retryAfter,
          notASafetyGuarantee: true
        }
      });
      return;
    }
    failure(request.id, -32601, 'Method not found');
  } catch (err) {
    failure(request.id, -32603, err && err.message ? err.message : 'Internal error');
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let request;
  try {
    request = JSON.parse(line);
  } catch (_) {
    failure(null, -32700, 'Parse error');
    return;
  }
  handle(request);
});

module.exports = { TOOLS, pathForTool, parseX402Header };
