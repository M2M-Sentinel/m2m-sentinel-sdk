"""
CrewAI BaseTool Integration for M2M Sentinel.
Compatible with CrewAI Python Agents.
"""

from typing import Type, Optional
from .client import M2MSentinelClient

try:
    from pydantic import BaseModel, Field
except ImportError:
    class BaseModel:
        pass
    def Field(*args, **kwargs):
        return None

try:
    from crewai.tools import BaseTool
except ImportError:
    try:
        from langchain_core.tools import BaseTool
    except ImportError:
        class BaseTool:
            name: str = ""
            description: str = ""
            args_schema: Optional[Type[BaseModel]] = None

            def _run(self, *args, **kwargs):
                raise NotImplementedError()


class ContractAuditSchema(BaseModel):
    address: str = Field(..., description="Target EVM contract address on Base (0x-prefixed 40-hex).")


class M2MSentinelCrewAITool(BaseTool):
    name: str = "Base Contract Capability Auditor"
    description: str = (
        "Inspects EVM bytecode of any Base smart contract to identify opcode capabilities "
        "(DELEGATECALL, SELFDESTRUCT, dynamic jumps) and resolve EIP-1967 proxy implementations. "
        "Use this tool before approving token spends or executing automated swaps."
    )
    args_schema: Type[BaseModel] = ContractAuditSchema
    client: Optional[M2MSentinelClient] = None

    def __init__(self, api_key: Optional[str] = None, base_url: Optional[str] = None, **kwargs):
        super().__init__(**kwargs)
        self.client = M2MSentinelClient(api_key=api_key, base_url=base_url)

    def _run(self, address: str) -> str:
        try:
            audit = self.client.audit_contract(address)
            return (
                f"M2M Sentinel Analysis for {address}:\n"
                f"- Capability Rating: {audit.get('audit', {}).get('capabilityRating', 'UNKNOWN')}\n"
                f"- Is Proxy: {audit.get('audit', {}).get('proxyResolution', {}).get('isProxy', False)}\n"
                f"- Target Implementation: {audit.get('audit', {}).get('proxyResolution', {}).get('implementationAddress', 'N/A')}\n"
                f"- Static Capabilities: {', '.join(audit.get('audit', {}).get('capabilities', []))}\n"
                f"- Verified RPC Provider: {audit.get('provenance', {}).get('rpcProvider', 'M2M-Sentinel')}"
            )
        except Exception as e:
            return f"Failed to audit contract {address}: {str(e)}"
