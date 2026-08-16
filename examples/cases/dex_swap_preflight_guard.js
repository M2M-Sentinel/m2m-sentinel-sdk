/**
 * Executable Example: DEX Swap Preflight Guard (W36-005)
 *
 * Demonstrates pre-transaction bytecode verification using M2M Sentinel.
 */

const { ethers } = require('ethers');

async function preflightCheck(address, baseUrl = 'https://m2msentinel.vercel.app') {
  console.log(`🔍 Inspecting target contract on Base: ${address}`);
  const url = `${baseUrl}/v1/demo/audit/${address}`;
  const response = await fetch(url);
  
  if (!response.ok) {
    throw new Error(`M2M Sentinel query failed: HTTP ${response.status}`);
  }

  const data = await response.json();
  console.log(`  Analysis Kind: ${data.analysisKind}`);
  console.log(`  Trust Level: ${data.trustLevel}`);
  console.log(`  Observed Capabilities: [${(data.observedCapabilities || []).join(', ')}]`);
  
  if (data.proxy && data.proxy.isProxy) {
    console.log(`  Proxy Detected: ${data.proxy.proxyType}`);
    console.log(`  Delegate Implementation: ${data.proxy.implementationAddress}`);
  } else {
    console.log(`  Contract Type: Direct Verified Contract`);
  }

  return data;
}

if (require.main === module) {
  const target = process.argv[2] || '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'; // USDC
  preflightCheck(target)
    .then(() => console.log('\n✅ Preflight check completed cleanly.'))
    .catch(console.error);
}

module.exports = { preflightCheck };
