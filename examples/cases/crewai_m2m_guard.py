"""
CrewAI Preflight Security Guard Tool: M2M Sentinel

Equips CrewAI agents with real-time EVM bytecode risk auditing
before executing on-chain transactions or routing liquidity on Base.
"""

import os
import json
import urllib.request
import urllib.error

# Lightweight standalone tool interface compatible with CrewAI BaseTool
class M2MPreflightGuardTool:
    name: str = "M2M Preflight Bytecode Guard"
    description: str = (
        "Inspects smart contract bytecode on Base in <35ms. "
        "Detects proxy implementations, freeze/pause capabilities, mint hooks, "
        "and uninstantiated implementations to prevent failed transactions."
    )

    def run(self, contract_address: str) -> dict:
        api_key = os.getenv("M2M_SENTINEL_API_KEY")
        endpoint = (
            f"https://m2msentinel.vercel.app/v1/audit/{contract_address}"
            if api_key
            else f"https://m2msentinel.vercel.app/v1/demo/audit/{contract_address}"
        )

        req = urllib.request.Request(endpoint, headers={"Accept": "application/json"})
        if api_key:
            req.add_header("x-api-key", api_key)

        try:
            with urllib.request.urlopen(req, timeout=5) as response:
                if response.status == 200:
                    raw = json.loads(response.read().decode("utf-8"))
                    data = raw.get("audit", raw)
                    dissection = data.get("dissection", {})
                    proxy_info = data.get("proxyResolution", data.get("proxy", {}))
                    provenance = data.get("provenance", {})

                    detected = dissection.get("detectedCapabilities", [])
                    has_freeze = "PAUSE_SELECTOR" in detected or "FREEZE_SELECTOR" in detected
                    has_mint = "MINT_SELECTOR" in detected
                    is_proxy = proxy_info.get("isProxy", False)

                    # Automated Preflight Decision for CrewAI pipeline
                    preflight_recommendation = "PROCEED_WITH_CAUTION" if (has_freeze or has_mint) else "PROCEED"
                    if not dissection.get("isValidContract", True):
                        preflight_recommendation = "ABORT_NO_BYTECODE"

                    return {
                        "status": "SUCCESS",
                        "contract": data.get("address", contract_address),
                        "recommendation": preflight_recommendation,
                        "isProxy": is_proxy,
                        "proxyType": proxy_info.get("proxyType"),
                        "implementationAddress": proxy_info.get("targetAddress"),
                        "detectedCapabilities": detected,
                        "trustLevel": provenance.get("trustLevel", "HIGH_TRUST"),
                        "disclaimer": "Static bytecode observations; not an audit or financial guarantee."
                    }
                return {"status": "ERROR", "message": f"HTTP {response.status}"}
        except urllib.error.HTTPError as e:
            return {"status": "ERROR", "code": e.code, "message": e.read().decode("utf-8")}
        except Exception as e:
            return {"status": "ERROR", "message": str(e)}


if __name__ == "__main__":
    guard = M2MPreflightGuardTool()
    aero_address = "0x940181a94A35A4569E4529A3CDfB74e38FD98631"
    print("Testing M2MPreflightGuardTool on Aerodrome AERO:")
    res = guard.run(aero_address)
    print(json.dumps(res, indent=2))
