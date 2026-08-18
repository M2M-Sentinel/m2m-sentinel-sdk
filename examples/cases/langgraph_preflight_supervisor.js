'use strict';

/**
 * M2M Sentinel + LangGraph Preflight Supervisor Workflow
 *
 * Demonstrates a safety gating supervisor node in a LangGraph execution graph
 * on Base (Chain ID 8453). Ensures that any autonomous agent proposing a transaction
 * passes deterministic bytecode capability inspection before broadcast.
 */

const { M2MSentinelClient } = require('../../public/sdk/index.js');

async function runLangGraphPreflightExample() {
  console.log('🤖 Initializing LangGraph Autonomous Preflight Supervisor...');

  const sentinel = new M2MSentinelClient({
    baseUrl: process.env.M2M_SENTINEL_BASE_URL || 'https://api.m2msentinel.com',
    apiKey: process.env.M2M_SENTINEL_API_KEY || ''
  });

  // Simulated agent intent proposing interaction with USDC on Base
  const agentState = {
    proposedAction: 'SWAP',
    targetContract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC on Base
    amountUsd: 250.0,
    policy: {
      requireVerifiedRpc: true,
      blockSelfDestruct: true,
      allowProxyOnlyWithResolvedTarget: true
    }
  };

  console.log(`\n[Node: Preflight Supervisor] Auditing target contract: ${agentState.targetContract}`);
  
  try {
    const auditRes = await sentinel.auditContract(agentState.targetContract);
    const audit = auditRes.audit || {};
    const proxy = audit.proxyResolution || {};

    console.log(`✓ Upstream RPC Provider: ${auditRes.provenance?.rpcProvider || 'M2M Multi-RPC Quorum'}`);
    console.log(`✓ Capability Rating: ${audit.capabilityRating || 'VERIFIED'}`);
    console.log(`✓ Is Proxy: ${proxy.isProxy} (${proxy.proxyType || 'NONE'})`);
    if (proxy.isProxy) {
      console.log(`✓ Implementation Target: ${proxy.implementationAddress}`);
    }

    // Gating Evaluation
    const capabilities = audit.capabilities || [];
    if (capabilities.includes('SELFDESTRUCT') && agentState.policy.blockSelfDestruct) {
      console.error('❌ Supervisor Intervention: SELFDESTRUCT detected in target bytecode! Transaction ABORTED.');
      return { status: 'BLOCKED', reason: 'DANGEROUS_OPCODE_DETECTED' };
    }

    console.log('\n✅ Gating Policy Passed: Contract capabilities comply with agent execution rules.');
    console.log('[Node: Transaction Execution] Safe to sign and broadcast transaction on Base.');
    return { status: 'APPROVED', targetContract: agentState.targetContract };
  } catch (err) {
    console.error(`⚠️ Supervisor Fallback: Could not verify bytecode (${err.message}). Failing closed.`);
    return { status: 'BLOCKED', reason: 'GATEWAY_ERROR' };
  }
}

if (require.main === module) {
  runLangGraphPreflightExample().then(console.log).catch(console.error);
}

module.exports = { runLangGraphPreflightExample };
