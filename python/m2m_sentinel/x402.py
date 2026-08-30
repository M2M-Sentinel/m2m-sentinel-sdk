"""
M2M Sentinel — Autonomous Headless x402 Python Signer Client.

Handles HTTP 402 Payment Required challenges by signing EIP-712 / EIP-3009
transfer authorizations for Base USDC without browser wallet dependencies.
"""

import json
import base64
import time
import os
import re
import urllib.request
import urllib.error

BASE_USDC_CONTRACT = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
BASE_CHAIN_ID = 8453


EXPECTED_PAYOUT_RECIPIENT = "0x6d6c398390cfb88f1cd42715b84906a0bd6652aa"
DEFAULT_MAX_PRICE_USD = 0.05  # 5 cents maximum per autonomous request


class X402SignerClient:
    """Headless x402 payment client for autonomous Python agents on Base."""

    def __init__(self, private_key=None, base_url="https://api.m2msentinel.com", timeout=30, max_price_usd=DEFAULT_MAX_PRICE_USD):
        self.private_key = private_key or os.getenv("M2M_AGENT_WALLET_KEY")
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.max_price_usd = float(max_price_usd)
        self.max_amount_units = int(self.max_price_usd * 1_000_000)
        self.expected_recipient = EXPECTED_PAYOUT_RECIPIENT

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
            # Return the whole PaymentRequired, not accepts[0]: the signer needs
            # `resource` and must echo the chosen offer back as `accepted`.
            if "accepts" in body and len(body["accepts"]) > 0:
                return body
            if "paymentRequired" in body:
                return body["paymentRequired"]
        return None

    def sign_authorization(self, challenge=None):
        if not self.private_key:
            raise ValueError("Signer private key is required to sign x402 payment authorization")

        if challenge is None:
            challenge = {}

        # 1. IMMUTABLE LOCAL SECURITY CONSTANTS (Never challenge-controlled)
        chain_id = BASE_CHAIN_ID  # Base Mainnet (8453)
        token_contract = BASE_USDC_CONTRACT  # Base USDC (0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913)
        pay_to = EXPECTED_PAYOUT_RECIPIENT  # M2M Sentinel Payout (0x6d6c398390cfb88f1cd42715b84906a0bd6652aa)

        # x402 v2 nests the offer under `accepts` and is identified by its
        # presence. Reading only the flat shape made every guard below miss
        # silently -- they compared None and passed -- and the amount fell back
        # to a hardcoded default, signing for less than the server demanded.
        accepts = challenge.get("accepts")
        is_v2 = isinstance(accepts, list) and len(accepts) > 0
        offer = accepts[0] if is_v2 else challenge

        offered_network = offer.get("network") or challenge.get("network")
        if isinstance(offered_network, str) and offered_network.startswith("eip155:"):
            offered_chain_id = offered_network.split(":", 1)[1]
        else:
            offered_chain_id = offer.get("chainId") or challenge.get("chainId")

        # v2 carries the address in `asset`; the flat shape carries a symbol
        # there and the address in `assetContract`. Compare addresses only.
        offered_asset = None
        for candidate in (offer.get("assetContract"), challenge.get("assetContract"),
                          offer.get("asset"), challenge.get("asset")):
            if isinstance(candidate, str) and re.match(r"^0x[0-9a-fA-F]{40}$", candidate):
                offered_asset = candidate
                break

        offered_pay_to = offer.get("payTo") or offer.get("recipient") or challenge.get("payTo")
        extra = offer.get("extra") or {}
        offered_token_name = extra.get("name") or challenge.get("tokenName")
        offered_token_version = extra.get("version") or challenge.get("tokenVersion")

        # 2. STRICT CHALLENGE INTEGRITY CHECKS (Refuse if challenge alters network, asset, or recipient)
        if offered_chain_id and int(offered_chain_id) != BASE_CHAIN_ID:
            raise ValueError(f"[x402 Security Policy] Refusing to sign on unverified network chainId: {offered_chain_id}. Autonomous signer strictly requires Base Mainnet (8453).")
        if offered_asset and offered_asset.lower() != BASE_USDC_CONTRACT.lower():
            raise ValueError(f"[x402 Security Policy] Refusing to sign for unapproved asset: {offered_asset}. Autonomous signer strictly requires Base USDC ({BASE_USDC_CONTRACT}).")
        if offered_pay_to and offered_pay_to.lower() != EXPECTED_PAYOUT_RECIPIENT.lower():
            raise ValueError(f"[x402 Security Policy] Refusing to sign for unexpected recipient: {offered_pay_to}. Autonomous signer strictly requires {EXPECTED_PAYOUT_RECIPIENT}.")
        if offered_token_name and offered_token_name != "USD Coin":
            raise ValueError(f"[x402 Security Policy] Refusing to sign for unexpected tokenName: {offered_token_name}. Expected USD Coin.")
        if offered_token_version and offered_token_version != "2":
            raise ValueError(f"[x402 Security Policy] Refusing to sign for unexpected tokenVersion: {offered_token_version}. Expected 2.")

        # 3. STRICT LOCAL PRICE CEILING CHECK
        # Never invent a price. A guessed amount produces an authorization the
        # server refuses, which is indistinguishable from a rejected payment.
        raw_amount = (offer.get("amount") or offer.get("maxAmountRequired") or
                      challenge.get("maxAmountRequired") or challenge.get("amountUnits"))
        requested_amount_units = None
        if isinstance(raw_amount, int) and raw_amount > 0:
            requested_amount_units = str(raw_amount)
        elif isinstance(raw_amount, str) and raw_amount.strip().isdigit():
            requested_amount_units = raw_amount.strip()
        if not requested_amount_units or int(requested_amount_units) <= 0:
            raise ValueError("[x402] The challenge carried no readable amount. Refusing to guess a price.")
        if int(requested_amount_units) > self.max_amount_units:
            raise ValueError(f"[x402 Security Policy] Requested amount ({requested_amount_units} units) exceeds local client authorized price ceiling ({self.max_amount_units} units / ${self.max_price_usd}).")
        amount_units = requested_amount_units

        now = int(time.time())
        # v2 servers bound the window with `maxTimeoutSeconds`; a longer window
        # than advertised is not more permissive, just outside what settles.
        valid_after = 0 if is_v2 else now - 60
        valid_before = (now + int(offer.get("maxTimeoutSeconds") or 120)) if is_v2 else now + 3600
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
                    "name": offered_token_name or "USD Coin",
                    "version": offered_token_version or "2",
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

            signature_hex = signed.signature.hex()
            if not signature_hex.startswith("0x"):
                signature_hex = "0x" + signature_hex

            if is_v2:
                # The canonical v2 envelope. Omitting `accepted` does not read
                # as "no payment": it crashes the server's offer matcher, which
                # then answers 402 with an opaque body. There is deliberately no
                # top-level scheme/network in v2 -- both live inside `accepted`.
                return {
                    "x402Version": 2,
                    "resource": challenge.get("resource"),
                    "accepted": offer,
                    # Echo the server's advertised extensions back. The canonical
                    # client merges them into the payload; omitting the field
                    # still settles the payment, so this failed silently -- but
                    # the CDP Bazaar indexes a resource from the bazaar extension
                    # carried by the settlement, so a payment without it is
                    # invisible to discovery.
                    "extensions": challenge.get("extensions"),
                    "payload": {
                        "authorization": {
                            "from": from_address,
                            "to": pay_to,
                            "value": amount_units,
                            "validAfter": str(valid_after),
                            "validBefore": str(valid_before),
                            "nonce": nonce,
                        },
                        "signature": signature_hex,
                    },
                }

            # Legacy flat envelope, for servers that do not advertise `accepts`.
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
        req_headers = {"Accept": "application/json", "User-Agent": "M2M-Sentinel-Python-Signer/1.2.3"}
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
