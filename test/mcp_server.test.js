'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const {
  TOOLS,
  TOOL_ALIASES,
  SERVER_INSTRUCTIONS,
  pathForTool,
  handleMcpMessage
} = require('../mcp_server.js');

const VALID_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

// Helper to execute handleMcpMessage and capture response cleanly
function callMcp(request) {
  return new Promise((resolve) => {
    handleMcpMessage(request, (response) => {
      resolve(response);
    });
  });
}

describe('M2M Sentinel MCP Server Glama TDQS Remediation Tests', () => {

  describe('1. Canonical Tools Catalog and Naming Consistency', () => {
    it('exposes exactly six tools with unique canonical m2m_ names in tools/list', async () => {
      const response = await callMcp({
        jsonrpc: '2.0',
        id: 101,
        method: 'tools/list'
      });

      assert.strictEqual(response.jsonrpc, '2.0');
      assert.strictEqual(response.id, 101);
      assert(response.result && Array.isArray(response.result.tools));

      const tools = response.result.tools;
      assert.strictEqual(tools.length, 6, 'tools/list must expose exactly 6 tools');

      const expectedNames = [
        'm2m_audit_contract',
        'm2m_get_gas_metrics',
        'm2m_get_token_price',
        'm2m_get_dex_liquidity',
        'm2m_get_whale_signals',
        'm2m_get_service_status'
      ];

      const actualNames = tools.map((t) => t.name);
      assert.deepStrictEqual(actualNames, expectedNames);

      const uniqueNames = new Set(actualNames);
      assert.strictEqual(uniqueNames.size, 6, 'All tool names must be unique');

      for (const name of actualNames) {
        assert(name.startsWith('m2m_'), `Tool name "${name}" must use canonical m2m_ prefix`);
      }
    });

    it('does not expose any legacy aliases in tools/list', async () => {
      const response = await callMcp({
        jsonrpc: '2.0',
        id: 102,
        method: 'tools/list'
      });

      const exposedNames = response.result.tools.map((t) => t.name);
      const legacyNames = [
        'audit_contract',
        'get_capability_score',
        'get_gas_fees',
        'get_dex_metrics',
        'get_token_price',
        'get_whale_signals'
      ];

      for (const legacy of legacyNames) {
        assert(!exposedNames.includes(legacy), `Legacy alias "${legacy}" must not appear in tools/list`);
      }
    });
  });

  describe('2. Legacy Alias Routing and Backwards Compatibility', () => {
    it('TOOL_ALIASES maps legacy names to canonical counterparts', () => {
      assert(typeof TOOL_ALIASES === 'object' && TOOL_ALIASES !== null);
      assert.strictEqual(TOOL_ALIASES.audit_contract, 'm2m_audit_contract');
      assert.strictEqual(TOOL_ALIASES.get_capability_score, 'm2m_audit_contract');
      assert.strictEqual(TOOL_ALIASES.get_gas_fees, 'm2m_get_gas_metrics');
      assert.strictEqual(TOOL_ALIASES.get_dex_metrics, 'm2m_get_dex_liquidity');
      assert.strictEqual(TOOL_ALIASES.get_token_price, 'm2m_get_token_price');
      assert.strictEqual(TOOL_ALIASES.get_whale_signals, 'm2m_get_whale_signals');
    });

    it('pathForTool resolves canonical routes correctly', () => {
      assert.strictEqual(
        pathForTool('m2m_audit_contract', { address: VALID_ADDRESS }),
        `/v1/audit/${VALID_ADDRESS}`
      );
      assert.strictEqual(pathForTool('m2m_get_gas_metrics'), '/v1/gas/fees');
      assert.strictEqual(pathForTool('m2m_get_token_price', { symbol: 'USDC' }), '/v1/token/price/USDC');
      assert.strictEqual(pathForTool('m2m_get_token_price', { symbol: 'weth' }), '/v1/token/price/WETH');
      assert.strictEqual(pathForTool('m2m_get_dex_liquidity'), '/v1/dex/metrics');
      assert.strictEqual(
        pathForTool('m2m_get_dex_liquidity', { pair: 'WETH-USDC' }),
        '/v1/dex/metrics'
      );
      assert.strictEqual(pathForTool('m2m_get_whale_signals'), '/v1/whales/signals');
      assert.strictEqual(
        pathForTool('m2m_get_whale_signals', { limit: 25 }),
        '/v1/whales/signals'
      );
      assert.strictEqual(pathForTool('m2m_get_service_status'), '/v1/status');
    });

    it('pathForTool preserves resolution for legacy alias names and tolerates extra args', () => {
      assert.strictEqual(
        pathForTool('audit_contract', { address: VALID_ADDRESS }),
        `/v1/audit/${VALID_ADDRESS}`
      );
      assert.strictEqual(
        pathForTool('get_capability_score', { address: VALID_ADDRESS }),
        `/v1/security/score/${VALID_ADDRESS}`
      );
      assert.strictEqual(pathForTool('get_gas_fees'), '/v1/gas/fees');
      assert.strictEqual(pathForTool('get_dex_metrics'), '/v1/dex/metrics');
      assert.strictEqual(
        pathForTool('get_dex_metrics', { pair: 'AERO-USDC' }),
        '/v1/dex/metrics'
      );
      assert.strictEqual(pathForTool('get_token_price', { symbol: 'AERO' }), '/v1/token/price/AERO');
      assert.strictEqual(pathForTool('get_whale_signals'), '/v1/whales/signals');
      assert.strictEqual(
        pathForTool('get_whale_signals', { limit: 10 }),
        '/v1/whales/signals'
      );
    });

    it('tolerates arbitrary extra parameters without throwing and does not forward query strings', () => {
      assert.strictEqual(
        pathForTool('m2m_get_dex_liquidity', { pair: 'WETH-USDC', extra: 'ignored' }),
        '/v1/dex/metrics'
      );
      assert.strictEqual(
        pathForTool('m2m_get_whale_signals', { limit: 50, window: '24h' }),
        '/v1/whales/signals'
      );
      assert.strictEqual(
        pathForTool('get_dex_metrics', { pair: 'WETH-USDC', extra: 1 }),
        '/v1/dex/metrics'
      );
      assert.strictEqual(
        pathForTool('get_whale_signals', { limit: 999 }),
        '/v1/whales/signals'
      );
    });

    it('asserts legacy name get_capability_score still dispatches locally without any network call', () => {
      const targetPath = pathForTool('get_capability_score', { address: VALID_ADDRESS });
      assert.strictEqual(targetPath, `/v1/security/score/${VALID_ADDRESS}`);
    });

    it('pathForTool throws descriptive error on unknown tool name', () => {
      assert.throws(
        () => pathForTool('unknown_custom_tool', {}),
        /Unknown tool: unknown_custom_tool/
      );
    });
  });

  describe('3. Initialize Handshake, Instructions, and Capabilities', () => {
    it('returns serverInfo, tool capability, and truthful instructions', async () => {
      const response = await callMcp({
        jsonrpc: '2.0',
        id: 103,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05' }
      });

      assert.strictEqual(response.jsonrpc, '2.0');
      assert.strictEqual(response.id, 103);
      assert(response.result);

      const res = response.result;
      assert.strictEqual(res.serverInfo.name, 'm2m-sentinel-mcp');
      assert.strictEqual(res.serverInfo.version, '1.2.7');
      assert.deepStrictEqual(res.capabilities, { tools: {} });

      assert(typeof res.instructions === 'string' && res.instructions.length > 50);

      // Verify key requirements in instructions
      assert(res.instructions.includes('Base Mainnet (chainId 8453)'), 'Must define Base network scope');
      assert(res.instructions.includes('canonical'), 'Must state m2m_* tool names are canonical');
      assert(res.instructions.includes('m2m_audit_contract'), 'Must list canonical tools');
      assert(res.instructions.includes('m2m_get_service_status'), 'Must list canonical tools');
      assert(res.instructions.includes('not advertised'), 'Must state legacy names are not advertised in tools/list');
      assert(res.instructions.includes('compatibility-callable'), 'Must state legacy names remain compatibility-callable');
      assert(res.instructions.includes('read-only'), 'Must state operations are factual/read-only');
      assert(res.instructions.includes('not safety'), 'Must state results are not safety or exploitability guarantees');
      assert(res.instructions.includes('exploitability guarantees'), 'Must state results are not safety or exploitability guarantees');
      assert(res.instructions.includes('M2M_SENTINEL_API_KEY'), 'Must document API-key configuration');
      assert(res.instructions.includes('401, 402, 429, or 503'), 'Must document protected-call error behavior');
      assert(res.instructions.includes('does not sign payments'), 'Must disclose that the stdio wrapper does not sign x402 payments');

      // Verify no unproven claims
      assert(!res.instructions.includes('higher rate limits'), 'Must not claim unproven rate limit tiers');
      assert(!res.instructions.includes('real-time'), 'Must not claim unproven real-time freshness');
    });
  });

  describe('4. Tool Annotations and Schema Integrity', () => {
    it('provides standard conservative annotations on all six canonical tools', () => {
      for (const tool of TOOLS) {
        assert(tool.annotations, `Tool ${tool.name} must have annotations`);
        assert.strictEqual(tool.annotations.readOnlyHint, true, `${tool.name} must be readOnlyHint: true`);
        assert.strictEqual(tool.annotations.destructiveHint, false, `${tool.name} must be destructiveHint: false`);
        assert.strictEqual(tool.annotations.openWorldHint, true, `${tool.name} must be openWorldHint: true`);
        assert(typeof tool.annotations.idempotentHint === 'boolean', `${tool.name} must define idempotentHint`);
      }

      // All six operations are read-only queries with no repeated-call side effect.
      for (const tool of TOOLS) {
        assert.strictEqual(tool.annotations.idempotentHint, true, `${tool.name} is idempotent`);
      }
    });

    it('retains valid input schemas and does not invent output schemas', () => {
      for (const tool of TOOLS) {
        assert.strictEqual(tool.inputSchema.type, 'object');
        assert(typeof tool.description === 'string' && tool.description.length > 20);
        assert.strictEqual(tool.outputSchema, undefined, `${tool.name} must not invent unevidenced outputSchema`);
      }

      const auditTool = TOOLS.find((t) => t.name === 'm2m_audit_contract');
      assert.deepStrictEqual(auditTool.inputSchema.required, ['address']);
      assert(auditTool.inputSchema.properties.address.description.includes('Base contract address'));

      const priceTool = TOOLS.find((t) => t.name === 'm2m_get_token_price');
      assert.deepStrictEqual(priceTool.inputSchema.required, ['symbol']);
      assert(priceTool.inputSchema.properties.symbol.description.includes('token symbol'));

      const dexTool = TOOLS.find((t) => t.name === 'm2m_get_dex_liquidity');
      assert.strictEqual(dexTool.inputSchema.properties.pair, undefined, 'm2m_get_dex_liquidity must not advertise pair property');
      assert.strictEqual(Object.keys(dexTool.inputSchema.properties).length, 0, 'm2m_get_dex_liquidity properties must be empty');
      assert(!dexTool.description.includes('single-pair filtering'), 'm2m_get_dex_liquidity must not advertise single-pair filtering');
      assert(dexTool.description.includes('aggregate'), 'm2m_get_dex_liquidity must describe aggregate pool metrics');

      const whaleTool = TOOLS.find((t) => t.name === 'm2m_get_whale_signals');
      assert.strictEqual(whaleTool.inputSchema.properties.limit, undefined, 'm2m_get_whale_signals must not advertise limit property');
      assert.strictEqual(Object.keys(whaleTool.inputSchema.properties).length, 0, 'm2m_get_whale_signals properties must be empty');
      assert(!whaleTool.description.includes('default 10'), 'm2m_get_whale_signals must not advertise limit options');
      assert(whaleTool.description.includes('up to 50'), 'm2m_get_whale_signals must accurately describe up to 50 signals');
    });
  });

  describe('5. Fail-Closed Address Validation', () => {
    it('rejects missing or empty address in pathForTool', () => {
      assert.throws(
        () => pathForTool('m2m_audit_contract', {}),
        /address is required/
      );
      assert.throws(
        () => pathForTool('m2m_audit_contract', { address: '' }),
        /address is required/
      );
      assert.throws(
        () => pathForTool('audit_contract', {}),
        /address is required/
      );
      assert.throws(
        () => pathForTool('get_capability_score', {}),
        /address is required/
      );
    });

    it('rejects non-hex or malformed addresses fail-closed in pathForTool', () => {
      const invalidAddresses = [
        'not-an-address',
        '0x123',
        '0xZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ',
        '833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // missing 0x prefix
        '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913ExtraChars'
      ];

      for (const addr of invalidAddresses) {
        assert.throws(
          () => pathForTool('m2m_audit_contract', { address: addr }),
          /A valid 40-hex 0x-prefixed Base contract address is required/,
          `Expected fail-closed error for invalid address: "${addr}"`
        );
        assert.throws(
          () => pathForTool('audit_contract', { address: addr }),
          /A valid 40-hex 0x-prefixed Base contract address is required/,
          `Expected fail-closed error on legacy alias for invalid address: "${addr}"`
        );
        assert.throws(
          () => pathForTool('get_capability_score', { address: addr }),
          /A valid 40-hex 0x-prefixed Base contract address is required/,
          `Expected fail-closed error on score alias for invalid address: "${addr}"`
        );
      }
    });

    it('returns JSON-RPC error on tools/call with invalid address without network dispatch', async () => {
      const response = await callMcp({
        jsonrpc: '2.0',
        id: 105,
        method: 'tools/call',
        params: {
          name: 'm2m_audit_contract',
          arguments: { address: '0xinvalid_address_format' }
        }
      });

      assert.strictEqual(response.jsonrpc, '2.0');
      assert.strictEqual(response.id, 105);
      assert(response.error);
      assert.strictEqual(response.error.code, -32603);
      assert(response.error.message.includes('A valid 40-hex 0x-prefixed Base contract address is required'));
    });
  });

  describe('6. Hermetic Tool Execution via Local Fake HTTP Server', () => {
    let fakeServer;
    let fakeServerUrl;
    let originalBaseUrl;
    const requestedPaths = [];

    before((t, done) => {
      originalBaseUrl = process.env.M2M_SENTINEL_BASE_URL;

      fakeServer = http.createServer((req, res) => {
        requestedPaths.push(req.url);

        if (req.url === `/v1/audit/${VALID_ADDRESS}`) {
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Payment-Response': JSON.stringify({ settled: true })
          });
          res.end(JSON.stringify({
            audit: {
              address: VALID_ADDRESS,
              isProxy: false,
              capabilityScore: 92,
              capabilities: ['MINT', 'BURN']
            }
          }));
          return;
        }

        if (req.url === `/v1/security/score/${VALID_ADDRESS}`) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            address: VALID_ADDRESS,
            score: 92,
            provenance: { trustLevel: 'HIGH' }
          }));
          return;
        }

        if (req.url === '/v1/gas/fees') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            standard: '0.005',
            fast: '0.008',
            instant: '0.012',
            recommendation: 'EXECUTE_IMMEDIATELY'
          }));
          return;
        }

        if (req.url === '/v1/token/price/USDC') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            symbol: 'USDC',
            priceUsd: '1.0002',
            decimals: 6,
            source: 'Aerodrome Slipstream'
          }));
          return;
        }

        if (req.url === '/v1/dex/metrics') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            totalReserveUsd: '150000000',
            trackedPools: 42,
            volume24hUsd: '85000000'
          }));
          return;
        }

        if (req.url === '/v1/whales/signals') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            signals: [
              { txHash: '0x123abc', amountUsd: '250000', asset: 'USDC' }
            ]
          }));
          return;
        }

        if (req.url === '/v1/status') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            status: 'HEALTHY',
            components: { rpc: { status: 'OK' } }
          }));
          return;
        }

        if (req.url === '/v1/audit/0x1111111111111111111111111111111111111111') {
          // Simulate 402 Payment Required
          res.writeHead(402, {
            'Content-Type': 'application/json',
            'Payment-Required': JSON.stringify({
              x402Version: 2,
              price: '$0.005',
              payTo: '0x6d6c398390cfb88f1cd42715b84906a0bd6652aa'
            })
          });
          res.end(JSON.stringify({ error: 'PAYMENT_REQUIRED', message: 'Micropayment needed' }));
          return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'NOT_FOUND' }));
      });

      fakeServer.listen(0, '127.0.0.1', () => {
        const port = fakeServer.address().port;
        fakeServerUrl = `http://127.0.0.1:${port}`;
        process.env.M2M_SENTINEL_BASE_URL = fakeServerUrl;
        done();
      });
    });

    after((t, done) => {
      if (originalBaseUrl !== undefined) {
        process.env.M2M_SENTINEL_BASE_URL = originalBaseUrl;
      } else {
        delete process.env.M2M_SENTINEL_BASE_URL;
      }
      fakeServer.close(done);
    });

    it('exercises m2m_audit_contract against fake server without live endpoints', async () => {
      const response = await callMcp({
        jsonrpc: '2.0',
        id: 201,
        method: 'tools/call',
        params: {
          name: 'm2m_audit_contract',
          arguments: { address: VALID_ADDRESS }
        }
      });

      assert.strictEqual(response.jsonrpc, '2.0');
      assert.strictEqual(response.id, 201);
      assert(response.result);
      assert.strictEqual(response.result.isError, false);
      assert(Array.isArray(response.result.content));
      assert.strictEqual(response.result.content[0].type, 'text');

      const parsed = JSON.parse(response.result.content[0].text);
      assert.strictEqual(parsed.audit.address, VALID_ADDRESS);
      assert.strictEqual(parsed.audit.capabilityScore, 92);
      assert.strictEqual(response.result._meta.notASafetyGuarantee, true);
      assert(requestedPaths.includes(`/v1/audit/${VALID_ADDRESS}`));
    });

    it('exercises legacy alias audit_contract against fake server', async () => {
      const response = await callMcp({
        jsonrpc: '2.0',
        id: 202,
        method: 'tools/call',
        params: {
          name: 'audit_contract',
          arguments: { address: VALID_ADDRESS }
        }
      });

      assert.strictEqual(response.result.isError, false);
      const parsed = JSON.parse(response.result.content[0].text);
      assert.strictEqual(parsed.audit.address, VALID_ADDRESS);
    });

    it('exercises legacy alias get_capability_score against fake server', async () => {
      const response = await callMcp({
        jsonrpc: '2.0',
        id: 203,
        method: 'tools/call',
        params: {
          name: 'get_capability_score',
          arguments: { address: VALID_ADDRESS }
        }
      });

      assert.strictEqual(response.result.isError, false);
      assert(requestedPaths.includes(`/v1/security/score/${VALID_ADDRESS}`));
    });

    it('exercises m2m_get_gas_metrics against fake server', async () => {
      const response = await callMcp({
        jsonrpc: '2.0',
        id: 204,
        method: 'tools/call',
        params: {
          name: 'm2m_get_gas_metrics'
        }
      });

      assert.strictEqual(response.result.isError, false);
      assert(requestedPaths.includes('/v1/gas/fees'));
      assert.strictEqual(response.result.structuredContent.standard, '0.005');
    });

    it('exercises m2m_get_dex_liquidity with ignored pair argument against fake server without query forwarding', async () => {
      const response = await callMcp({
        jsonrpc: '2.0',
        id: 205,
        method: 'tools/call',
        params: {
          name: 'm2m_get_dex_liquidity',
          arguments: { pair: 'WETH-USDC' }
        }
      });

      assert.strictEqual(response.result.isError, false);
      assert(requestedPaths.includes('/v1/dex/metrics'), 'Must request /v1/dex/metrics without query string');
      assert(!requestedPaths.some((p) => p.includes('pair=')), 'Must not forward pair query parameter');
      assert.strictEqual(response.result.structuredContent.trackedPools, 42);
    });

    it('exercises m2m_get_whale_signals with ignored limit argument against fake server without query forwarding', async () => {
      const response = await callMcp({
        jsonrpc: '2.0',
        id: 206,
        method: 'tools/call',
        params: {
          name: 'm2m_get_whale_signals',
          arguments: { limit: 5 }
        }
      });

      assert.strictEqual(response.result.isError, false);
      assert(requestedPaths.includes('/v1/whales/signals'), 'Must request /v1/whales/signals without query string');
      assert(!requestedPaths.some((p) => p.includes('limit=')), 'Must not forward limit query parameter');
      assert.strictEqual(response.result.structuredContent.signals[0].txHash, '0x123abc');
    });

    it('surfaces HTTP 402 payment required with headers and isError flag', async () => {
      const payAddr = '0x1111111111111111111111111111111111111111';
      const response = await callMcp({
        jsonrpc: '2.0',
        id: 207,
        method: 'tools/call',
        params: {
          name: 'm2m_audit_contract',
          arguments: { address: payAddr }
        }
      });

      assert.strictEqual(response.result.isError, true);
      assert.strictEqual(response.result._meta.httpStatus, 402);
      assert(response.result._meta.paymentRequired);
      assert.strictEqual(response.result._meta.paymentRequired.price, '$0.005');
      assert.strictEqual(response.result._meta.notASafetyGuarantee, true);
    });
  });

  describe('7. Exact Parity Across Runtime, Server-Card, and server.json', () => {
    const fs = require('node:fs');
    const path = require('node:path');

    const serverCardPath = path.resolve(__dirname, '../.well-known/mcp/server-card.json');
    const serverJsonPath = path.resolve(__dirname, '../server.json');
    const fixtureSchemaPath = path.resolve(__dirname, 'fixtures/server.schema.json');

    it('ensures server-card.json and server.json exist and parse as valid JSON', () => {
      assert(fs.existsSync(serverCardPath), 'server-card.json must exist');
      assert(fs.existsSync(serverJsonPath), 'server.json must exist');

      const serverCard = JSON.parse(fs.readFileSync(serverCardPath, 'utf8'));
      const serverJson = JSON.parse(fs.readFileSync(serverJsonPath, 'utf8'));

      assert(Array.isArray(serverCard.tools), 'server-card.json must contain tools array');
      assert(Array.isArray(serverJson.tools), 'server.json must contain tools array');
    });

    it('verifies exact tool count and canonical naming across runtime, server-card, and server.json', () => {
      const serverCard = JSON.parse(fs.readFileSync(serverCardPath, 'utf8'));
      const serverJson = JSON.parse(fs.readFileSync(serverJsonPath, 'utf8'));

      assert.strictEqual(TOOLS.length, 6);
      assert.strictEqual(serverCard.tools.length, 6);
      assert.strictEqual(serverJson.tools.length, 6);

      const expectedNames = [
        'm2m_audit_contract',
        'm2m_get_gas_metrics',
        'm2m_get_token_price',
        'm2m_get_dex_liquidity',
        'm2m_get_whale_signals',
        'm2m_get_service_status'
      ];

      assert.deepStrictEqual(TOOLS.map((t) => t.name), expectedNames);
      assert.deepStrictEqual(serverCard.tools.map((t) => t.name), expectedNames);
      assert.deepStrictEqual(serverJson.tools.map((t) => t.name), expectedNames);
    });

    it('maintains exact deep equality across all tool definitions in runtime, server-card, and server.json', () => {
      const serverCard = JSON.parse(fs.readFileSync(serverCardPath, 'utf8'));
      const serverJson = JSON.parse(fs.readFileSync(serverJsonPath, 'utf8'));

      assert.deepStrictEqual(
        serverCard.tools,
        TOOLS,
        'server-card.json tools must exactly match runtime TOOLS'
      );
      assert.deepStrictEqual(
        serverJson.tools,
        TOOLS,
        'server.json tools must exactly match runtime TOOLS'
      );
      assert.deepStrictEqual(
        serverJson.tools,
        serverCard.tools,
        'server.json tools must exactly match server-card.json tools'
      );
    });

    it('confirms pair and limit parameters are not advertised across any public schema', () => {
      const manifests = [
        { name: 'runtime TOOLS', tools: TOOLS },
        { name: 'server-card.json', tools: JSON.parse(fs.readFileSync(serverCardPath, 'utf8')).tools },
        { name: 'server.json', tools: JSON.parse(fs.readFileSync(serverJsonPath, 'utf8')).tools }
      ];

      for (const manifest of manifests) {
        const dex = manifest.tools.find((t) => t.name === 'm2m_get_dex_liquidity');
        assert(dex, `m2m_get_dex_liquidity must exist in ${manifest.name}`);
        assert.strictEqual(dex.inputSchema.properties.pair, undefined, `pair must not be in ${manifest.name} dex inputSchema`);
        assert.strictEqual(Object.keys(dex.inputSchema.properties).length, 0, `dex inputSchema properties must be empty in ${manifest.name}`);
        assert(!dex.description.includes('single-pair filtering'), `dex description must not claim pair filtering in ${manifest.name}`);

        const whales = manifest.tools.find((t) => t.name === 'm2m_get_whale_signals');
        assert(whales, `m2m_get_whale_signals must exist in ${manifest.name}`);
        assert.strictEqual(whales.inputSchema.properties.limit, undefined, `limit must not be in ${manifest.name} whale inputSchema`);
        assert.strictEqual(Object.keys(whales.inputSchema.properties).length, 0, `whale inputSchema properties must be empty in ${manifest.name}`);
        assert(!whales.description.includes('default 10'), `whale description must not claim limit options in ${manifest.name}`);
      }
    });

    it('validates server.json against official server schema without contacting production', () => {
      const serverJson = JSON.parse(fs.readFileSync(serverJsonPath, 'utf8'));
      assert(fs.existsSync(fixtureSchemaPath), 'Local fixture schema must exist');
      const schema = JSON.parse(fs.readFileSync(fixtureSchemaPath, 'utf8'));

      const detailDef = schema.definitions.ServerDetail;
      assert(detailDef, 'Schema must define ServerDetail');

      // 1. Verify required properties
      for (const requiredProp of detailDef.required) {
        assert(
          serverJson[requiredProp] !== undefined,
          `server.json must satisfy required property: ${requiredProp}`
        );
      }

      // 2. Verify property types & constraints from official schema
      assert.strictEqual(typeof serverJson.name, 'string');
      assert(
        new RegExp(detailDef.properties.name.pattern).test(serverJson.name),
        'server.json name must match ServerDetail regex pattern'
      );
      assert.strictEqual(typeof serverJson.description, 'string');
      assert(serverJson.description.length <= detailDef.properties.description.maxLength);
      assert.strictEqual(typeof serverJson.version, 'string');
      assert.strictEqual(serverJson.version, '1.2.7');

      if (serverJson.repository) {
        assert.strictEqual(typeof serverJson.repository.url, 'string');
        assert.strictEqual(serverJson.repository.source, 'github');
      }

      if (serverJson.packages) {
        assert(Array.isArray(serverJson.packages));
        for (const pkg of serverJson.packages) {
          assert.strictEqual(pkg.registryType, 'npm');
          assert.strictEqual(typeof pkg.identifier, 'string');
        }
      }

      if (serverJson.remotes) {
        assert(Array.isArray(serverJson.remotes));
        for (const rem of serverJson.remotes) {
          assert(['streamable-http', 'sse'].includes(rem.type));
          assert(rem.url.startsWith('https://'));
        }
      }

      // The structural checks above intentionally use only repository-local data
      // so this clean-room test has no dependency on another checkout or cache.
    });
  });
});
