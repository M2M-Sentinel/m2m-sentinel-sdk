'use strict';

/**
 * M2M Sentinel + LangGraph Preflight Supervisor Workflow
 *
 * Demonstrates a caller-owned policy node in a LangGraph execution graph on
 * Base (Chain ID 8453). M2M Sentinel supplies observations; the application
 * supplies the transaction policy.
 */

const { M2MSentinelClient } = require('../../public/sdk/index.js');

async function runLangGraphPreflightExample(policy, options = {}) {
  if (typeof policy !== 'function') {
    throw new TypeError('A caller-defined policy function is required.');
  }
  console.log('🤖 Initializing LangGraph Autonomous Preflight Supervisor...');

  const sentinel = options.client || new M2MSentinelClient({
    baseUrl: process.env.M2M_SENTINEL_BASE_URL || 'https://api.m2msentinel.com',
    apiKey: process.env.M2M_SENTINEL_API_KEY || ''
  });

  // Simulated agent intent proposing interaction with USDC on Base
  const agentState = {
    proposedAction: 'SWAP',
    targetContract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC on Base
    amountUsd: 250.0,
    policyContext: { transactionKind: 'SWAP', amountUsd: 250.0 }
  };

  console.log(`\n[Node: Preflight Supervisor] Auditing target contract: ${agentState.targetContract}`);
  
  try {
    const auditRes = await sentinel.auditContract(agentState.targetContract);
    const audit = auditRes.audit || {};
    const proxy = audit.proxyResolution || {};

    console.log(`Upstream Trust Level: ${audit.provenance?.trustLevel || 'NOT_REPORTED'}`);
    console.log(`Capability Rating: ${audit.capabilityRating || 'NOT_REPORTED'}`);
    console.log(`Is Proxy: ${Boolean(proxy.isProxy)} (${proxy.proxyType || 'NONE'})`);
    if (proxy.isProxy) {
      console.log(`Implementation Target: ${proxy.targetAddress || 'UNRESOLVED'}`);
    }

    const capabilities = audit.verdict?.executableCapabilities
      || (audit.dissection?.capabilities || []).map((capability) => capability.type);
    const policyResult = await policy({
      address: agentState.targetContract,
      capabilities,
      proxyResolution: proxy,
      provenance: audit.provenance,
      context: agentState.policyContext
    });
    if (!policyResult || typeof policyResult.accepted !== 'boolean') {
      throw new TypeError('Caller policy must return { accepted: boolean, reasons?: string[] }.');
    }

    console.log(`\nCaller policy result: ${policyResult.accepted ? 'ACCEPTED' : 'REJECTED'}`);
    return {
      status: 'POLICY_EVALUATED',
      policyAccepted: policyResult.accepted,
      reasons: Array.isArray(policyResult.reasons) ? policyResult.reasons : [],
      targetContract: agentState.targetContract,
      notASafetyGuarantee: true
    };
  } catch (err) {
    console.error(`Observation or policy evaluation failed: ${err.message}`);
    return { status: 'ERROR', reason: 'OBSERVATION_OR_POLICY_ERROR', notASafetyGuarantee: true };
  }
}

if (require.main === module) {
  const exampleCallerPolicy = ({ capabilities, proxyResolution }) => {
    const reasons = [];
    if (capabilities.includes('SELFDESTRUCT')) reasons.push('SELFDESTRUCT_CAPABILITY_PRESENT');
    if (proxyResolution.isProxy && !proxyResolution.targetAddress) reasons.push('PROXY_TARGET_UNRESOLVED');
    return { accepted: reasons.length === 0, reasons };
  };
  runLangGraphPreflightExample(exampleCallerPolicy).then(console.log).catch(console.error);
}

module.exports = { runLangGraphPreflightExample };
