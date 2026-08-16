# M2M Sentinel Python SDK

Python client for Base bytecode capability, common-proxy, and sourced market
observations. Results are not safety certifications or transaction advice.

## Source install

```bash
python -m pip install ./public/sdk/python
```

Registry publication is managed separately and is not claimed by this source
tree.

## Example

```python
from m2m_sentinel import M2MSentinelClient

client = M2MSentinelClient(api_key="sk_starter_...")
response = client.audit_contract("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913")
audit = response["audit"]
print(audit["capabilityRating"], audit["evidenceGrade"])
print(audit["proxyResolution"], audit["limitations"])

index = client.get_capability_score("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913")
print(index["capabilityScore"], index["scoreMeaning"])

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

The route behind `get_capability_score` retains `/v1/security/score/:address`
for compatibility, but its value means only that fewer selected static patterns
were observed. It is not a security score or safety probability.
