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
        '/v1/dex/metrics?pair=WETH-USDC'
      );
      assert.strictEqual(pathForTool('m2m_get_whale_signals'), '/v1/whales/signals');
      assert.strictEqual(
        pathForTool('m2m_get_whale_signals', { limit: 25 }),
        '/v1/whales/signals?limit=25'
      );
      assert.strictEqual(pathForTool('m2m_get_service_status'), '/v1/status');
    });

    it('pathForTool preserves resolution for legacy alias names', () => {
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
        '/v1/dex/metrics?pair=AERO-USDC'
      );
      assert.strictEqual(pathForTool('get_token_price', { symbol: 'AERO' }), '/v1/token/price/AERO');
      assert.strictEqual(pathForTool('get_whale_signals'), '/v1/whales/signals');
      assert.strictEqual(
        pathForTool('get_whale_signals', { limit: 10 }),
        '/v1/whales/signals?limit=10'
      );
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
      assert.strictEqual(res.serverInfo.version, '1.2.5');
      assert.deepStrictEqual(res.capabilities, { tools: {} });

      assert(typeof res.instructions === 'string' && res.instructions.length > 50);

      // Verify key requirements in instructions
      assert(res.instructions.includes('Base Mainnet (chainId 8453)'), 'Must define Base network scope');
      assert(res.instructions.includes('Read-Only & Non-Signing Boundary'), 'Must define non-signing boundary');
      assert(res.instructions.includes('NOT a safety guarantee'), 'Must include not-a-safety-guarantee limitation');
      assert(res.instructions.includes('M2M_SENTINEL_API_KEY'), 'Must document optional API key');
      assert(res.instructions.includes('401/402'), 'Must document payable/auth error behavior');

      // Verify all six tool selection guidelines are mentioned
      assert(res.instructions.includes('m2m_audit_contract:'), 'Instructions must describe audit contract selection');
      assert(res.instructions.includes('m2m_get_gas_metrics:'), 'Instructions must describe gas metrics selection');
      assert(res.instructions.includes('m2m_get_token_price:'), 'Instructions must describe token price selection');
      assert(res.instructions.includes('m2m_get_dex_liquidity:'), 'Instructions must describe DEX liquidity selection');
      assert(res.instructions.includes('m2m_get_whale_signals:'), 'Instructions must describe whale signals selection');
      assert(res.instructions.includes('m2m_get_service_status:'), 'Instructions must describe service status selection');
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

      // Specific idempotency expectations
      const auditTool = TOOLS.find((t) => t.name === 'm2m_audit_contract');
      assert.strictEqual(auditTool.annotations.idempotentHint, true, 'Audit contract tool is idempotent');

      const gasTool = TOOLS.find((t) => t.name === 'm2m_get_gas_metrics');
      assert.strictEqual(gasTool.annotations.idempotentHint, false, 'Gas metrics tool is live telemetry');
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
      assert(dexTool.inputSchema.properties.pair.description.includes('trading pair'));

      const whaleTool = TOOLS.find((t) => t.name === 'm2m_get_whale_signals');
      assert(whaleTool.inputSchema.properties.limit.description.includes('maximum number'));
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

        if (req.url === '/v1/dex/metrics?pair=WETH-USDC') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            pair: 'WETH-USDC',
            reserveUsd: '45000000',
            feeTier: '0.05%'
          }));
          return;
        }

        if (req.url === '/v1/whales/signals?limit=5') {
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

    it('exercises m2m_get_dex_liquidity with pair argument against fake server', async () => {
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
      assert(requestedPaths.includes('/v1/dex/metrics?pair=WETH-USDC'));
    });

    it('surfaces HTTP 402 payment required with headers and isError flag', async () => {
      const payAddr = '0x1111111111111111111111111111111111111111';
      const response = await callMcp({
        jsonrpc: '2.0',
        id: 206,
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
});
