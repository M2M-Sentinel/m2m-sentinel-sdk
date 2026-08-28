#!/usr/bin/env node
'use strict';

const https = require('https');
const http = require('http');
const readline = require('readline');

let BASE_URL = process.env.M2M_SENTINEL_BASE_URL || 'https://api.m2msentinel.com';
let API_KEY = process.env.M2M_SENTINEL_API_KEY || '';
const TIMEOUT_MS = Number(process.env.M2M_SENTINEL_TIMEOUT_MS || 30000);
const VERSION = '1.2.2';

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

function queryApi(path, customApiKey = null, customBaseUrl = null) {
  const activeBaseUrl = customBaseUrl || BASE_URL;
  const activeApiKey = customApiKey !== null ? customApiKey : API_KEY;

  return new Promise((resolve, reject) => {
    const url = new URL(path, activeBaseUrl);
    const isHttps = url.protocol === 'https:';
    const transport = isHttps ? https : http;
    const headers = { Accept: 'application/json', 'User-Agent': `M2MSentinel-CLI/${VERSION}` };
    if (activeApiKey) headers['x-api-key'] = activeApiKey;

    const start = Date.now();
    const req = transport.request(url, { method: 'GET', headers, timeout: TIMEOUT_MS }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        const latencyMs = Date.now() - start;
        let body = null;
        if (data) {
          try { body = JSON.parse(data); } catch (_) { body = { raw: data }; }
        }
        resolve({
          status: res.statusCode,
          ok: res.statusCode >= 200 && res.statusCode < 300,
          body,
          latencyMs,
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

// ---------------------------------------------------------------------------
// Model Context Protocol (MCP) JSON-RPC Handlers
// ---------------------------------------------------------------------------

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

async function handleMcpMessage(request) {
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
        serverInfo: { name: 'm2m-sentinel-mcp', version: VERSION }
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

function startMcpServer() {
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
    handleMcpMessage(request);
  });
}

// ---------------------------------------------------------------------------
// Interactive Human Developer CLI
// ---------------------------------------------------------------------------

function printHelp() {
  console.log(`
================================================================
🛡️  M2M SENTINEL CLI — Base Bytecode & Preflight Intelligence
Version: ${VERSION} | Gateway: ${BASE_URL}
================================================================

USAGE:
  npx @m2msentinel/sdk <command> [arguments] [flags]
  npx m2m-sentinel <command> [arguments] [flags]

COMMANDS:
  audit <address>        Disassemble bytecode, detect capabilities & resolve proxies
  gas                    Fetch real-time Base Mainnet gas metrics & advice
  price <symbol>         Fetch DEX liquidity-weighted token price (USDC, WETH, AERO)
  dex [pair]             Fetch tracked Base liquidity pool metrics
  whales [limit]         Fetch large ERC-20 transfer signals on Base
  status                 Check live API, RPC quorum, and persistence health
  mcp                    Launch Model Context Protocol stdio JSON-RPC server

FLAGS:
  --json                 Output raw JSON (ideal for scripts & jq)
  --api-key <key>        Authenticate with a paid or custom API key
  --base-url <url>       Override gateway endpoint (default: https://api.m2msentinel.com)
  --help, -h             Display this help manual
  --version, -v          Show installed CLI version

EXAMPLES:
  # Inspect Base USDC proxy implementation and capabilities:
  npx @m2msentinel/sdk audit 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913

  # Shorthand audit with direct address:
  npx @m2msentinel/sdk 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913

  # Check Base gas fees as structured JSON:
  npx @m2msentinel/sdk gas --json

  # Connect to Claude Desktop / Cursor via MCP:
  npx @m2msentinel/sdk mcp

Documentation: https://m2msentinel.com/docs.html
================================================================
`);
}

async function runCli(args) {
  let isJson = false;
  let customApiKey = null;
  let customBaseUrl = null;
  const positional = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') {
      isJson = true;
    } else if (arg === '--api-key' && args[i + 1]) {
      customApiKey = args[++i];
    } else if (arg === '--base-url' && args[i + 1]) {
      customBaseUrl = args[++i];
    } else if (arg === '--help' || arg === '-h' || arg === 'help') {
      printHelp();
      return 0;
    } else if (arg === '--version' || arg === '-v' || arg === 'version') {
      console.log(`@m2msentinel/sdk v${VERSION}`);
      return 0;
    } else {
      positional.push(arg);
    }
  }

  const cmd = positional[0] || 'help';

  // Handle explicit 'mcp' command
  if (cmd === 'mcp') {
    startMcpServer();
    return 0;
  }

  // Handle address shorthand: npx @m2msentinel/sdk 0x8335...
  let targetPath = null;
  let commandName = cmd;

  if (/^0x[a-fA-F0-9]{40}$/.test(cmd)) {
    targetPath = `/v1/audit/${cmd}`;
    commandName = 'audit';
  } else if (cmd === 'audit') {
    const addr = positional[1];
    if (!addr || !/^0x[a-fA-F0-9]{40}$/.test(addr)) {
      console.error('❌ Error: A valid 40-hex Base contract address (0x...) is required.');
      console.error('Usage: npx @m2msentinel/sdk audit 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913\n');
      return 1;
    }
    targetPath = `/v1/audit/${addr}`;
  } else if (cmd === 'gas' || cmd === 'fees') {
    targetPath = '/v1/gas/fees';
  } else if (cmd === 'price') {
    const symbol = (positional[1] || 'USDC').toUpperCase();
    targetPath = `/v1/token/price/${encodeURIComponent(symbol)}`;
  } else if (cmd === 'dex') {
    targetPath = '/v1/dex/metrics';
  } else if (cmd === 'whales') {
    targetPath = '/v1/whales/signals';
  } else if (cmd === 'status') {
    targetPath = '/v1/status';
  } else {
    printHelp();
    return 0;
  }

  try {
    let res = await queryApi(targetPath, customApiKey, customBaseUrl);

    // If unauthenticated / 401 / 402 on audit, try public demo endpoint
    if (!res.ok && commandName === 'audit' && (res.status === 401 || res.status === 402)) {
      const targetAddr = positional[1] || cmd;
      const demoTarget = `/v1/demo/audit/${encodeURIComponent(targetAddr)}`;
      const demoRes = await queryApi(demoTarget, null, customBaseUrl);
      if (demoRes.ok) {
        res = demoRes;
      }
    }

    if (isJson) {
      console.log(JSON.stringify(res.body, null, 2));
      return res.ok ? 0 : 1;
    }

    if (!res.ok) {
      console.error(`\n❌ Request failed with HTTP ${res.status}`);
      if (res.body && res.body.message) {
        console.error(`Reason: ${res.body.message}`);
      }
      if (res.status === 402 || res.status === 401) {
        console.error('💡 This endpoint requires an API key or autonomous x402 payment.');
        console.error('Pass a key via --api-key <key> or set M2M_SENTINEL_API_KEY.\n');
      }
      return 1;
    }

    const data = res.body;

    if (commandName === 'audit') {
      const auditObj = data.audit || data;
      const targetAddress = auditObj.address || auditObj.contractAddress || data.contractAddress || positional[1] || cmd;
      console.log('================================================================');
      console.log('🛡️  M2M SENTINEL — BASE SMART CONTRACT AUDIT');
      console.log(`Target Address:  ${targetAddress}`);
      console.log(`Network:         Base Mainnet (8453)`);
      console.log(`Latency:         ${res.latencyMs}ms`);
      console.log('================================================================');

      const proxy = auditObj.proxyResolution || auditObj.proxy || {};
      const isProxy = !!proxy.isProxy;
      if (isProxy) {
        const impl = proxy.targetAddress || proxy.implementation || (auditObj.reproducibility && auditObj.reproducibility.implementationAddress) || 'Uninstantiated (0x0)';
        console.log(`• Proxy Standard:    ${proxy.proxyType || (data.sample && data.sample.category) || 'EIP-1967 Proxy'}`);
        console.log(`• Implementation:    ${impl}`);
        if (proxy.admin) console.log(`• Admin Address:     ${proxy.admin}`);
      } else {
        console.log(`• Contract Architecture: Direct Implementation (Non-Proxy)`);
      }

      const caps = (auditObj.dissection && auditObj.dissection.capabilities) || auditObj.observedCapabilities || auditObj.capabilities || [];
      if (Array.isArray(caps) && caps.length > 0) {
        const capNames = caps.map(c => typeof c === 'string' ? c : (c.type || c.name || c.id || c.capability));
        console.log(`• Capabilities:      ${capNames.filter(Boolean).join(', ')}`);
      }

      const score = auditObj.capabilityScore !== undefined ? auditObj.capabilityScore : data.score;
      if (score !== undefined) {
        console.log(`• Capability Score:  ${score}/100 (Coverage Index)`);
      }

      const trust = (auditObj.provenance && auditObj.provenance.trustLevel) || auditObj.trustLevel || 'HIGH';
      console.log(`• Upstream Trust:    ${trust}`);
      console.log('----------------------------------------------------------------');
      console.log('Notice: Factual static capability observation. Not a safety guarantee.');
      console.log('💡 Tip: Claim your free API key & track usage at https://m2msentinel.com');
      console.log('================================================================\n');

    } else if (commandName === 'gas' || commandName === 'fees') {
      console.log('================================================================');
      console.log('⛽ M2M SENTINEL — BASE GAS METRICS');
      console.log(`Network: Base Mainnet (8453) | Sourced Latency: ${res.latencyMs}ms`);
      console.log('================================================================');
      console.log(`• Standard Gas Price: ${data.standard || data.gasPriceGwei || '0.005'} gwei`);
      if (data.fast) console.log(`• Fast Gas Price:     ${data.fast} gwei`);
      if (data.instant) console.log(`• Instant Gas Price:  ${data.instant} gwei`);
      if (data.recommendation) console.log(`• Execution Advice:   ${data.recommendation}`);
      console.log('================================================================\n');

    } else if (commandName === 'price') {
      console.log('================================================================');
      console.log(`📈 M2M SENTINEL — BASE DEX TOKEN PRICE`);
      console.log(`Asset: ${data.symbol || positional[1]} | Latency: ${res.latencyMs}ms`);
      console.log('================================================================');
      console.log(`• Price (USD):        $${data.priceUsd || data.price || 'N/A'}`);
      if (data.tokenAddress) console.log(`• Contract Address:   ${data.tokenAddress}`);
      if (data.decimals) console.log(`• Decimals:           ${data.decimals}`);
      if (data.source) console.log(`• Sourced Pool:       ${data.source}`);
      console.log('================================================================\n');

    } else if (commandName === 'status') {
      console.log('================================================================');
      console.log('🟢 M2M SENTINEL — OPERATIONAL STATUS');
      console.log(`Status: ${data.status} | Network: Base Mainnet (8453)`);
      console.log('================================================================');
      if (data.components) {
        for (const [comp, detail] of Object.entries(data.components)) {
          console.log(`• ${comp.padEnd(20)}: ${detail.status} (${detail.mode || detail.activeProvider || 'OK'})`);
        }
      }
      if (data.availability && data.availability.windows) {
        console.log('----------------------------------------------------------------');
        console.log('Availability Windows (Measured Uptime):');
        for (const [w, win] of Object.entries(data.availability.windows)) {
          console.log(`  ${w.padEnd(6)}: ${win.availabilityPercent}% (${win.sampleCount} samples)`);
        }
      }
      console.log('================================================================\n');

    } else {
      console.log(JSON.stringify(data, null, 2));
    }

    return 0;
  } catch (err) {
    console.error('❌ Request error:', err.message);
    return 1;
  }
}

// ---------------------------------------------------------------------------
// Entrypoint: Dual Mode Selection
// ---------------------------------------------------------------------------

const cliArgs = process.argv.slice(2);

// If arguments are passed or run in an interactive terminal, invoke CLI
if (cliArgs.length > 0 || (process.stdin.isTTY && !process.env.M2M_MCP_FORCE)) {
  if (cliArgs.length === 0) {
    printHelp();
  } else {
    runCli(cliArgs).then((code) => {
      if (code !== 0 && typeof code === 'number') process.exit(code);
    });
  }
} else {
  // Piped execution without args -> start MCP stdio server
  startMcpServer();
}

module.exports = { TOOLS, pathForTool, parseX402Header, runCli, queryApi };
