/**
 * Executable Example: DEX Swap Preflight Observation (W36-005)
 *
 * Demonstrates pre-transaction bytecode observation using M2M Sentinel. The
 * caller must apply its own execution policy to the returned evidence.
 */

function capabilityNames(audit) {
  if (Array.isArray(audit.verdict?.executableCapabilities)) {
    return audit.verdict.executableCapabilities;
  }
  return (audit.dissection?.capabilities || [])
    .map((capability) => typeof capability === 'string' ? capability : capability?.type)
    .filter(Boolean);
}

async function preflightCheck(address, baseUrl = 'https://api.m2msentinel.com', fetchImpl = fetch) {
  console.log(`🔍 Inspecting target contract on Base: ${address}`);
  const url = `${baseUrl}/v1/demo/audit/${address}`;
  const response = await fetchImpl(url);
  
  if (!response.ok) {
    throw new Error(`M2M Sentinel query failed: HTTP ${response.status}`);
  }

  const data = await response.json();
  const audit = data.audit || data;
  const capabilities = capabilityNames(audit);
  const proxy = audit.proxyResolution || {};
  console.log(`  Analysis Kind: ${audit.analysisKind}`);
  console.log(`  Trust Level: ${audit.provenance?.trustLevel || 'NOT_REPORTED'}`);
  console.log(`  Observed Capabilities: [${capabilities.join(', ')}]`);
  console.log(`  Reachability: ${audit.reachability || 'NOT_ESTABLISHED'}`);
  
  if (proxy.isProxy) {
    console.log(`  Proxy Detected: ${proxy.proxyType}`);
    console.log(`  Resolved Target: ${proxy.targetAddress || 'UNRESOLVED'}`);
  } else {
    console.log('  Proxy Pattern: None observed');
  }

  console.log('  Policy Notice: Apply a caller-defined execution policy; these observations are not a safety guarantee.');

  return data;
}

if (require.main === module) {
  const target = process.argv[2] || '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'; // USDC
  preflightCheck(target)
    .then(() => console.log('\nPreflight observation completed.'))
    .catch(console.error);
}

module.exports = { preflightCheck, capabilityNames };
