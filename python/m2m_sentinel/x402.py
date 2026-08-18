"""
M2M Sentinel — Autonomous Headless x402 Python Signer Client.

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


class X402SignerClient:
    """Headless x402 payment client for autonomous Python agents on Base."""

    def __init__(self, private_key=None, base_url="https://api.m2msentinel.com", timeout=30):
        self.private_key = private_key or os.getenv("M2M_AGENT_WALLET_KEY")
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    def _parse_challenge(self, header_value, body=None):
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

        pay_to = challenge.get("payTo") or challenge.get("recipient") or "0x6d6c398390cfb88f1cd42715b84906a0bd6652aa"
        amount_units = str(challenge.get("maxAmountRequired") or challenge.get("amountUnits") or "5000")
        token_contract = challenge.get("assetContract") or BASE_USDC_CONTRACT
        chain_id = int(challenge.get("chainId") or BASE_CHAIN_ID)

        now = int(time.time())
        valid_after = now - 60
        valid_before = now + 3600
        nonce = "0x" + os.urandom(32).hex()

        try:
            from eth_account import Account
            from eth_account.messages import encode_typed_data

            account = Account.from_key(self.private_key)
            from_address = account.address

            typed_data = {
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
                    "name": challenge.get("tokenName") or "USD Coin",
                    "version": challenge.get("tokenVersion") or "2",
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

            signable = encode_typed_data(full_message=typed_data)
            signed = Account.sign_message(signable, private_key=self.private_key)

            return {
                "x402Version": 2,
                "scheme": "eip3009",
                "network": f"eip155:{chain_id}",
                "token": token_contract,
                "authorization": {
                    "from": from_address,
                    "to": pay_to,
                    "value": amount_units,
                    "validAfter": valid_after,
                    "validBefore": valid_before,
                    "nonce": nonce,
                    "v": signed.v,
                    "r": "0x" + hex(signed.r)[2:].zfill(64),
                    "s": "0x" + hex(signed.s)[2:].zfill(64),
                },
            }
        except ImportError:
            raise RuntimeError("eth-account is required for local EIP-712 signing: pip install eth-account")

    def fetch_with_auto_payment(self, path, method="GET", headers=None, body=None):
        url = path if path.startswith("http") else f"{self.base_url}/{path.lstrip('/')}"
        req_headers = {"Accept": "application/json", "User-Agent": "M2M-Sentinel-Python-Signer/1.1.1"}
        if headers:
            req_headers.update(headers)

        data = json.dumps(body).encode("utf-8") if body else None
        req = urllib.request.Request(url, data=data, headers=req_headers, method=method)

        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                raw = resp.read().decode("utf-8")
                try:
                    return {"status": resp.status, "data": json.loads(raw)}
                except Exception:
                    return {"status": resp.status, "text": raw}
        except urllib.error.HTTPError as err:
            if err.code != 402:
                raise

            challenge_header = err.headers.get("PAYMENT-REQUIRED") or err.headers.get("x402-payment-required")
            try:
                body_json = json.loads(err.read().decode("utf-8"))
            except Exception:
                body_json = None

            challenge = self._parse_challenge(challenge_header, body_json)
            if not challenge:
                raise ValueError("Could not extract x402 payment challenge from HTTP 402 response")

            payment_payload = self.sign_authorization(challenge)
            payment_b64 = base64.b64encode(json.dumps(payment_payload).encode("utf-8")).decode("utf-8")

            req_headers["PAYMENT-SIGNATURE"] = payment_b64
            retry_req = urllib.request.Request(url, data=data, headers=req_headers, method=method)

            with urllib.request.urlopen(retry_req, timeout=self.timeout) as resp:
                raw = resp.read().decode("utf-8")
                try:
                    return {"status": resp.status, "data": json.loads(raw)}
                except Exception:
                    return {"status": resp.status, "text": raw}
