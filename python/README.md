# M2M Sentinel Python SDK

Python client for Base EVM bytecode capability, common-proxy resolution, and sourced market observations. Factual static capability observation — not a formal reachability audit, safety guarantee, or transaction advice.

## Installation

### From PyPI (Recommended)

```bash
pip install m2m-sentinel==1.1.1
```

### From Source

```bash
git clone https://github.com/M2M-Sentinel/m2m-sentinel-sdk.git
cd m2m-sentinel-sdk/python
pip install .
```

## Quickstart Example

```python
from m2m_sentinel import M2MSentinelClient, X402SignerClient

# 1. Initialize client (defaults to https://api.m2msentinel.com)
client = M2MSentinelClient(api_key="sk_starter_...")

# Inspect a Base smart contract in <35ms
response = client.audit_contract("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913")
audit = response["audit"]
print("Capability Rating:", audit["capabilityRating"])
print("Proxy Resolution:", audit["proxyResolution"])

# 2. Autonomous Headless x402 Micropayments (EIP-3009 Local Signing)
signer = X402SignerClient(private_key="0x...")
paid_res = signer.fetch_with_auto_payment("/v1/audit/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913")
print("Paid analysis:", paid_res["data"])

# Get capability index (fewer observed risky static patterns = higher score)
index = client.get_capability_score("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913")
print("Capability Score:", index["capabilityScore"], index["scoreMeaning"])

# Schematic paid-onboarding example. Supply these values from your private
# server/wallet flow; never hard-code credentials.
wallet_address = "0xYOUR_SUBSCRIBER_WALLET"
existing_paid_key = "READ_FROM_YOUR_SECRET_STORE"
original_payment_hash = "0xYOUR_ORIGINAL_PAYMENT_HASH"
intent = client.create_subscription_intent(
    "GROWTH", wallet_address, duration_days=90,
    renew_existing_key=True, api_key=existing_paid_key
)
recovery = client.create_recovery_challenge(wallet_address, tx_hash=original_payment_hash)
```

## Method Reference

| Method | Description |
| :--- | :--- |
| `audit_contract(address)` | Returns static opcode capability flags, proxy resolution (EIP-1967/UUPS), and bytecode provenance on Base. |
| `get_capability_score(address)` | Evaluates observed static capability patterns. (Retains `/v1/security/score/:address` for backwards compatibility). |
| `get_gas_metrics()` | Fetches real-time Base network gas suggestions and congestion telemetry. |
| `get_token_price(symbol)` | Sourced Base DEX price observation for allowlisted assets (USDC, WETH, etc.). |
| `get_dex_liquidity(address)` | Sourced DEX reserve and liquidity data on Base. |

## Important Notice

The route behind `get_capability_score` retains `/v1/security/score/:address` for legacy compatibility, but its value means only that fewer selected static patterns were observed. Factual static capability observation — not a formal reachability audit, safety guarantee, or transaction advice.
