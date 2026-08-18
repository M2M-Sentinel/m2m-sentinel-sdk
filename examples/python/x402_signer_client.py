"""
M2M Sentinel — Headless x402 Python Signer Client.

Handles HTTP 402 Payment Required challenges by signing EIP-712 / EIP-3009
transfer authorizations for Base USDC without browser wallet dependencies.
"""

import json
import base64
import time
import os
import urllib.request
import urllib.error

BASE_USDC_CONTRACT = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
BASE_CHAIN_ID = 8453


EXPECTED_PAYOUT_RECIPIENT = "0x6d6c398390cfb88f1cd42715b84906a0bd6652aa"
DEFAULT_MAX_PRICE_USD = 0.05  # 5 cents maximum per autonomous request


class X402SignerClient:
    def __init__(self, private_key=None, base_url="https://api.m2msentinel.com", timeout=30, max_price_usd=DEFAULT_MAX_PRICE_USD, expected_recipient=EXPECTED_PAYOUT_RECIPIENT):
        self.private_key = private_key or os.getenv("OPERATOR_TEST_WALLET_KEY")
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.max_price_usd = float(max_price_usd)
        self.max_amount_units = int(self.max_price_usd * 1_000_000)
        self.expected_recipient = expected_recipient

    def _parse_challenge(self, header_value, body):
        if header_value:
            try:
                return json.loads(header_value)
            except Exception:
                try:
                    return json.loads(base64.b64decode(header_value).decode("utf-8"))
                except Exception:
                    pass
        if isinstance(body, dict):
            if "accepts" in body and len(body["accepts"]) > 0:
                return body["accepts"][0]
            if "paymentRequired" in body:
                return body["paymentRequired"]
        return None

    def sign_authorization(self, challenge):
        if not self.private_key:
            raise ValueError("Signer private key is required to sign x402 payment authorization")

        pay_to = challenge.get("payTo") or challenge.get("recipient") or self.expected_recipient
        amount_units = str(challenge.get("maxAmountRequired") or challenge.get("amountUnits") or "5000")
        token_contract = challenge.get("assetContract") or BASE_USDC_CONTRACT
        chain_id = int(challenge.get("chainId") or BASE_CHAIN_ID)

        # Local Security Invariant Checks
        if chain_id != BASE_CHAIN_ID:
            raise ValueError(f"[x402 Security Policy] Refusing to sign on unverified network chainId: {chain_id}. Expected Base Mainnet (8453).")
        if token_contract.lower() != BASE_USDC_CONTRACT.lower():
            raise ValueError(f"[x402 Security Policy] Refusing to sign for unapproved asset: {token_contract}. Expected Base USDC ({BASE_USDC_CONTRACT}).")
        if pay_to.lower() != self.expected_recipient.lower():
            raise ValueError(f"[x402 Security Policy] Refusing to sign for unexpected recipient: {pay_to}. Expected {self.expected_recipient}.")
        if int(amount_units) > self.max_amount_units:
            raise ValueError(f"[x402 Security Policy] Requested amount ({amount_units} units) exceeds local client authorized price ceiling ({self.max_amount_units} units).")

        now = int(time.time())
        valid_after = now - 60
        valid_before = now + 3600
        nonce = "0x" + os.urandom(32).hex()

        try:
            from eth_account import Account
            from eth_account.messages import encode_typed_data

            account = Account.from_key(self.private_key)
            from_address = account.address

            structured_data = {
                "types": {
                    "EIP712Domain": [
                        {"name": "name", "type": "string"},
                        {"name": "version", "type": "string"},
                        {"name": "chainId", "type": "uint256"},
                        {"name": "verifyingContract", "type": "address"},
                    ],
                    "TransferWithAuthorization": [
                        {"name": "from", "type": "address"},
                        {"name": "to", "type": "address"},
                        {"name": "value", "type": "uint256"},
                        {"name": "validAfter", "type": "uint256"},
                        {"name": "validBefore", "type": "uint256"},
                        {"name": "nonce", "type": "bytes32"},
                    ],
                },
                "primaryType": "TransferWithAuthorization",
                "domain": {
                    "name": "USD Coin",
                    "version": "2",
                    "chainId": chain_id,
                    "verifyingContract": token_contract,
                },
                "message": {
                    "from": from_address,
                    "to": pay_to,
                    "value": int(amount_units),
                    "validAfter": valid_after,
                    "validBefore": valid_before,
                    "nonce": bytes.fromhex(nonce[2:]),
                },
            }

            signable = encode_typed_data(full_message=structured_data)
            signed = account.sign_message(signable)
            signature = "0x" + signed.signature.hex()

            return {
                "x402Version": 2,
                "scheme": "eip3009",
                "network": "base",
                "chainId": chain_id,
                "asset": "USDC",
                "assetContract": token_contract,
                "authorization": {
                    "from": from_address,
                    "to": pay_to,
                    "value": amount_units,
                    "validAfter": valid_after,
                    "validBefore": valid_before,
                    "nonce": nonce,
                    "v": signed.v,
                    "r": "0x" + signed.r.to_bytes(32, "big").hex(),
                    "s": "0x" + signed.s.to_bytes(32, "big").hex(),
                    "signature": signature,
                },
            }
        except ImportError:
            # Fallback envelope for mock / dry-run tests when eth-account is not in environment
            return {
                "x402Version": 2,
                "scheme": "eip3009",
                "network": "base",
                "chainId": chain_id,
                "asset": "USDC",
                "assetContract": token_contract,
                "authorization": {
                    "from": "0x0000000000000000000000000000000000000001",
                    "to": pay_to,
                    "value": amount_units,
                    "validAfter": valid_after,
                    "validBefore": valid_before,
                    "nonce": nonce,
                    "signature": "0x" + "00" * 65,
                },
            }

    def request(self, endpoint_path, method="GET", body=None, headers=None):
        url = f"{self.base_url}/{endpoint_path.lstrip('/')}"
        req_headers = {
            "Accept": "application/json",
            "User-Agent": "M2MSentinel-PythonX402/1.1.0",
        }
        if headers:
            req_headers.update(headers)

        data = json.dumps(body).encode("utf-8") if body else None
        req = urllib.request.Request(url, data=data, headers=req_headers, method=method)

        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                resp_body = json.loads(resp.read().decode("utf-8"))
                return {"statusCode": resp.status, "body": resp_body, "headers": dict(resp.headers)}
        except urllib.error.HTTPError as e:
            if e.code == 402:
                resp_data = e.read().decode("utf-8")
                try:
                    resp_body = json.loads(resp_data)
                except Exception:
                    resp_body = {"raw": resp_data}

                challenge_header = e.headers.get("payment-required") or e.headers.get("x-payment-required")
                challenge = self._parse_challenge(challenge_header, resp_body)
                if not challenge:
                    raise RuntimeError("HTTP 402 received with no valid payment challenge")

                payment_payload = self.sign_authorization(challenge)
                encoded = base64.b64encode(json.dumps(payment_payload).encode("utf-8")).decode("utf-8")

                req_headers["x-payment-response"] = encoded
                paid_req = urllib.request.Request(url, data=data, headers=req_headers, method=method)
                with urllib.request.urlopen(paid_req, timeout=self.timeout) as paid_resp:
                    paid_body = json.loads(paid_resp.read().decode("utf-8"))
                    return {
                        "statusCode": paid_resp.status,
                        "body": paid_body,
                        "headers": dict(paid_resp.headers),
                        "paymentPayload": payment_payload,
                    }
            raise


if __name__ == "__main__":
    print("M2M Sentinel Headless Python x402 Signer ready.")
