'use strict';

const path = require('node:path');

// The exported SDK keeps this example runnable from either the source tree or
// the clean export root; both paths resolve only the public client surface.
let sdk;
try {
  sdk = require(path.join(__dirname, '..', 'public', 'sdk', 'index.js'));
} catch (_) {
  sdk = require(path.join(__dirname, '..', 'index.js'));
}

const {
  BASE_CHAIN_ID,
  guardWalletSendCalls
} = sdk;

const ACCOUNT = '0x8888888888888888888888888888888888888888';
const TARGET_A = '0x1111111111111111111111111111111111111111';
const TARGET_B = '0x2222222222222222222222222222222222222222';

const REQUEST = Object.freeze({
  method: 'wallet_sendCalls',
  params: [{
    version: '1.0',
    chainId: '0x2105',
    from: ACCOUNT,
    calls: [
      { to: TARGET_A, data: '0x40c10f19', value: '0x0' },
      { to: TARGET_B, data: '0x095ea7b3', value: '0x1' }
    ],
    capabilities: {
      paymasterService: { url: 'https://paymaster.example/' }
    }
  }]
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function observedBlockNumber(transaction) {
  if (transaction.blockNumber === undefined) return 1;
  const number = BigInt(transaction.blockNumber);
  return number <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(number) : number.toString(10);
}

function mockObservation(transaction) {
  const blockNumber = observedBlockNumber(transaction);
  const blockTag = `0x${BigInt(blockNumber).toString(16)}`;
  const normalizedTarget = transaction.to.toLowerCase();
  return {
    status: 'SUCCESS',
    operation: 'TRANSACTION_PREFLIGHT_OBSERVATION',
    request: clone(transaction),
    selectorHex: transaction.data.length >= 10 ? transaction.data.slice(0, 10).toLowerCase() : null,
    surfaceTarget: normalizedTarget,
    resolvedExecutionTarget: normalizedTarget,
    resolution: {
      status: 'COMPLETE',
      resolutionComplete: true,
      proxyType: 'NONE'
    },
    evidenceGrade: true,
    evidenceStatus: 'VERIFIED',
    effectiveTrust: 'QUORUM_PUBLIC',
    observationBlock: {
      status: 'PINNED',
      chainId: BASE_CHAIN_ID,
      network: 'eip155:8453',
      blockNumber,
      blockHash: '0x' + '1'.repeat(64),
      blockTag,
      trustLevel: 'QUORUM_PUBLIC'
    },
    simulationObservation: {
      attempted: true,
      outcome: 'SUCCEEDED',
      trusted: true,
      blockTag,
      evidenceOnly: true
    },
    bytecodeHashes: {
      runtimeBytecodeHash: 'sha256:' + 'a'.repeat(64),
      finalTargetBytecodeHash: 'sha256:' + 'b'.repeat(64),
      facetBytecodeHash: null,
      facetBytecodeHashes: []
    },
    capabilityEvidence: {
      sourceAddress: normalizedTarget,
      executionRole: 'RESOLVED_EXECUTING_CODE',
      transactionSelector: transaction.data.length >= 10 ? transaction.data.slice(0, 10).toLowerCase() : null,
      notASafetyGuarantee: true,
      reachability: 'NOT_ESTABLISHED',
      dissection: {
        isValidContract: true,
        bytecodeSizeBytes: 1,
        targetBytecodeHash: 'sha256:' + 'b'.repeat(64),
        capabilities: [],
        detectedCapabilities: []
      }
    },
    rpcObservation: {
      pinnedBlockTag: blockTag,
      stateBearingCallCount: 1,
      failedReadCount: 0,
      failures: [],
      calls: [{
        method: 'eth_getCode',
        params: [normalizedTarget, blockTag],
        blockTag,
        trustLevel: 'QUORUM_PUBLIC',
        status: 'OK'
      }]
    },
    notASafetyGuarantee: true,
    reachability: 'NOT_ESTABLISHED',
    limitations: ['Local fixture only; caller policy remains authoritative.'],
    conclusion: null
  };
}

async function runExample() {
  const approved = new Map([
    [TARGET_A.toLowerCase(), { selectorHex: '0x40c10f19', finalTargetBytecodeHash: 'sha256:' + 'b'.repeat(64) }],
    [TARGET_B.toLowerCase(), { selectorHex: '0x095ea7b3', finalTargetBytecodeHash: 'sha256:' + 'b'.repeat(64) }]
  ]);
  const client = {
    preflightTransaction: async (transaction) => mockObservation(transaction)
  };
  const provider = {
    request: async (request) => ({
      status: 'CALLER_PROVIDER_READY',
      sent: false,
      request
    })
  };
  const result = await guardWalletSendCalls({
    client,
    provider,
    request: REQUEST,
    policy: async (observation, context) => ({
      allow: observation.evidenceGrade === true && observation.simulationObservation.outcome === 'SUCCEEDED' &&
        context.transaction.from === ACCOUNT &&
        approved.get(observation.surfaceTarget.toLowerCase())?.selectorHex === observation.selectorHex &&
        approved.get(observation.surfaceTarget.toLowerCase())?.finalTargetBytecodeHash ===
          observation.bytecodeHashes.finalTargetBytecodeHash,
      reason: 'Local example policy accepted this exact target, selector, and execution hash.'
    })
  });
  return { status: 'BASE_ACCOUNT_PREFLIGHT_GATE_OK', providerResult: result };
}

if (require.main === module) {
  runExample()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      // Keep failure output bounded; never echo provider/API payloads or
      // caller-owned credential-bearing error messages.
      console.error(`${error.code || 'BASE_ACCOUNT_GUARD_ERROR'}: guarded request failed`);
      process.exitCode = 1;
    });
}

module.exports = {
  ACCOUNT,
  TARGET_A,
  TARGET_B,
  REQUEST,
  mockObservation,
  runExample
};
