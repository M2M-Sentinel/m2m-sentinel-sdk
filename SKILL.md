---
name: m2m-sentinel
description: Deterministic EVM bytecode capability intelligence, EIP-1967 proxy resolution, gas recommendations, and preflight safety intelligence for autonomous agents on Base (Chain ID 8453).
---

# M2M Sentinel Agent Skill

Use this skill whenever an autonomous agent or application needs to inspect smart contracts on Base before executing transactions, approvals, or swaps.

## 1. Quick Capabilities Overview

- **`m2m_audit_contract(address)`**: Disassembles EVM bytecode to identify capability opcodes (`DELEGATECALL`, `SELFDESTRUCT`, dynamic jumps) and resolves EIP-1967 transparent/beacon proxies.
- **`m2m_get_gas_metrics()`**: Real-time Base gas execution telemetry and recommendations.
- **`m2m_get_token_price(symbol)`**: Sourced Base DEX price observation for allowlisted assets (e.g. USDC, WETH).
- **`m2m_get_dex_liquidity(pair)`**: DEX pool reserve depth telemetry.
- **`m2m_get_whale_signals(limit)`**: On-chain transfer signals for Base assets.

---

## 2. Integration Pathways

### A. Model Context Protocol (MCP) — Instant Stdio
Add to your agent or IDE config (`claude_desktop_config.json`, Cursor, Windsurf):

```json
{
  "mcpServers": {
    "m2m-sentinel": {
      "command": "npx",
      "args": ["-y", "m2m-sentinel-sdk"]
    }
  }
}
```

### B. Node.js / TypeScript SDK
```bash
npm install m2m-sentinel-sdk
```

```typescript
import { M2MSentinelClient } from 'm2m-sentinel-sdk';

const sentinel = new M2MSentinelClient();
const analysis = await sentinel.auditContract('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');

if (analysis.audit.capabilities.includes('SELFDESTRUCT')) {
  throw new Error('Preflight Check Failed: Dangerous opcode detected.');
}
```

### C. Python SDK
```bash
pip install m2m-sentinel
```

```python
from m2m_sentinel import M2MSentinelClient

client = M2MSentinelClient()
audit = client.audit_contract("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913")
print(f"Proxy detected: {audit['audit']['proxyResolution']['isProxy']}")
```

### D. Coinbase AgentKit
```javascript
const { m2mSentinelActionProvider } = require('m2m-sentinel-sdk/agent_adapter');
// Pass to AgentKit.from({ actionProviders: [m2mSentinelActionProvider()] })
```

### E. ElizaOS (ai16z)
```javascript
const { m2mSentinelPlugin } = require('m2m-sentinel-sdk/eliza_plugin');
// Add to runtime plugins list
```

### F. LangChain & LangGraph
```javascript
const { M2MSentinelLangChainTools } = require('m2m-sentinel-sdk/langchain_tool');
const tools = new M2MSentinelLangChainTools().getTools();
```

---

## 3. Machine-Readable Discovery & Micropayments
- **x402 Bazaar Endpoint**: `https://m2msentinel.com/.well-known/x402`
- **Hosted SSE Gateway**: `https://api.m2msentinel.com/sse`
- **Settlement**: USDC on Base (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`) to operator `0x6d6c398390cfb88f1cd42715b84906a0bd6652aa`.
