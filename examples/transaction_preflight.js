'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * First-party transaction preflight integration.
 *
 * The caller supplies the transaction, policy, and final signing/send
 * callback. M2M Sentinel supplies only block-pinned observations. This example
 * stops before the callback when evidence is not gradeable, the execution
 * target is unresolved, the observation block is inconsistent, or a Diamond
 * selector mapping is missing. It contains no signing secret.
 */

function resolvePublicSdkPath() {
  const candidates = [
    path.join(__dirname, '..', 'public', 'sdk', 'index.js'),
    path.join(__dirname, '..', 'index.js')
  ];
  const sdkPath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!sdkPath) throw new Error('The public M2M Sentinel client could not be found beside this example.');
  return sdkPath;
}

const { M2MSentinelClient } = require(resolvePublicSdkPath());

const DEFAULT_TRANSACTION = Object.freeze({
  chainId: 8453,
  to: '0x1111111111111111111111111111111111111111',
  data: '0x40c10f19',
  value: '0x0'
});

class PreflightBlockedError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PreflightBlockedError';
    this.code = code;
  }
}

function isAddress(value) {
  return typeof value === 'string' && /^0x[0-9a-f]{40}$/i.test(value);
}

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

class PreflightInputError extends TypeError {
  constructor(field, message) {
    super(`${field}: ${message}`);
    this.name = 'PreflightInputError';
    this.code = 'INVALID_PREFLIGHT_INPUT';
    this.field = field;
  }
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function normalizeAddress(value, field) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new PreflightInputError(field, 'must be a 20-byte 0x-prefixed hexadecimal address');
  }
  return value.toLowerCase();
}

function parseInputQuantity(value, field, maximum) {
  let parsed;
  if (typeof value === 'bigint') {
    parsed = value;
  } else if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new PreflightInputError(field, 'must be a non-negative safe integer or canonical quantity');
    }
    parsed = BigInt(value);
  } else if (typeof value === 'string') {
    const isHexQuantity = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value);
    const isDecimalQuantity = /^(?:0|[1-9][0-9]*)$/.test(value);
    if (!isHexQuantity && !isDecimalQuantity) {
      throw new PreflightInputError(field, 'must be a canonical decimal integer or 0x-prefixed quantity');
    }
    try {
      parsed = BigInt(value);
    } catch (_) {
      throw new PreflightInputError(field, 'is not a valid integer');
    }
  } else {
    throw new PreflightInputError(field, 'must be a non-negative integer');
  }

  if (parsed < 0n || parsed > maximum) {
    throw new PreflightInputError(field, 'is outside the supported integer range');
  }
  return parsed;
}

function quantityToHex(value) {
  return `0x${value.toString(16)}`;
}

function quantityToOutput(value) {
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString(10);
}

function normalizeData(value) {
  const maxDataBytes = 128 * 1024;
  if (typeof value !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) {
    throw new PreflightInputError('data', 'must be an even-length 0x-prefixed hexadecimal byte string');
  }
  if ((value.length - 2) / 2 > maxDataBytes) {
    throw new PreflightInputError('data', `must not exceed ${maxDataBytes} bytes`);
  }
  return value.toLowerCase();
}

function validateTransactionPreflightInput(input) {
  const maxQuantity = (2n ** 256n) - 1n;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new PreflightInputError('request', 'must be a JSON object');
  }

  const allowed = new Set(['chainId', 'to', 'data', 'from', 'value', 'blockNumber']);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new PreflightInputError(key, 'is not a supported field');
  }
  if (!hasOwn(input, 'chainId')) throw new PreflightInputError('chainId', 'is required and fixed to Base mainnet 8453');
  if (!hasOwn(input, 'to')) throw new PreflightInputError('to', 'is required');
  if (!hasOwn(input, 'data')) throw new PreflightInputError('data', 'is required');

  if (parseInputQuantity(input.chainId, 'chainId', maxQuantity) !== 8453n) {
    throw new PreflightInputError('chainId', 'must equal Base mainnet chain ID 8453');
  }

  const normalized = {
    chainId: 8453,
    to: normalizeAddress(input.to, 'to'),
    data: normalizeData(input.data)
  };
  if (hasOwn(input, 'from')) normalized.from = normalizeAddress(input.from, 'from');
  if (hasOwn(input, 'value')) normalized.value = quantityToHex(parseInputQuantity(input.value, 'value', maxQuantity));
  if (hasOwn(input, 'blockNumber')) normalized.blockNumber = quantityToOutput(parseInputQuantity(input.blockNumber, 'blockNumber', maxQuantity));
  return normalized;
}

