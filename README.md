# M2M Sentinel SDK

Official multi-language client libraries for M2M Sentinel — the pre-transaction capability evidence layer for Base agents.

[![npm version](https://img.shields.io/npm/v/m2m-sentinel-sdk.svg)](https://www.npmjs.com/package/m2m-sentinel-sdk)
[![PyPI version](https://img.shields.io/pypi/v/m2m-sentinel.svg)](https://pypi.org/project/m2m-sentinel/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

M2M Sentinel provides proxy-aware contract capability observations, implementation slot resolution, gas metrics, DEX liquidity telemetry, and whale signals for autonomous agents operating on Base.

## Installation

### JavaScript / TypeScript (Node.js)
```bash
npm install m2m-sentinel-sdk
```

### Python
```bash
pip install m2m-sentinel
```

## Quick Start

### Node.js / TypeScript
```javascript
const { M2MSentinelClient } = require('m2m-sentinel-sdk');

const client = new M2MSentinelClient({
  apiKey: process.env.M2M_SENTINEL_API_KEY
});

async function main() {
  const audit = await client.auditContract('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
  console.log('Contract Type:', audit.data.bytecodeAnalysis.contractType);
  console.log('Proxy Detected:', audit.data.proxyDetection.isProxy);
  console.log('Capabilities:', audit.data.bytecodeAnalysis.detectedCapabilities);
}

main().catch(console.error);
```

### Python
```python
from m2m_sentinel import M2MSentinelClient

client = M2MSentinelClient(api_key="your_api_key")
audit = client.audit_contract("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913")
print("Contract Type:", audit["data"]["bytecodeAnalysis"]["contractType"])
```

## Model Context Protocol (MCP) Server

M2M Sentinel includes a full Model Context Protocol (MCP) server supporting stdio and HTTP/SSE streams.

```bash
node mcp_server.js
```

## License
MIT License. Copyright (c) 2026 M2M Sentinel.
