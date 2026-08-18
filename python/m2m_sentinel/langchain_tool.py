"""
LangChain BaseTool Integration for M2M Sentinel.
Compatible with LangChain Core, LangGraph, and Python Agent Frameworks.
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
    from langchain_core.tools import BaseTool
except ImportError:
    # Graceful fallback if langchain_core is not pre-installed
    class BaseTool:
        name: str = ""
        description: str = ""
        args_schema: Optional[Type[BaseModel]] = None

        def _run(self, *args, **kwargs):
            raise NotImplementedError()


class AuditContractInput(BaseModel):
    address: str = Field(..., description="0x-prefixed 40-hex Base smart contract address to inspect.")


class M2MSentinelAuditTool(BaseTool):
    name: str = "m2m_audit_contract"
    description: str = (
        "Deterministic EVM bytecode capability analysis and proxy resolution for Base contracts. "
        "Execute before signing or sending transactions to unverified contracts on Base."
    )
    args_schema: Type[BaseModel] = AuditContractInput
    client: Optional[M2MSentinelClient] = None

    def __init__(self, api_key: Optional[str] = None, base_url: Optional[str] = None, **kwargs):
        super().__init__(**kwargs)
        self.client = M2MSentinelClient(api_key=api_key, base_url=base_url)

    def _run(self, address: str) -> str:
        try:
            res = self.client.audit_contract(address)
            return str(res)
        except Exception as e:
            return f"Error executing M2M Sentinel audit: {str(e)}"

    async def _arun(self, address: str) -> str:
        # Synchronous fallback in async context
        return self._run(address)
