# M2M Sentinel SDKs

Production API Base URL: `https://api.m2msentinel.com` (with fallback `https://m2msentinel.com`).

Deterministic sub-35ms EVM bytecode and proxy capability intelligence on Base. Factual static capability observation — not a formal reachability audit, safety guarantee, or transaction advice. Transaction middleware therefore requires a caller-defined policy and has no built-in allow threshold.

---

## 🏗️ Recommended Defense-in-Depth Pipeline for Agents

Autonomous agents handling value must never rely on a single oracle or heuristic. M2M Sentinel is architected as the high-throughput, sub-35ms Layer 1 preflight gate:

```text
[Agent Intent] 
       │
       ▼
[Transaction Builder]
       │
       ▼
[Stage 1: M2M Sentinel Preflight] ── (Sub-35ms Heuristic: Verify bytecode hash, proxy implementation, freeze/pause selectors)
       │
       ▼
[Stage 2: Local Policy Engine]    ── (Caller-defined rules: Check spending bounds, reject DELEGATECALL, verify allowlist)
       │
       ▼
[Stage 3: Execution Simulation]   ── (eth_call / Tenderly / Trace state simulation)
       │
       ▼
[Stage 4: Sub-Wallet Signing]     ── (Scoped ephemeral wallet signs & broadcasts on Base)
```

---

## Installation

### JavaScript / TypeScript (npm)

```bash
# Scoped package (recommended)
npm install @m2msentinel/sdk

# Or unscoped package
npm install m2m-sentinel-sdk@1.1.1
```

### Python (PyPI)

```bash
pip install m2m-sentinel==1.1.0
```

### MCP Server (Model Context Protocol)

```bash
npx -y @m2msentinel/sdk
# or
npx -y m2m-sentinel-sdk
```

---

## Quickstart: JavaScript / TypeScript

```javascript
const { M2MSentinelClient, X402SignerClient } = require('@m2msentinel/sdk');

// 1. Standard API Client (Header Authentication)
const client = new M2MSentinelClient({
  apiKey: process.env.M2M_SENTINEL_API_KEY,
  baseUrl: 'https://api.m2msentinel.com'
});

// Inspect contract capabilities before transaction
const audit = await client.auditContract('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
console.log('Contract capabilities:', audit.bytecodeAnalysis.detectedCapabilities);
console.log('Proxy Target:', audit.proxyDetection.implementationAddress);

// 2. Autonomous Headless x402 Micropayments (EIP-3009 Local Signing)
const x402Client = new X402SignerClient({
  walletSigner: myAgentWallet, // ethers / viem signer
  baseUrl: 'https://api.m2msentinel.com',
  maxPriceUsd: 0.01 // Optional: strict spending limit (default $0.05)
});

const res = await x402Client.fetchWithAutoPayment('/v1/audit/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
console.log('Paid analysis result:', res.json);
```

---

## 🛡️ Autonomous Wallet Policy & Security Boundaries

To prevent autonomous AI agents from blindly signing arbitrary or spoofed HTTP 402 challenges from untrusted sources, `X402SignerClient` enforces **4 strict client-side invariants** locally before generating any cryptographic signature:

| Client Invariant | Enforced Value | Security Protection |
| :--- | :--- | :--- |
| **Chain ID** | `8453` (Base Mainnet) | Rejects signing on any unapproved EVM chain. |
| **Asset Contract** | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | Rejects signing for unapproved tokens (Base USDC only). |
| **Payout Recipient** | `0x6d6c398390cfb88f1cd42715b84906a0bd6652aa` | Rejects signing payments to unexpected recipient addresses. |
| **Price Ceiling** | `maxPriceUsd` (Default: `$0.05`) | Throws if remote challenge requests funds exceeding caller's authorized ceiling. |

```javascript
import { X402SignerClient } from '@m2msentinel/sdk';

// Fully policy-constrained autonomous signer
const signer = new X402SignerClient({
  wallet: agentWallet,
  maxPriceUsd: 0.005, // Hard spending limit: 0.5 cents max per decision
  expectedRecipient: '0x6d6c398390cfb88f1cd42715b84906a0bd6652aa'
});
```

---

## Authentication and x402

Send API keys only in `x-api-key` (or `Authorization: Bearer`). Query-string credentials are rejected with HTTP 401. Payable routes also support x402 v2 on Base USDC. An unpaid call returns a base64 `PAYMENT-REQUIRED` challenge; a successful settlement returns `PAYMENT-RESPONSE`.

---

## Public Routes

- `GET /v1/status`
- `GET /v1/stats` (public privacy envelope; exact aggregate commercial counters are operator-only)
- `GET /v1/plans`
- `GET /v1/demo/audit/:address` for the published sample allowlist
- `GET /v1/audit/:address` (requires API key or x402 payment)

The JavaScript, TypeScript, and Python clients expose multi-period purchase/renewal and wallet recovery without requiring callers to hand-build requests:

```javascript
await client.createSubscriptionIntent('GROWTH', wallet, {
  durationDays: 90,
  renewExistingKey: true,
  apiKey: existingPaidKey
});
const challenge = await client.createRecoveryChallenge(wallet, { txHash });
await client.claimRecoveredKey(challenge.intent.id, walletSignature);
```

---

## Disclaimer & Limitations

Deterministic sub-35ms EVM bytecode and proxy capability intelligence on Base. Factual static capability observation — not a formal reachability audit, safety guarantee, or transaction advice.
