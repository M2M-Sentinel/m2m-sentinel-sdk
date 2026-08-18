# M2M Sentinel SDK & MCP Server

Official multi-language client library, **Model Context Protocol (MCP) server**, and **Coinbase AgentKit ActionProvider** for M2M Sentinel — deterministic EVM bytecode capability intelligence, EIP-1967 proxy resolution, and preflight guards for autonomous agents operating on Base.

[![npm version](https://img.shields.io/npm/v/m2m-sentinel-sdk.svg)](https://www.npmjs.com/package/m2m-sentinel-sdk)
[![PyPI version](https://img.shields.io/pypi/v/m2m-sentinel.svg)](https://pypi.org/project/m2m-sentinel/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Smithery](https://smithery.ai/badge/m2m-sentinel-sdk)](https://smithery.ai/server/m2m-sentinel-sdk)

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
      "args": ["-y", "m2m-sentinel-sdk"],
      "env": {
        "M2M_SENTINEL_API_KEY": ""
      }
    }
  }
}
```

### Option C: Remote HTTP / Server-Sent Events (SSE)
* **SSE Stream**: `https://api.m2msentinel.com/sse`
* **Messages**: `https://api.m2msentinel.com/messages`

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

```bash
npm install m2m-sentinel-sdk
```

```javascript
const { M2MSentinelClient } = require('m2m-sentinel-sdk');

const client = new M2MSentinelClient();

async function main() {
  const audit = await client.auditContract('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
  console.log('Proxy Detected:', audit.data.proxyDetection.isProxy);
  console.log('Capabilities:', audit.data.bytecodeAnalysis.detectedCapabilities);
}

main().catch(console.error);
```

---

## 🐍 4. Python Client

```bash
pip install m2m-sentinel
```

```python
from m2m_sentinel import M2MSentinelClient

client = M2MSentinelClient()
audit = client.audit_contract("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913")
print("Proxy detected:", audit["data"]["proxyDetection"]["isProxy"])
print("Capabilities:", audit["data"]["bytecodeAnalysis"]["detectedCapabilities"])
```

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
