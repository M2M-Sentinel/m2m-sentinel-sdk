"""
LangChain BaseTool: M2M Sentinel EVM Preflight Tool

Enables autonomous LangChain agents to observe static bytecode evidence on
Base prior to transaction dispatch or tool routing. Execution policy remains
the caller's responsibility.
"""

import os
import json
import urllib.request
import urllib.error
from typing import Optional, Type
from pydantic import BaseModel, Field
try:
    from langchain.tools import BaseTool
except ImportError:
    # Standalone fallback definition for clean execution without full langchain install
    class BaseTool:
        name: str = ""
        description: str = ""
        args_schema: Optional[Type[BaseModel]] = None
        def _run(self, *args, **kwargs): raise NotImplementedError


class ContractAuditInput(BaseModel):
    address: str = Field(description="The 0x-prefixed 40-character EVM contract address on Base Mainnet.")


class M2MContractAuditTool(BaseTool):
    name: str = "m2m_audit_contract"
    description: str = (
        "Static EVM bytecode capability observation tool for Base contracts. "
        "Returns proxy resolution (EIP-1967/UUPS), observed capabilities, and bytecode provenance. "
        "Useful before executing token swaps or contract calls."
    )
    args_schema: Type[BaseModel] = ContractAuditInput

    def _run(self, address: str) -> str:
        api_key = os.getenv("M2M_SENTINEL_API_KEY")
        endpoint = f"https://api.m2msentinel.com/v1/audit/{address}" if api_key else f"https://api.m2msentinel.com/v1/demo/audit/{address}"
        
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

                    return json.dumps({
                        "address": data.get("address", address),
                        "hasCode": dissection.get("isValidContract", True),
                        "proxy": {
                            "isProxy": proxy_info.get("isProxy", False),
                            "proxyType": proxy_info.get("proxyType"),
                            "targetAddress": proxy_info.get("targetAddress")
                        },
                        "capabilityEvidence": capability_evidence,
                        "executableCapabilities": executable_capabilities,
                        "trustLevel": provenance.get("trustLevel", "NOT_REPORTED"),
                        "reachability": data.get("reachability", "NOT_ESTABLISHED"),
                        "notASafetyGuarantee": True,
                        "limitations": data.get("limitations", []),
                        "policyNotice": "Apply a caller-defined execution policy; static observations are not a safety decision."
                    }, indent=2)
                return f"Error: Received HTTP {response.status} from M2M Sentinel"
        except urllib.error.HTTPError as e:
            return f"HTTPError {e.code}: {e.read().decode('utf-8')}"
        except Exception as e:
            return f"Audit Exception: {str(e)}"

    async def _arun(self, address: str) -> str:
        # Asynchronous execution forwards to synchronous implementation
        return self._run(address)


if __name__ == "__main__":
    tool = M2MContractAuditTool()
    usdc_base = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
    print("Testing M2MContractAuditTool on Base USDC:")
    result = tool._run(usdc_base)
    print(result)
