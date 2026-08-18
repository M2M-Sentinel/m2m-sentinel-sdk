"""
LlamaIndex FunctionTool Integration for M2M Sentinel.
Compatible with LlamaIndex Workflow and Data Agents.
"""

from typing import Optional, Dict, Any
from .client import M2MSentinelClient


def get_m2m_audit_tool(api_key: Optional[str] = None, base_url: Optional[str] = None):
    """
    Returns a LlamaIndex-compatible function or FunctionTool.
    """
    client = M2MSentinelClient(api_key=api_key, base_url=base_url)

    def audit_base_contract(address: str) -> Dict[str, Any]:
        """
        Audit the EVM bytecode capabilities and EIP-1967 proxy configuration of a Base contract.
        
        Args:
            address: 0x-prefixed 40-hex Base contract address.
        """
        return client.audit_contract(address)

    try:
        from llama_index.core.tools import FunctionTool
        return FunctionTool.from_defaults(
            fn=audit_base_contract,
            name="m2m_audit_contract",
            description="Inspects EVM bytecode opcode capabilities and proxies on Base (Chain ID 8453)."
        )
    except ImportError:
        return audit_base_contract