function publicTransaction(value) {
  const normalized = validateTransactionPreflightInput(value);
  const output = {};
  for (const key of ['chainId', 'to', 'data', 'from', 'value', 'blockNumber']) {
    if (Object.prototype.hasOwnProperty.call(normalized, key)) output[key] = normalized[key];
  }
  return output;
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function parsedQuantity(value) {
  try {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
    if (typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/.test(value)) return BigInt(value);
    if (typeof value === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)) return BigInt(value);
  } catch (_) { /* handled by the caller as an observation mismatch */ }
  return null;
}

function isAffirmativePolicyResult(value) {
  if (value === true) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Object.keys(value);
  if (keys.some((key) => key !== 'allow' && key !== 'reason')) return false;
  return value.allow === true && (value.reason === undefined || typeof value.reason === 'string');
}

function assertObservationReady(observation, transaction) {
  if (!observation || observation.evidenceGrade !== true) {
    throw new PreflightBlockedError(
      'EVIDENCE_GRADE_FALSE',
      'The caller policy boundary stopped because evidenceGrade is not true.'
    );
  }

  const block = observation.observationBlock;
  const blockTag = block && block.blockTag;
  const blockNumber = block && block.blockNumber;
  const parsedBlock = typeof blockTag === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(blockTag)
    ? BigInt(blockTag)
    : null;
  let parsedBlockNumber = null;
  try {
    if (typeof blockNumber === 'number' && Number.isSafeInteger(blockNumber) && blockNumber >= 0) {
      parsedBlockNumber = BigInt(blockNumber);
    } else if (typeof blockNumber === 'string' && /^(?:0|[1-9][0-9]*)$/.test(blockNumber)) {
      parsedBlockNumber = BigInt(blockNumber);
    }
  } catch (_) {
    parsedBlockNumber = null;
  }
  if (!block || block.status !== 'PINNED' || parsedBlock === null || parsedBlockNumber === null || parsedBlock !== parsedBlockNumber ||
      typeof block.blockHash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(block.blockHash)) {
    throw new PreflightBlockedError(
      'OBSERVATION_MISMATCH',
      'The caller policy boundary stopped because the observation block is missing or internally inconsistent.'
    );
  }

  let expectedTransaction;
  let observedTransaction;
  try {
    expectedTransaction = publicTransaction(transaction);
    observedTransaction = publicTransaction(observation.request);
  } catch (_) {
    throw new PreflightBlockedError(
      'OBSERVATION_MISMATCH',
      'The caller policy boundary stopped because the response request is missing or malformed.'
    );
  }
  if (!sameJson(expectedTransaction, observedTransaction) ||
      observation.selectorHex !== (expectedTransaction.data.length >= 10
        ? expectedTransaction.data.slice(0, 10).toLowerCase()
        : null)) {
    throw new PreflightBlockedError(
      'OBSERVATION_MISMATCH',
      'The caller policy boundary stopped because the observation is not bound to the exact requested transaction.'
    );
  }
  if (expectedTransaction.blockNumber !== undefined && parsedBlockNumber !== parsedQuantity(expectedTransaction.blockNumber)) {
    throw new PreflightBlockedError(
      'OBSERVATION_MISMATCH',
      'The caller policy boundary stopped because the observation block does not match the explicitly requested block.'
    );
  }

  const target = typeof transaction?.to === 'string' ? transaction.to.toLowerCase() : null;
  if (!isAddress(target) || observation.surfaceTarget !== target ||
      !isAddress(observation.resolvedExecutionTarget) ||
      observation.resolution?.resolutionComplete !== true) {
    throw new PreflightBlockedError(
      'EXECUTION_TARGET_UNRESOLVED',
      'The caller policy boundary stopped because the resolved execution target is incomplete.'
    );
  }

  if (observation.simulationObservation?.attempted === true &&
      parsedQuantity(observation.simulationObservation.blockTag) !== parsedBlock) {
    throw new PreflightBlockedError(
      'OBSERVATION_MISMATCH',
      'The caller policy boundary stopped because simulation and state observations use different blocks.'
    );
  }

  if (observation.resolution?.proxyType === 'EIP2535_DIAMOND') {
    const selector = observation.selectorHex;
    const diamond = observation.resolution.diamond;
    const selectedFacet = diamond?.selectedFacet;
    const selected = Array.isArray(diamond?.facets)
      ? diamond.facets.find((facet) => facet.address === selectedFacet)
      : null;
    if (!selector || !isAddress(selectedFacet) || !selected || !selected.selectors?.includes(selector)) {
      throw new PreflightBlockedError(
        'DIAMOND_FACET_MAPPING_MISSING',
        'The caller policy boundary stopped because the supplied selector has no complete Diamond facet mapping.'
      );
    }
  }
}

