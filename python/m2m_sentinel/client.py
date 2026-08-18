import json
import base64
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_BASE_URL = "https://api.m2msentinel.com"
DEFAULT_TIMEOUT = 30


class M2MSentinelError(Exception):
    def __init__(self, message, status=None, body=None, retry_after=None, payment_required=None, payment_response=None):
        super().__init__(message)
        self.status = status
        self.body = body
        self.retry_after = retry_after
        self.payment_required = payment_required
        self.payment_response = payment_response


class PaymentRequiredError(M2MSentinelError):
    pass


class RateLimitedError(M2MSentinelError):
    pass


class DataSourceUnavailableError(M2MSentinelError):
    pass


def _parse_x402_header(value):
    if not value:
        return None
    try:
        return json.loads(value)
    except ValueError:
        pass
    try:
        padding = "=" * (-len(value) % 4)
        decoded = base64.urlsafe_b64decode((value + padding).encode("ascii"))
        return json.loads(decoded.decode("utf-8"))
    except (ValueError, UnicodeError):
        return None


class M2MSentinelClient:
    def __init__(self, api_key = None, base_url=DEFAULT_BASE_URL, timeout=DEFAULT_TIMEOUT, payment_signature = None):
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.payment_signature = payment_signature

    def _request(self, method, path, data=None, api_key = None, payment_signature = None, operator_token=None):
        headers = {
            "Accept": "application/json",
            "User-Agent": "M2MSentinel-Python/1.1.0",
        }
        if data is not None:
            headers["Content-Type"] = "application/json"
        key = api_key or self.api_key
        if key:
            headers["x-api-key"] = key
        if operator_token:
            headers["Authorization"] = "Bearer " + operator_token
        signature = payment_signature or self.payment_signature
        if signature:
            headers["PAYMENT-SIGNATURE"] = signature

        body = json.dumps(data).encode("utf-8") if data is not None else None
        request = urllib.request.Request(self.base_url + path, data=body, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                raw = response.read().decode("utf-8")
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode("utf-8")
            try:
                payload = json.loads(raw) if raw else None
            except ValueError:
                payload = {"raw": raw}
            payment_required = _parse_x402_header(exc.headers.get("PAYMENT-REQUIRED"))
            payment_response = _parse_x402_header(exc.headers.get("PAYMENT-RESPONSE")) or exc.headers.get("PAYMENT-RESPONSE")
            message = payload.get("message") if isinstance(payload, dict) and payload.get("message") else f"M2M Sentinel HTTP {exc.code}"
            kwargs = {
                "status": exc.code,
                "body": payload,
                "retry_after": exc.headers.get("Retry-After"),
                "payment_required": payment_required,
                "payment_response": payment_response,
            }
            if exc.code == 402:
                raise PaymentRequiredError(message, **kwargs) from exc
            if exc.code == 429:
                raise RateLimitedError(message, **kwargs) from exc
            if exc.code == 503 and isinstance(payload, dict) and payload.get("error") == "DATA_SOURCE_UNAVAILABLE":
                raise DataSourceUnavailableError(message, **kwargs) from exc
            raise M2MSentinelError(message, **kwargs) from exc

    def get_status(self):
        return self._request("GET", "/v1/status")

    def get_public_stats(self, days=30):
        return self._request("GET", "/v1/stats?days=" + urllib.parse.quote(str(days), safe=""))

    def get_aggregate_stats(self, days=30):
        return self.get_public_stats(days)

    def get_operator_aggregate_stats(self, days, operator_token):
        return self._request("GET", "/v1/stats?days=" + urllib.parse.quote(str(days), safe=""), operator_token=operator_token)

    def get_plans(self):
        return self._request("GET", "/v1/plans")

    def demo_audit(self, address):
        return self._request("GET", "/v1/demo/audit/" + urllib.parse.quote(address, safe=""))

    def create_free_challenge(self, user_wallet):
        return self._request("POST", "/v1/subscribe/free/challenge", {"userWallet": user_wallet})

    def claim_free_tier(self, intent_id, signature):
        return self._request("POST", "/v1/subscribe/free/claim", {"intentId": intent_id, "signature": signature})

    def create_subscription_intent(self, tier, user_wallet, duration_days=None, renew_existing_key=False, api_key=None):
        body = {"tier": tier, "userWallet": user_wallet}
        if duration_days is not None:
            body["durationDays"] = duration_days
        if renew_existing_key:
            body["renewExistingKey"] = True
        return self._request("POST", "/v1/subscribe/intents", body, api_key=api_key)

    def claim_subscription(self, intent_id, signature, tx_hash):
        return self._request("POST", "/v1/subscribe/crypto", {"intentId": intent_id, "signature": signature, "txHash": tx_hash})

    def create_recovery_challenge(self, user_wallet, tx_hash=None):
        body = {"userWallet": user_wallet}
        if tx_hash is not None:
            body["txHash"] = tx_hash
        return self._request("POST", "/v1/keys/recovery/challenge", body)

    def claim_recovered_key(self, intent_id, signature):
        return self._request("POST", "/v1/keys/recovery/claim", {"intentId": intent_id, "signature": signature})

    def audit_contract(self, address):
        return self._request("GET", "/v1/audit/" + urllib.parse.quote(address, safe=""))

    def get_capability_score(self, address):
        return self._request("GET", "/v1/security/score/" + urllib.parse.quote(address, safe=""))

    # Legacy name. The endpoint returns a capability coverage index, not safety.
    def get_security_score(self, address):
        return self._request("GET", "/v1/security/score/" + urllib.parse.quote(address, safe=""))

    def get_gas_fees(self):
        return self._request("GET", "/v1/gas/fees")

    def get_dex_metrics(self):
        return self._request("GET", "/v1/dex/metrics")

    def get_token_price(self, symbol):
        return self._request("GET", "/v1/token/price/" + urllib.parse.quote(symbol, safe=""))

    def get_whale_signals(self):
        return self._request("GET", "/v1/whales/signals")

    def get_key_self(self):
        return self._request("GET", "/v1/keys/self")

    def revoke_key(self, confirm=True):
        return self._request("POST", "/v1/keys/revoke", {"confirm": confirm})

