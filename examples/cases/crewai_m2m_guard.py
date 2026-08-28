"""
CrewAI Preflight Capability Observation Tool: M2M Sentinel

Equips CrewAI agents with static EVM bytecode observations before executing
on-chain transactions or routing liquidity on Base. The CrewAI workflow must
apply a caller-defined execution policy.
"""

import os
import json
import urllib.request
import urllib.error

# Lightweight standalone tool interface compatible with CrewAI BaseTool
class M2MPreflightGuardTool:
    name: str = "M2M Preflight Bytecode Guard"
    description: str = (
        "Observes smart contract bytecode capabilities and proxy resolution on Base. "
        "Returns evidence for a caller-defined policy; it does not make a transaction decision."
    )

    def run(self, contract_address: str) -> dict:
        api_key = os.getenv("M2M_SENTINEL_API_KEY")
        endpoint = (
            f"https://api.m2msentinel.com/v1/audit/{contract_address}"
            if api_key
            else f"https://api.m2msentinel.com/v1/demo/audit/{contract_address}"
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

                    capability_evidence = dissection.get("capabilities", [])
                    executable_capabilities = data.get("verdict", {}).get(
                        "executableCapabilities",
                        [item.get("type") for item in capability_evidence if isinstance(item, dict) and item.get("type")]
                    )
                    is_proxy = proxy_info.get("isProxy", False)

                    return {
                        "status": "SUCCESS",
                        "contract": data.get("address", contract_address),
                        "hasCode": dissection.get("isValidContract", False),
                        "isProxy": is_proxy,
                        "proxyType": proxy_info.get("proxyType"),
                        "targetAddress": proxy_info.get("targetAddress"),
                        "capabilityEvidence": capability_evidence,
                        "executableCapabilities": executable_capabilities,
                        "trustLevel": provenance.get("trustLevel", "NOT_REPORTED"),
                        "reachability": data.get("reachability", "NOT_ESTABLISHED"),
                        "limitations": data.get("limitations", []),
                        "notASafetyGuarantee": True,
                        "policyNotice": "Apply a caller-defined execution policy; static observations are not a safety decision."
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
