# M2M Sentinel SDK & MCP Server

Official multi-language client library, **Model Context Protocol (MCP) server**, and **Coinbase AgentKit ActionProvider** for M2M Sentinel — deterministic EVM bytecode capability observations and common-proxy resolution for autonomous applications operating on Base. Callers own transaction policy.

> This export labels npm 1.2.8 as a local release candidate, not a verified published artifact. This candidate version does not establish registry publication or installability. The install commands below use the last-verified npm release 1.2.7.



[![npm version](https://img.shields.io/npm/v/m2m-sentinel-sdk.svg)](https://www.npmjs.com/package/m2m-sentinel-sdk)
[![PyPI version](https://img.shields.io/pypi/v/m2m-sentinel.svg)](https://pypi.org/project/m2m-sentinel/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Smithery](https://smithery.ai/badge/m2m-sentinel-sdk)](https://smithery.ai/server/m2m-sentinel-sdk)

---

## Try Base USDC without a wallet or API key

This quickstart uses Base USDC, a published allowlisted sample at
`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`. The response contains factual
capability evidence and limitations, not a safety guarantee or transaction
advice. The live demo can be rate limited (HTTP 429 with `Retry-After`) or
unavailable when upstream evidence sources fail (HTTP 503).

```bash
curl --fail-with-body https://api.m2msentinel.com/v1/demo/audit/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
```

```bash
npm install m2m-sentinel-sdk@1.2.7
```

```javascript
const { M2MSentinelClient } = require('m2m-sentinel-sdk');
(async () => {
  const client = new M2MSentinelClient();
  const result = await client.demoAudit('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
  console.log(JSON.stringify(result, null, 2));
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
```

```bash
pip install m2m-sentinel==1.2.7
```

```python
from m2m_sentinel import M2MSentinelClient

client = M2MSentinelClient()
result = client.demo_audit("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913")
print(result)
```

Other addresses receive only the public preview. Full `/v1/audit/:address`
analysis remains protected by an API key or an explicitly authorized x402
payment; the demo never pays silently. The client does not automatically retry
or fall back to a protected route after a demo error. The source SDK export includes a
runnable no-credential JavaScript example at `examples/try_public_demo.js`;
it is not included in the last-verified npm 1.2.7 artifact.

---

## ⚡ 1. Model Context Protocol (MCP) Server

Connect M2M Sentinel directly to **Claude Desktop**, **Cursor**, **Windsurf**, or any MCP-compliant LLM agent.

### Option A: 1-Click via Smithery
```bash
npx -y @smithery/cli mcp add M2M-Sentinel/m2m-sentinel-sdk --client claude
```

### Option B: Local Stdio (`claude_desktop_config.json`)
```json
{
  "mcpServers": {
    "m2m-sentinel": {
      "command": "npx",
      "args": ["-y", "m2m-sentinel-sdk@1.2.7"],
      "env": {
        "M2M_SENTINEL_API_KEY": ""
      }
    }
  }
}
```

### Option C: Remote Streamable HTTP
* **Current MCP endpoint**: `https://api.m2msentinel.com/mcp`
* **Legacy HTTP+SSE compatibility**: `https://api.m2msentinel.com/sse` with messages at `https://api.m2msentinel.com/messages`

---

## 🤖 2. Coinbase AgentKit Integration

```typescript
import { AgentKit } from "@coinbase/agentkit";
import { m2mSentinelActionProvider } from "m2m-sentinel-sdk";

const agentKit = await AgentKit.from({
  walletProvider,
  actionProviders: [
    m2mSentinelActionProvider({
      apiKey: process.env.M2M_SENTINEL_API_KEY
    })
  ]
});
```

---

## 📦 3. JavaScript / TypeScript Client

### Authenticated SDK quickstart

```bash
npm install m2m-sentinel-sdk@1.2.7
```

```javascript
const { M2MSentinelClient } = require('m2m-sentinel-sdk');

const client = new M2MSentinelClient({ apiKey: process.env.M2M_SENTINEL_API_KEY });

async function main() {
const audit = await client.auditContract('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
console.log('Proxy Detected:', audit.audit.proxyResolution.isProxy);
console.log('Proxy Target:', audit.audit.proxyResolution.targetAddress);
console.log('Capabilities:', audit.audit.verdict.executableCapabilities);
console.log('Evidence:', audit.audit.dissection.capabilities);
}

main().catch(console.error);
```

---

## 🛡️ Base Account `wallet_sendCalls` Guard

The public SDK includes `guardWalletSendCalls`, a customer-side execution-identity
boundary for Base Account / EIP-5792 batches. It preflights the anchor call and
evaluates its caller policy before scheduling any remaining call, then pins
remaining calls to the first trusted block identity in waves of at most four.
Each settled wave is validated and policy-checked in ascending request-index
order before a later wave starts; a failure or rejection stops later scheduling.
The original detached request is forwarded only after all checks pass. It does
not sign, broadcast, custody funds, infer inner UserOperation semantics, or
make a safety claim. See `examples/base_account_paymaster_guard.js` for a no-network fixture.

---

## 🐍 4. Python Client

```bash
pip install m2m-sentinel==1.2.7
```

```python
from m2m_sentinel import M2MSentinelClient

client = M2MSentinelClient()
result = client.demo_audit("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913")
print(result)
```

---

## Transaction-specific preflight example

The public repository includes a standalone, mock-only transaction boundary
example at [`examples/transaction_preflight.js`](examples/transaction_preflight.js).
From this repository root, run:

```bash
node examples/transaction_preflight.js
```

It observes one caller-supplied Base transaction, passes the observation to a
caller-owned policy, and reaches only a mock signing/send callback. It refuses
to continue on unverified evidence, unresolved execution, an observation
mismatch, or a missing Diamond selector mapping. It never signs or sends a
transaction; optional live mode uses only a caller-supplied API-key header and
remains the caller's responsibility.

---

## 💳 5. Autonomous x402 Micropayments (Headless M2M)

```typescript
import { x402SignerClient } from "m2m-sentinel-sdk";

const client = new x402SignerClient({
  walletSigner: myAgentWallet,
  baseUrl: "https://api.m2msentinel.com"
});

const result = await client.request("/v1/audit/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
```

---

## 📜 License
MIT License. Copyright (c) 2026 M2M Sentinel.
