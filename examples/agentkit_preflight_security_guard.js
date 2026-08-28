'use strict';

/**
 * 🛡️ M2M Sentinel + Coinbase AgentKit — Pre-Signing Preflight Guard
 *
 * Demonstrates how an autonomous agent inspects target contract bytecode,
 * resolves EIP-1967/UUPS proxy implementations, and applies a caller-defined
 * execution policy before submitting transactions to the Base blockchain.
 */

const { m2mSentinelActionProvider } = require('../public/sdk/index.js');

// Public contract address used for demonstration:
const VERIFIED_BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

async function main() {
  console.log('================================================================');
  console.log('🤖 COINBASE AGENTKIT — AUTONOMOUS PREFLIGHT SECURITY GUARD');
  console.log('================================================================\n');

  // 1. Instantiate the M2M Sentinel Action Provider
  const sentinel = m2mSentinelActionProvider({
    baseUrl: 'https://api.m2msentinel.com'
  });

  console.log('✅ Action Provider initialized:', sentinel.name);
  console.log('✅ Supported Networks: Base Mainnet (8453)\n');

  // 2. Scenario A: Inspecting a canonical Base contract (Base USDC)
  console.log(`[Scenario A] Inspecting canonical contract: ${VERIFIED_BASE_USDC}...`);
  const auditAction = sentinel.getActions().find(a => a.name === 'm2m_audit_contract');

  if (!auditAction) {
    throw new Error('Audit action not found in Action Provider');
  }

  const resultStr = await auditAction.invoke({ address: VERIFIED_BASE_USDC });
  const result = JSON.parse(resultStr);

  console.log('⚡ Preflight Audit Result:');
  console.log(`   • Analysis Mode:      ${result.analysisKind || 'STATIC_BYTECODE_CAPABILITY_HEURISTIC'}`);
  console.log(`   • Is Proxy:           ${result.proxyResolution ? result.proxyResolution.isProxy : (result.proxy ? result.proxy.isProxy : false)}`);
  console.log(`   • Implementation:     ${result.proxyResolution ? result.proxyResolution.targetAddress : (result.proxy ? result.proxy.implementation : 'N/A')}`);
  console.log(`   • Trust Level:        ${result.provenance ? result.provenance.trustLevel : 'HIGH'}`);
  console.log('   ℹ️  Observation complete; the caller still owns the execution policy.\n');

  // 3. Scenario B: Preflight Gating Logic for Autonomous Agents
  console.log('[Scenario B] Example Caller-Defined Execution Policy:');

  function callerPolicy(audit) {
    if (!audit || audit.notASafetyGuarantee !== true) {
      return { allow: false, reason: 'MISSING_CAPABILITY_OBSERVATION_SEMANTICS' };
    }
    if (audit.evidenceGrade !== true) {
      return { allow: false, reason: 'EVIDENCE_NOT_DECISION_GRADE' };
    }
    const proxy = audit.proxyResolution || audit.proxy;
    if (proxy && proxy.isProxy) {
      const impl = proxy.targetAddress || proxy.implementation;
      if (!impl || impl === '0x0000000000000000000000000000000000000000') {
        return { allow: false, reason: 'PROXY_RESOLUTION_INCOMPLETE' };
      }
    }
    return { allow: true, reason: 'CALLER_POLICY_PASSED_FOR_THIS_EXAMPLE' };
  }

  const evaluation = callerPolicy(result);
  console.log(`   • Policy Check: ${evaluation.allow ? 'PASSED' : 'BLOCKED'} (${evaluation.reason})`);
  console.log('   ℹ️  This policy result is not a safety, exploitability, or maliciousness claim.');
  console.log('================================================================');
  console.log('🎉 Preflight capability-policy demo executed successfully with 0 errors.');
  console.log('================================================================');
}

main().catch(err => {
  console.error('Execution error:', err);
  process.exit(1);
});