async function preflightBeforeSigning({ client, transaction, policy, signAndSend }) {
  if (!client || typeof client.preflightTransaction !== 'function') {
    throw new TypeError('A client with preflightTransaction(transaction) is required.');
  }
  if (typeof policy !== 'function') {
    throw new TypeError('A caller-owned policy function is required.');
  }
  if (typeof signAndSend !== 'function') {
    throw new TypeError('A caller-owned signing/send callback is required.');
  }

  // Normalize and copy before the first await. The client and policy are
  // caller-owned async code; neither may change the request that is later
  // handed to the signing callback.
  const checkedTransaction = publicTransaction(transaction);
  const observation = await client.preflightTransaction(cloneJson(checkedTransaction));
  const checkedObservation = cloneJson(observation);
  assertObservationReady(checkedObservation, checkedTransaction);

  // M2M Sentinel does not decide whether to proceed. The application owns
  // this policy and receives the complete observation as its input.
  const policyResult = await policy(cloneJson(checkedObservation), {
    transaction: cloneJson(checkedTransaction)
  });
  if (!isAffirmativePolicyResult(policyResult)) {
    const reason = policyResult && policyResult.reason
      ? policyResult.reason
      : 'caller-owned policy did not return true or { allow: true }';
    throw new PreflightBlockedError('CALLER_POLICY_REJECTED', reason);
  }

  return signAndSend(cloneJson(checkedTransaction), cloneJson(checkedObservation));
}

function mockObservation(transaction = DEFAULT_TRANSACTION) {
  const blockTag = '0x1';
  return {
    status: 'SUCCESS',
    operation: 'TRANSACTION_PREFLIGHT_OBSERVATION',
    request: { ...transaction },
    selectorHex: transaction.data.slice(0, 10).toLowerCase(),
    surfaceTarget: transaction.to.toLowerCase(),
    resolvedExecutionTarget: transaction.to.toLowerCase(),
    resolvedImplementation: null,
    resolvedFacet: null,
    resolution: {
      status: 'COMPLETE',
      resolutionComplete: true,
      proxyType: 'NONE',
      proxyTypes: [],
      reason: 'Mock direct execution observation.'
    },
    bytecodeHashes: {
      runtimeBytecodeHash: 'sha256:' + 'a'.repeat(64),
      finalTargetBytecodeHash: 'sha256:' + 'a'.repeat(64),
      facetBytecodeHash: null,
      facetBytecodeHashes: []
    },
    capabilityEvidence: null,
    simulationObservation: {
      attempted: true,
      outcome: 'SUCCEEDED',
      trusted: true,
      returnData: '0x',
      blockTag,
      evidenceOnly: true
    },
    evidenceGrade: true,
    evidenceStatus: 'VERIFIED',
    effectiveTrust: 'QUORUM_PUBLIC',
    observationBlock: {
      status: 'PINNED',
      chainId: 8453,
      network: 'eip155:8453',
      blockNumber: 1,
      blockHash: '0x' + '1'.repeat(64),
      blockTag,
      trustLevel: 'QUORUM_PUBLIC',
      providerName: 'mock',
      agreement: 2,
      sampled: 2,
      retrievedAt: new Date().toISOString(),
      originalRetrievalTime: new Date().toISOString()
    },
    notASafetyGuarantee: true,
    reachability: 'NOT_ESTABLISHED',
    limitations: ['Mock observation for integration wiring; caller policy remains authoritative.'],
    conclusion: null
  };
}

async function runExample() {
  const transaction = { ...DEFAULT_TRANSACTION };
  const live = process.env.M2M_SENTINEL_PREFLIGHT_LIVE === '1';
  if (live && !process.env.M2M_SENTINEL_API_KEY) {
    throw new Error('M2M_SENTINEL_API_KEY is required for optional live observation mode.');
  }
  const client = live
    ? new M2MSentinelClient({
      baseUrl: process.env.M2M_SENTINEL_BASE_URL || 'https://api.m2msentinel.com',
      // Header-authenticated only. The example accepts no signing secret.
      apiKey: process.env.M2M_SENTINEL_API_KEY
    })
    : { preflightTransaction: async () => mockObservation(transaction) };

  const result = await preflightBeforeSigning({
    client,
    transaction,
    policy: async (observation) => {
      console.log(`Caller policy received ${observation.selectorHex} at ${observation.observationBlock.blockTag}.`);
      return true;
    },
    signAndSend: async (_transaction, observation) => ({
      status: 'CALLER_CALLBACK_READY',
      sent: false,
      observationBlock: observation.observationBlock.blockNumber,
      note: 'Replace this callback with the integrator-owned signer/send operation.'
    })
  });

  console.log(JSON.stringify(result, null, 2));
  return result;
}

if (require.main === module) {
  runExample().catch((error) => {
    console.error(`${error.code || 'PREFLIGHT_ERROR'}: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_TRANSACTION,
  PreflightInputError,
  PreflightBlockedError,
  isAffirmativePolicyResult,
  resolvePublicSdkPath,
  validateTransactionPreflightInput,
  publicTransaction,
  assertObservationReady,
  preflightBeforeSigning,
  mockObservation,
  runExample
};
