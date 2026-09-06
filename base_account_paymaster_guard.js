'use strict';

/**
 * Customer-owned Base Account wallet_sendCalls execution-identity boundary.
 *
 * This module is intentionally an adapter around the public SDK client. It
 * observes each top-level wallet call, requires a caller-owned affirmative
 * policy for every observation, and only then forwards the original detached
 * JSON request to the caller's EIP-1193 provider. It is not a signer,
 * bundler, paymaster, custody layer, or execution simulator.
 *
 * The accepted envelope is a deliberately restricted, fully specified
 * EIP-5792 subset: version `1.0`, canonical wallet chainId `0x2105`, explicit
 * `from`, and explicit `to`/`data` for every call. `atomicRequired` remains optional for
 * compatibility with Base Account sponsor-gas clients; optional call values
 * use canonical 0x quantities and are never rewritten for the provider.
 */

const BASE_CHAIN_ID = 8453;
const BASE_CHAIN_HEX = '0x2105';
const BASE_NETWORK = 'eip155:8453';
const MAX_UINT256 = (2n ** 256n) - 1n;
const MAX_CALLS = 128;
const MAX_PREFLIGHT_CONCURRENCY = 4;
const MAX_RPC_OBSERVATION_CALLS = 4096;
const MAX_ID_BYTES = 4096;
const MAX_DATA_BYTES = 128 * 1024;
const MAX_DISSECTION_BYTECODE_BYTES = 2 * 1024 * 1024;
const MAX_JSON_DEPTH = 24;
const MAX_JSON_NODES = 8192;

const ADDRESS_RE = /^0x[0-9a-f]{40}$/i;
const DATA_RE = /^0x(?:[0-9a-f]{2})*$/i;
const BLOCK_HASH_RE = /^0x[0-9a-f]{64}$/i;
const BYTECODE_HASH_RE = /^sha256:[0-9a-f]{64}$/i;
const BLOCK_TAG_RE = /^0x(?:0|[1-9a-f][0-9a-f]*)$/i;
const SIMULATION_OUTCOMES = new Set(['NOT_ATTEMPTED', 'SUCCEEDED', 'REVERTED', 'UNAVAILABLE', 'MALFORMED']);
const RPC_STATE_BEARING_METHODS = new Set(['eth_getCode', 'eth_getStorageAt', 'eth_call']);
const RPC_ALLOWED_METHODS = new Set(RPC_STATE_BEARING_METHODS);
const RPC_ALLOWED_STATUSES = new Set(['OK', 'UNSUPPORTED_OPTIONAL_METHOD', 'EXECUTION_ERROR']);
const DIAMOND_FACETS_SELECTOR = '0x7a0ed627';
const DIAMOND_LOUPE_SUPPORTS_INTERFACE_DATA = `0x01ffc9a7${'48e2b093'.padStart(64, '0')}`;
const CAPABILITY_EXECUTION_ROLES = new Set(['RESOLVED_EXECUTING_CODE', 'SELECTED_DIAMOND_FACET']);
// These are public response trust labels, not private engine imports.
const TRUSTED_LEVELS = new Set(['HIGH_TRUST_PRIMARY', 'QUORUM_PUBLIC']);
const REQUEST_FIELDS = new Set(['method', 'params']);
const PARAM_FIELDS = new Set(['version', 'id', 'from', 'chainId', 'atomicRequired', 'calls', 'capabilities']);
const CALL_FIELDS = new Set(['to', 'data', 'value', 'capabilities', 'flowControl']);
const TRANSACTION_FIELDS = new Set(['chainId', 'to', 'data', 'from', 'value', 'blockNumber']);

class WalletSendCallsInputError extends TypeError {
  constructor(field, message) {
    super(`${field}: ${message}`);
    this.name = 'WalletSendCallsInputError';
    this.code = 'INVALID_WALLET_SEND_CALLS_INPUT';
    this.field = field;
  }
}

class ExecutionIdentityBlockedError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ExecutionIdentityBlockedError';
    this.code = code;
  }
}

// Short aliases retain the naming used by existing single-call examples.
const PreflightInputError = WalletSendCallsInputError;
const PreflightBlockedError = ExecutionIdentityBlockedError;

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isPlainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype === null) return true;
  // Accept cross-realm ordinary objects (whose Object.prototype identity is
  // different) while rejecting Object.create({ ... }) and class instances.
  return Object.getPrototypeOf(prototype) === null && hasOwn(prototype, 'constructor') &&
    typeof prototype.constructor === 'function' && prototype.constructor.name === 'Object';
}

function failInput(field, message) {
  throw new WalletSendCallsInputError(field, message);
}

function assertJsonValue(value, field, state, depth = 0) {
  if (depth > MAX_JSON_DEPTH) failInput(field, 'is nested too deeply');
  state.nodes += 1;
  if (state.nodes > MAX_JSON_NODES) failInput(field, 'contains too many nested values');

  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) failInput(field, 'must contain only finite JSON numbers');
    return;
  }
  if (typeof value !== 'object' || (!isPlainRecord(value) && !Array.isArray(value))) {
    failInput(field, 'must contain only JSON-compatible values');
  }
  if (state.stack.has(value)) failInput(field, 'must not contain circular references');
  state.stack.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!hasOwn(value, index)) failInput(`${field}[${index}]`, 'must not contain sparse entries');
      assertJsonValue(value[index], `${field}[${index}]`, state, depth + 1);
    }
  } else {
    for (const key of Object.keys(value)) {
      if (value[key] === undefined) failInput(`${field}.${key}`, 'must not be undefined');
      assertJsonValue(value[key], `${field}.${key}`, state, depth + 1);
    }
  }
  state.stack.delete(value);
}

function cloneJson(value, field = 'request') {
  const state = { nodes: 0, stack: new Set() };
  assertJsonValue(value, field, state);
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) failInput(field, 'must be JSON serializable');
    return JSON.parse(encoded);
  } catch (error) {
    if (error instanceof WalletSendCallsInputError) throw error;
    failInput(field, 'must be JSON serializable');
  }
}

function parseQuantity(value, field, options = {}) {
  let parsed;
  if (typeof value === 'bigint') {
    parsed = value;
  } else if (typeof value === 'number' && options.allowNumber !== false) {
    if (!Number.isSafeInteger(value) || value < 0) {
      failInput(field, 'must be a non-negative safe integer or canonical quantity');
    }
    parsed = BigInt(value);
  } else if (typeof value === 'string') {
    const hex = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value);
    const decimal = /^(?:0|[1-9][0-9]*)$/.test(value);
    if (!hex && !decimal) failInput(field, 'must be a canonical decimal integer or 0x-prefixed quantity');
    try {
      parsed = BigInt(value);
    } catch (_) {
      failInput(field, 'is not a valid integer');
    }
  } else {
    failInput(field, 'must be a non-negative integer');
  }
  if (parsed < 0n || parsed > MAX_UINT256) failInput(field, 'is outside the supported integer range');
  return parsed;
}

function parseChainId(value, field = 'chainId') {
  if (parseQuantity(value, field) !== BigInt(BASE_CHAIN_ID)) {
    failInput(field, `must identify Base mainnet (${BASE_CHAIN_HEX} / ${BASE_CHAIN_ID})`);
  }
  return BASE_CHAIN_ID;
}

function normalizeAddress(value, field) {
  if (typeof value !== 'string' || !ADDRESS_RE.test(value)) {
    failInput(field, 'must be a 20-byte 0x-prefixed hexadecimal address');
  }
  return value.toLowerCase();
}

function validateData(value, field) {
  if (typeof value !== 'string' || !DATA_RE.test(value)) {
    failInput(field, 'must be an even-length 0x-prefixed hexadecimal byte string');
  }
  if ((value.length - 2) / 2 > MAX_DATA_BYTES) failInput(field, `must not exceed ${MAX_DATA_BYTES} bytes`);
}

function utf8ByteLength(value) {
  if (typeof TextEncoder === 'function') return new TextEncoder().encode(value).length;
  let length = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) length += 1;
    else if (code <= 0x7ff) length += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length &&
      value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) {
      length += 4;
      index += 1;
    } else length += 3;
  }
  return length;
}

function validateId(value, field) {
  if (typeof value !== 'string' || value.length === 0 || utf8ByteLength(value) > MAX_ID_BYTES) {
    failInput(field, `must be a non-empty string of at most ${MAX_ID_BYTES} UTF-8 bytes`);
  }
}

function validateCapabilityRecord(value, field) {
  if (!isPlainRecord(value)) failInput(field, 'must be an object');
  for (const [name, capability] of Object.entries(value)) {
    if (!isPlainRecord(capability)) failInput(`${field}.${name}`, 'must be an object');
    if (hasOwn(capability, 'optional') && typeof capability.optional !== 'boolean') {
      failInput(`${field}.${name}.optional`, 'must be boolean when supplied');
    }
  }
  if (hasOwn(value, 'paymasterService')) {
    const paymaster = value.paymasterService;
    if (!isPlainRecord(paymaster) || typeof paymaster.url !== 'string') {
      failInput(`${field}.paymasterService`, 'must contain a URL string');
    }
    let url;
    try {
      url = new URL(paymaster.url);
    } catch (_) {
      failInput(`${field}.paymasterService.url`, 'must be a valid HTTPS URL');
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      failInput(`${field}.paymasterService.url`, 'must be an HTTPS URL without embedded credentials or query values');
    }
  }
}

function validateCall(call, index) {
  const field = `params[0].calls[${index}]`;
  if (!isPlainRecord(call)) failInput(field, 'must be an object');
  for (const key of Object.keys(call)) {
    if (!CALL_FIELDS.has(key)) failInput(`${field}.${key}`, 'is not a supported wallet_sendCalls field');
  }
  if (!hasOwn(call, 'to')) failInput(`${field}.to`, 'is required for transaction preflight');
  if (!hasOwn(call, 'data')) failInput(`${field}.data`, 'is required for transaction preflight');
  normalizeAddress(call.to, `${field}.to`);
  validateData(call.data, `${field}.data`);
  if (hasOwn(call, 'value')) {
    if (typeof call.value !== 'string' || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(call.value)) {
      failInput(`${field}.value`, 'must be a canonical 0x-prefixed quantity when supplied');
    }
    parseQuantity(call.value, `${field}.value`);
  }
  if (hasOwn(call, 'capabilities')) validateCapabilityRecord(call.capabilities, `${field}.capabilities`);
  if (hasOwn(call, 'flowControl') && !isPlainRecord(call.flowControl)) {
    failInput(`${field}.flowControl`, 'must be an object');
  }
}

/** Return a detached, exact provider request after validating the documented shape. */
function validateWalletSendCallsRequest(request) {
  if (!isPlainRecord(request)) failInput('request', 'must be an object');
  for (const key of Object.keys(request)) {
    if (!REQUEST_FIELDS.has(key)) failInput(`request.${key}`, 'is not a supported EIP-1193 field');
  }
  if (request.method !== 'wallet_sendCalls') failInput('request.method', 'must equal wallet_sendCalls');
  if (!Array.isArray(request.params) || request.params.length !== 1) {
    failInput('request.params', 'must contain exactly one wallet_sendCalls parameter object');
  }

  const params = request.params[0];
  if (!isPlainRecord(params)) failInput('params[0]', 'must be an object');
  for (const key of Object.keys(params)) {
    if (!PARAM_FIELDS.has(key)) failInput(`params[0].${key}`, 'is not a supported wallet_sendCalls field');
  }
  if (params.version !== '1.0') {
    failInput('params[0].version', 'must be the documented wallet_sendCalls version 1.0');
  }
  if (!hasOwn(params, 'chainId')) failInput('params[0].chainId', 'is required');
  if (params.chainId !== BASE_CHAIN_HEX) {
    failInput('params[0].chainId', 'must be the canonical Base mainnet wallet value 0x2105');
  }
  if (!hasOwn(params, 'from')) failInput('params[0].from', 'is required so execution identity is explicit');
  normalizeAddress(params.from, 'params[0].from');
  if (hasOwn(params, 'id')) validateId(params.id, 'params[0].id');
  if (hasOwn(params, 'atomicRequired') && typeof params.atomicRequired !== 'boolean') {
    failInput('params[0].atomicRequired', 'must be boolean when supplied');
  }
  if (!Array.isArray(params.calls) || params.calls.length === 0) failInput('params[0].calls', 'must be a non-empty array');
  if (params.calls.length > MAX_CALLS) failInput('params[0].calls', `must contain at most ${MAX_CALLS} calls`);
  for (let index = 0; index < params.calls.length; index += 1) validateCall(params.calls[index], index);
  if (hasOwn(params, 'capabilities')) validateCapabilityRecord(params.capabilities, 'params[0].capabilities');
  return cloneJson(request);
}

const normalizeWalletSendCallsRequest = validateWalletSendCallsRequest;

function transactionFromCall(params, call, index) {
  if (!params || !call) failInput(`calls[${index}]`, 'must be present');
  const transaction = {
    chainId: params.chainId,
    from: params.from,
    to: call.to,
    data: call.data
  };
  if (hasOwn(call, 'value')) transaction.value = call.value;
  return transaction;
}

function toPreflightTransaction(params, call, index) {
  return transactionFromCall(params, call, index);
}

function parseObservedQuantity(value) {
  try {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
    if (typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/.test(value)) return BigInt(value);
    if (typeof value === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)) return BigInt(value);
  } catch (_) { /* treated as an observation mismatch */ }
  return null;
}

function quantityToHex(value) {
  return `0x${value.toString(16)}`;
}

function quantityToInput(value) {
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : quantityToHex(value);
}

function normalizeAddressForObservation(value, field) {
  if (typeof value !== 'string' || !ADDRESS_RE.test(value)) throw new Error(`${field} is not an address`);
  return value.toLowerCase();
}

function normalizeDataForObservation(value, field) {
  if (typeof value !== 'string' || !DATA_RE.test(value) || (value.length - 2) / 2 > MAX_DATA_BYTES) {
    throw new Error(`${field} is not valid calldata`);
  }
  return value.toLowerCase();
}

function canonicalTransaction(value, field = 'transaction') {
  if (!isPlainRecord(value)) throw new Error(`${field} is not an object`);
  for (const key of Object.keys(value)) {
    if (!TRANSACTION_FIELDS.has(key)) throw new Error(`${field}.${key} is unsupported`);
  }
  if (!hasOwn(value, 'chainId') || !hasOwn(value, 'to') || !hasOwn(value, 'data')) {
    throw new Error(`${field} is missing a required field`);
  }
  if (parseObservedQuantity(value.chainId) !== BigInt(BASE_CHAIN_ID)) throw new Error(`${field}.chainId is not Base`);
  const normalized = {
    chainId: BASE_CHAIN_ID,
    to: normalizeAddressForObservation(value.to, `${field}.to`),
    data: normalizeDataForObservation(value.data, `${field}.data`)
  };
  if (hasOwn(value, 'from')) normalized.from = normalizeAddressForObservation(value.from, `${field}.from`);
  if (hasOwn(value, 'value')) normalized.value = quantityToHex(parseObservedQuantity(value.value));
  if (hasOwn(value, 'blockNumber')) {
    const blockNumber = parseObservedQuantity(value.blockNumber);
    if (blockNumber === null) throw new Error(`${field}.blockNumber is not a quantity`);
    normalized.blockNumber = quantityToHex(blockNumber);
  }
  return normalized;
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function blockParts(observation) {
  const block = observation && observation.observationBlock;
  const blockTag = block && block.blockTag;
  const parsedTag = typeof blockTag === 'string' && BLOCK_TAG_RE.test(blockTag) ? BigInt(blockTag) : null;
  const parsedNumber = parseObservedQuantity(block && block.blockNumber);
  return { block, blockTag, parsedTag, parsedNumber };
}

function blocked(code, message) {
  throw new ExecutionIdentityBlockedError(code, message);
}

function isAddressForObservation(value) {
  return typeof value === 'string' && ADDRESS_RE.test(value);
}

function isBoundedNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_RPC_OBSERVATION_CALLS;
}

function isKnownOptionalDiamondProbe(call) {
  if (call.method !== 'eth_call' || !Array.isArray(call.params) || !isPlainRecord(call.params[0])) return false;
  const transaction = call.params[0];
  if (!isAddressForObservation(transaction.to) || typeof transaction.data !== 'string') return false;
  const data = transaction.data.toLowerCase();
  return data === DIAMOND_FACETS_SELECTOR || data === DIAMOND_LOUPE_SUPPORTS_INTERFACE_DATA;
}

function isQualifiedExecutionRevert(call) {
  const evidence = call.failureEvidence;
  const evidenceFields = new Set(['sampledProviders', 'failures', 'counts', 'optionalRevertQualified', 'qualification']);
  const failureFields = new Set(['providerName', 'source', 'trustLevel', 'failureCode']);
  if (call.method !== 'eth_call' || !TRUSTED_LEVELS.has(call.trustLevel) ||
      typeof call.providerName !== 'string' || call.providerName.length === 0 ||
      call.providerName === 'NONE_AVAILABLE' || !isBoundedNonNegativeInteger(call.agreement) ||
      call.agreement < 1 || !isBoundedNonNegativeInteger(call.sampled) || call.sampled < call.agreement ||
      !isPlainRecord(evidence) || Object.keys(evidence).some((key) => !evidenceFields.has(key)) ||
      !hasOwn(evidence, 'optionalRevertQualified') || evidence.optionalRevertQualified !== true ||
      !hasOwn(evidence, 'qualification') ||
      !hasOwn(evidence, 'sampledProviders') || !hasOwn(evidence, 'failures') || !hasOwn(evidence, 'counts') ||
      !Array.isArray(evidence.sampledProviders) || evidence.sampledProviders.length !== call.sampled ||
      !evidence.sampledProviders.every((provider) => typeof provider === 'string' && provider.length > 0) ||
      !Array.isArray(evidence.failures) || evidence.failures.length !== call.agreement ||
      !evidence.failures.every((failure) => isPlainRecord(failure) &&
        Object.keys(failure).length === failureFields.size &&
        Object.keys(failure).every((key) => failureFields.has(key)) &&
        hasOwn(failure, 'providerName') && typeof failure.providerName === 'string' && failure.providerName.length > 0 &&
        hasOwn(failure, 'source') && hasOwn(failure, 'trustLevel') &&
        hasOwn(failure, 'failureCode') && failure.failureCode === 'OPTIONAL_EXECUTION_REVERT') ||
      !isPlainRecord(evidence.counts) || Object.keys(evidence.counts).length !== 1 ||
      !hasOwn(evidence.counts, 'OPTIONAL_EXECUTION_REVERT') ||
      evidence.counts.OPTIONAL_EXECUTION_REVERT !== call.agreement) {
    return false;
  }
  const failureNames = evidence.failures.map((failure) => failure.providerName);
  if (new Set(failureNames).size !== failureNames.length ||
      !failureNames.every((name, index) => name === evidence.sampledProviders[index])) {
    return false;
  }
  if (call.trustLevel === 'HIGH_TRUST_PRIMARY') {
    return call.agreement === 1 && call.sampled === 1 && call.providerName === failureNames[0] &&
      evidence.qualification === 'CREDENTIALLED_PROVIDER_REVERT' &&
      evidence.failures.every((failure) => failure.source === 'CREDENTIALED' &&
        failure.trustLevel === 'HIGH_TRUST_PRIMARY');
  }
  return call.agreement >= 2 && call.sampled === call.agreement &&
    call.providerName === failureNames.join('+') &&
    evidence.qualification === 'PUBLIC_REVERT_QUORUM' &&
    evidence.failures.every((failure) => failure.source === 'PUBLIC' &&
      failure.trustLevel === 'DEGRADED_LOW_TRUST');
}

function isLegacyUnsupportedOptionalProbe(call) {
  return isKnownOptionalDiamondProbe(call) && call.trustLevel === 'DEGRADED_LOW_TRUST' &&
    call.providerName === 'NONE_AVAILABLE' && call.agreement === 0 &&
    isBoundedNonNegativeInteger(call.sampled) && !hasOwn(call, 'failureEvidence');
}

/** Validate one complete public preflight response without making a safety claim. */
function assertObservationReady(observation, transaction) {
  if (!isPlainRecord(observation)) blocked('MALFORMED_OBSERVATION', 'The preflight response is not an object.');
  if (observation.evidenceGrade !== true || observation.evidenceStatus !== 'VERIFIED') {
    blocked('EVIDENCE_GRADE_FALSE', 'The preflight response is not decision-grade evidence.');
  }
  if (observation.status !== 'SUCCESS' || observation.operation !== 'TRANSACTION_PREFLIGHT_OBSERVATION') {
    blocked('MALFORMED_OBSERVATION', 'The preflight response is not a successful transaction observation.');
  }
  if (observation.notASafetyGuarantee !== true || observation.reachability !== 'NOT_ESTABLISHED' ||
      !Array.isArray(observation.limitations)) {
    blocked('MALFORMED_OBSERVATION', 'The preflight response did not preserve Sentinel observation limitations.');
  }
  if (hasOwn(observation, 'conclusion') && observation.conclusion !== null) {
    blocked('MALFORMED_OBSERVATION', 'The preflight response contains an unsupported conclusion.');
  }

  const { block, blockTag, parsedTag, parsedNumber } = blockParts(observation);
  if (!block || block.status !== 'PINNED' || block.network !== BASE_NETWORK ||
      parseObservedQuantity(block.chainId) !== BigInt(BASE_CHAIN_ID) ||
      parsedTag === null || parsedNumber === null || parsedTag !== parsedNumber ||
      typeof block.blockHash !== 'string' || !BLOCK_HASH_RE.test(block.blockHash)) {
    blocked('OBSERVATION_MISMATCH', 'The preflight block identity is missing or internally inconsistent.');
  }
  if (!TRUSTED_LEVELS.has(observation.effectiveTrust) || !TRUSTED_LEVELS.has(block.trustLevel)) {
    blocked('LOW_TRUST_OBSERVATION', 'The preflight response does not have a trusted Base observation level.');
  }
  if (observation.effectiveTrust === 'HIGH_TRUST_PRIMARY' && block.trustLevel !== 'HIGH_TRUST_PRIMARY') {
    blocked('OBSERVATION_MISMATCH', 'The effective trust cannot exceed the observation block trust.');
  }
  if (!isPlainRecord(observation.bytecodeHashes) ||
      typeof observation.bytecodeHashes.finalTargetBytecodeHash !== 'string' ||
      !BYTECODE_HASH_RE.test(observation.bytecodeHashes.finalTargetBytecodeHash)) {
    blocked('MALFORMED_OBSERVATION', 'The preflight response does not include a valid final target bytecode hash.');
  }

  let expectedTransaction;
  let observedTransaction;
  try {
    expectedTransaction = canonicalTransaction(transaction, 'transaction');
    observedTransaction = canonicalTransaction(observation.request, 'observation.request');
  } catch (_) {
    blocked('OBSERVATION_MISMATCH', 'The response request is missing or malformed.');
  }
  const expectedSelector = expectedTransaction.data.length >= 10
    ? expectedTransaction.data.slice(0, 10).toLowerCase()
    : null;
  if (!sameJson(expectedTransaction, observedTransaction) || observation.selectorHex !== expectedSelector ||
      typeof observation.surfaceTarget !== 'string' || observation.surfaceTarget.toLowerCase() !== expectedTransaction.to) {
    blocked('OBSERVATION_MISMATCH', 'The observation is not bound to the exact requested call.');
  }

  if (!isAddressForObservation(observation.resolvedExecutionTarget) ||
      !isPlainRecord(observation.resolution) || observation.resolution.status !== 'COMPLETE' ||
      observation.resolution.resolutionComplete !== true) {
    blocked('EXECUTION_TARGET_UNRESOLVED', 'The resolved execution target is incomplete.');
  }

  const simulation = observation.simulationObservation;
  if (!isPlainRecord(simulation) || simulation.attempted !== true || simulation.trusted !== true ||
      simulation.evidenceOnly !== true || !SIMULATION_OUTCOMES.has(simulation.outcome) ||
      typeof simulation.blockTag !== 'string' || !BLOCK_TAG_RE.test(simulation.blockTag) ||
      BigInt(simulation.blockTag) !== parsedTag) {
    blocked('OBSERVATION_MISMATCH', 'The simulation observation is missing or not pinned to the same block.');
  }

  const rpc = observation.rpcObservation;
  if (!isPlainRecord(rpc) || rpc.failedReadCount !== 0 || !Array.isArray(rpc.failures) ||
      rpc.failures.length !== 0 || !Number.isSafeInteger(rpc.stateBearingCallCount) ||
      rpc.stateBearingCallCount < 0 || rpc.stateBearingCallCount > MAX_RPC_OBSERVATION_CALLS ||
      !Array.isArray(rpc.calls) || rpc.calls.length > MAX_RPC_OBSERVATION_CALLS ||
      typeof rpc.pinnedBlockTag !== 'string' || !BLOCK_TAG_RE.test(rpc.pinnedBlockTag) ||
      BigInt(rpc.pinnedBlockTag) !== parsedTag) {
    blocked('OBSERVATION_MISMATCH', 'The RPC observation is missing, malformed, failed, or not pinned to the same block.');
  }
  let observedStateBearingCallCount = 0;
  for (let index = 0; index < rpc.calls.length; index += 1) {
    const call = rpc.calls[index];
    if (!isPlainRecord(call)) {
      blocked('MALFORMED_OBSERVATION', `The RPC observation call at index ${index} is not an object.`);
    }
    if (!hasOwn(call, 'method') || typeof call.method !== 'string' || call.method.length === 0) {
      blocked('MALFORMED_OBSERVATION', `The RPC observation call at index ${index} has an invalid method.`);
    }
    if (!RPC_ALLOWED_METHODS.has(call.method)) {
      blocked('MALFORMED_OBSERVATION', `The RPC observation call at index ${index} uses an unsupported method.`);
    }
    if (!hasOwn(call, 'params') || !Array.isArray(call.params)) {
      blocked('MALFORMED_OBSERVATION', `The RPC observation call at index ${index} has invalid params.`);
    }
    if (!hasOwn(call, 'blockTag')) {
      blocked('MALFORMED_OBSERVATION', `The RPC observation call at index ${index} is missing its block tag.`);
    }
    const stateBearing = RPC_STATE_BEARING_METHODS.has(call.method);
    if (stateBearing) observedStateBearingCallCount += 1;
    if (stateBearing) {
      if (typeof call.blockTag !== 'string' || !BLOCK_TAG_RE.test(call.blockTag) ||
          BigInt(call.blockTag) !== parsedTag) {
        blocked('OBSERVATION_MISMATCH', `The state-bearing RPC call at index ${index} is not pinned to the observation block.`);
      }
    } else if (call.blockTag !== null) {
      blocked('OBSERVATION_MISMATCH', `The non-state RPC call at index ${index} has an unexpected block tag.`);
    }
    if (!hasOwn(call, 'status') || typeof call.status !== 'string' || !RPC_ALLOWED_STATUSES.has(call.status)) {
      blocked('MALFORMED_OBSERVATION', `The RPC observation call at index ${index} has a failure status.`);
    }
    const qualifiedExecutionRevert = call.status === 'EXECUTION_ERROR' && isQualifiedExecutionRevert(call);
    const supportedOptionalAbsence = call.status === 'UNSUPPORTED_OPTIONAL_METHOD' &&
      isKnownOptionalDiamondProbe(call) &&
      (isQualifiedExecutionRevert(call) || isLegacyUnsupportedOptionalProbe(call));
    if (call.status === 'OK') {
      if (!hasOwn(call, 'trustLevel') || typeof call.trustLevel !== 'string' ||
          !TRUSTED_LEVELS.has(call.trustLevel) ||
          (observation.effectiveTrust === 'HIGH_TRUST_PRIMARY' && call.trustLevel !== 'HIGH_TRUST_PRIMARY')) {
        blocked('LOW_TRUST_OBSERVATION', `The RPC observation call at index ${index} is not trusted.`);
      }
    } else if (!qualifiedExecutionRevert && !supportedOptionalAbsence) {
      blocked('LOW_TRUST_OBSERVATION', `The non-success RPC observation call at index ${index} is not qualified evidence.`);
    } else if (qualifiedExecutionRevert && observation.effectiveTrust === 'HIGH_TRUST_PRIMARY' &&
        call.trustLevel !== 'HIGH_TRUST_PRIMARY') {
      blocked('OBSERVATION_MISMATCH', `The RPC observation call at index ${index} is weaker than the reported effective trust.`);
    }
    if (hasOwn(call, 'ok') && call.ok !== true) {
      blocked('MALFORMED_OBSERVATION', `The RPC observation call at index ${index} is not successful.`);
    }
    if (hasOwn(call, 'error') || hasOwn(call, 'failure') || hasOwn(call, 'hashBoundFailure') ||
        (hasOwn(call, 'failureEvidence') && !qualifiedExecutionRevert && !supportedOptionalAbsence)) {
      blocked('MALFORMED_OBSERVATION', `The RPC observation call at index ${index} contains failure evidence.`);
    }
  }
  if (rpc.stateBearingCallCount !== observedStateBearingCallCount) {
    blocked('OBSERVATION_MISMATCH', 'The RPC state-bearing call count does not match the recorded calls.');
  }

  const capabilityEvidence = observation.capabilityEvidence;
  if (!isPlainRecord(capabilityEvidence) ||
      capabilityEvidence.transactionSelector !== observation.selectorHex ||
      typeof capabilityEvidence.sourceAddress !== 'string' ||
      !isAddressForObservation(capabilityEvidence.sourceAddress) ||
      capabilityEvidence.sourceAddress.toLowerCase() !== observation.resolvedExecutionTarget.toLowerCase() ||
      !CAPABILITY_EXECUTION_ROLES.has(capabilityEvidence.executionRole) ||
      (observation.resolution.proxyType === 'EIP2535_DIAMOND'
        ? capabilityEvidence.executionRole !== 'SELECTED_DIAMOND_FACET'
        : capabilityEvidence.executionRole !== 'RESOLVED_EXECUTING_CODE') ||
      capabilityEvidence.notASafetyGuarantee !== true ||
      capabilityEvidence.reachability !== 'NOT_ESTABLISHED') {
    blocked('OBSERVATION_MISMATCH', 'Capability evidence is missing or not bound to the requested execution identity.');
  }
  const dissection = capabilityEvidence.dissection;
  if (!isPlainRecord(dissection) || dissection.isValidContract !== true ||
      !Number.isSafeInteger(dissection.bytecodeSizeBytes) || dissection.bytecodeSizeBytes < 0 ||
      dissection.bytecodeSizeBytes > MAX_DISSECTION_BYTECODE_BYTES ||
      typeof dissection.targetBytecodeHash !== 'string' ||
      !BYTECODE_HASH_RE.test(dissection.targetBytecodeHash) ||
      dissection.targetBytecodeHash.toLowerCase() !== observation.bytecodeHashes.finalTargetBytecodeHash.toLowerCase() ||
      !Array.isArray(dissection.capabilities) ||
      !dissection.capabilities.every((capability) => isPlainRecord(capability) &&
        typeof capability.type === 'string' && capability.type.length > 0) ||
      !Array.isArray(dissection.detectedCapabilities) ||
      !dissection.detectedCapabilities.every((capability) => typeof capability === 'string')) {
    blocked('MALFORMED_OBSERVATION', 'Capability evidence dissection is missing or malformed.');
  }

  if (observation.resolution.proxyType === 'EIP2535_DIAMOND') {
    const selector = observation.selectorHex;
    const diamond = observation.resolution.diamond;
    const selectedFacet = diamond && diamond.selectedFacet;
    const selected = diamond && Array.isArray(diamond.facets)
      ? diamond.facets.find((facet) => isPlainRecord(facet) &&
          typeof facet.address === 'string' && facet.address.toLowerCase() === String(selectedFacet).toLowerCase())
      : null;
    const selectedFacetHash = selected && selected.runtimeBytecodeHash;
    const facetBytecodeHash = observation.bytecodeHashes.facetBytecodeHash;
    const finalTargetBytecodeHash = observation.bytecodeHashes.finalTargetBytecodeHash;
    if (!selector || !isAddressForObservation(selectedFacet) ||
        selectedFacet.toLowerCase() !== observation.resolvedExecutionTarget.toLowerCase() ||
        !selected || !Array.isArray(selected.selectors) ||
        !selected.selectors.some((item) => typeof item === 'string' && item.toLowerCase() === selector) ||
        typeof selectedFacetHash !== 'string' || !BYTECODE_HASH_RE.test(selectedFacetHash) ||
        typeof facetBytecodeHash !== 'string' || !BYTECODE_HASH_RE.test(facetBytecodeHash) ||
        typeof finalTargetBytecodeHash !== 'string' || !BYTECODE_HASH_RE.test(finalTargetBytecodeHash) ||
        selectedFacetHash.toLowerCase() !== facetBytecodeHash.toLowerCase() ||
        selectedFacetHash.toLowerCase() !== finalTargetBytecodeHash.toLowerCase()) {
      blocked('DIAMOND_FACET_MAPPING_MISSING', 'The supplied selector has no complete Diamond facet mapping.');
    }
  }

  return {
    blockNumber: parsedNumber,
    blockTag: quantityToHex(parsedNumber),
    blockHash: block.blockHash.toLowerCase(),
    effectiveTrust: observation.effectiveTrust,
    blockTrustLevel: block.trustLevel,
    finalTargetBytecodeHash: observation.bytecodeHashes.finalTargetBytecodeHash.toLowerCase()
  };
}

function assertCoherentBatchIdentity(observation, anchor, index) {
  const identity = assertObservationIdentity(observation);
  if (identity.blockNumber !== anchor.blockNumber || identity.blockHash !== anchor.blockHash) {
    blocked('OBSERVATION_MISMATCH', `Call ${index} was observed at a different Base block identity.`);
  }
  if (identity.effectiveTrust !== anchor.effectiveTrust || identity.blockTrustLevel !== anchor.blockTrustLevel) {
    blocked('OBSERVATION_MISMATCH', `Call ${index} was observed at a different trust level.`);
  }
  return identity;
}

function assertObservationIdentity(observation) {
  const { block, parsedTag, parsedNumber } = blockParts(observation);
  if (!block || parsedTag === null || parsedNumber === null || parsedTag !== parsedNumber ||
      typeof block.blockHash !== 'string' || !BLOCK_HASH_RE.test(block.blockHash)) {
    blocked('OBSERVATION_MISMATCH', 'The preflight block identity is missing or internally inconsistent.');
  }
  return {
    blockNumber: parsedNumber,
    blockHash: block.blockHash.toLowerCase(),
    effectiveTrust: observation.effectiveTrust,
    blockTrustLevel: block.trustLevel
  };
}

function isAffirmativePolicyResult(value) {
  if (value === true) return true;
  if (!isPlainRecord(value)) return false;
  const keys = Object.keys(value);
  return hasOwn(value, 'allow') &&
    !keys.some((key) => key !== 'allow' && key !== 'reason') &&
    value.allow === true &&
    (!hasOwn(value, 'reason') || typeof value.reason === 'string');
}

function policyRejectionReason(value) {
  if (isPlainRecord(value) && hasOwn(value, 'reason') &&
      typeof value.reason === 'string' && value.reason.length > 0) {
    return value.reason.slice(0, 256);
  }
  return 'caller-owned policy did not return true or { allow: true }';
}

function assertClient(client) {
  if (!client || typeof client.preflightTransaction !== 'function') {
    throw new TypeError('A public client with preflightTransaction(transaction) is required.');
  }
}

function assertProvider(provider) {
  if (!provider || typeof provider.request !== 'function') {
    throw new TypeError('A caller-supplied EIP-1193 provider with request(request) is required.');
  }
}

async function preflightOne(client, transaction, index) {
  const response = await client.preflightTransaction(cloneJson(transaction, `calls[${index}]`));
  return cloneJson(response, `observations[${index}]`);
}

/**
 * Preflight the anchor, then process remaining calls in bounded waves anchored
 * to the same trusted block. Evaluate one explicit caller policy per call in
 * request order, and only then invoke the provider once.
 */
async function guardWalletSendCalls({ client, provider, request, policy, context } = {}) {
  assertClient(client);
  assertProvider(provider);
  if (typeof policy !== 'function') throw new TypeError('An explicit caller-owned policy function is required.');

  // Snapshot synchronously before any caller-owned asynchronous participant.
  const requestSnapshot = validateWalletSendCallsRequest(request);
  const paramsSnapshot = requestSnapshot.params[0];
  const transactions = paramsSnapshot.calls.map((call, index) => toPreflightTransaction(paramsSnapshot, call, index));

  let callerContext = {};
  if (context !== undefined) {
    callerContext = cloneJson(context, 'context');
    if (!isPlainRecord(callerContext)) throw new TypeError('context must be a JSON object when supplied.');
  }

  const preflightTransactions = transactions.slice();

  function policyContextFor(index) {
    return {
      ...cloneJson(callerContext, 'context'),
      callIndex: index,
      index,
      call: cloneJson(paramsSnapshot.calls[index], `params[0].calls[${index}]`),
      transaction: cloneJson(preflightTransactions[index], `calls[${index}]`),
      request: cloneJson(requestSnapshot, 'request'),
      params: cloneJson(paramsSnapshot, 'params[0]')
    };
  }

  async function evaluatePolicy(index, observation) {
    const policyResult = await policy(cloneJson(observation, `observations[${index}]`), policyContextFor(index));
    if (!isAffirmativePolicyResult(policyResult)) {
      blocked('CALLER_POLICY_REJECTED', `Call ${index} was rejected: ${policyRejectionReason(policyResult)}`);
    }
  }

  // The first request selects the only permitted block identity for this
  // wallet_sendCalls batch. Its caller policy is evaluated before any
  // remaining request starts, so an anchor rejection spends one observation.
  const firstObservation = await preflightOne(client, preflightTransactions[0], 0);
  const anchor = assertObservationReady(firstObservation, preflightTransactions[0]);
  await evaluatePolicy(0, firstObservation);

  for (let index = 1; index < preflightTransactions.length; index += 1) {
    preflightTransactions[index] = {
      ...preflightTransactions[index],
      blockNumber: quantityToInput(anchor.blockNumber)
    };
  }

  // Schedule bounded waves rather than a continuously draining worker pool.
  // Every request in one wave is allowed to settle, then its observations and
  // policies are processed in ascending call-index order. A failed wave never
  // schedules a later wave, so a rejected batch can consume at most
  // MAX_PREFLIGHT_CONCURRENCY additional preflight requests after the anchor.
  let nextIndex = 1;
  while (nextIndex < preflightTransactions.length) {
    const waveIndexes = [];
    while (waveIndexes.length < MAX_PREFLIGHT_CONCURRENCY && nextIndex < preflightTransactions.length) {
      waveIndexes.push(nextIndex);
      nextIndex += 1;
    }

    const waveResults = await Promise.all(waveIndexes.map(async (index) => {
      try {
        return {
          index,
          observation: await preflightOne(client, preflightTransactions[index], index)
        };
      } catch (error) {
        return { index, error };
      }
    }));
    waveResults.sort((left, right) => left.index - right.index);

    for (const result of waveResults) {
      if (result.error) throw result.error;
      const { index, observation } = result;
      assertObservationReady(observation, preflightTransactions[index]);
      assertCoherentBatchIdentity(observation, anchor, index);
      await evaluatePolicy(index, observation);
    }
  }

  // No observation or policy-owned object is reused. The provider receives the
  // original exact request shape, without the internal block pinning field.
  return provider.request(cloneJson(requestSnapshot, 'request'));
}

const preflightWalletSendCalls = guardWalletSendCalls;
const sendCallsWithPreflight = guardWalletSendCalls;
const executeWalletSendCalls = guardWalletSendCalls;

class BaseAccountPaymasterGuard {
  constructor({ client, policy } = {}) {
    assertClient(client);
    if (typeof policy !== 'function') throw new TypeError('An explicit caller-owned policy function is required.');
    this.client = client;
    this.policy = policy;
  }

  request(provider, request, options = {}) {
    return guardWalletSendCalls({
      client: this.client,
      provider,
      request,
      policy: options.policy === undefined ? this.policy : options.policy,
      context: options.context
    });
  }

  sendCalls(provider, request, options = {}) {
    return this.request(provider, request, options);
  }
}

const BaseAccountExecutionGuard = BaseAccountPaymasterGuard;

/** Construct the public SDK client while keeping credentials caller-owned. */
function createPublicClient({ baseUrl, apiKey, timeoutMs, sdk } = {}) {
  if (typeof apiKey !== 'string' || apiKey.length === 0) {
    throw new TypeError('apiKey must be supplied by the caller secret manager.');
  }
  if (baseUrl !== undefined) {
    if (typeof baseUrl !== 'string') throw new TypeError('baseUrl must be a valid HTTP(S) URL.');
    let parsed;
    try { parsed = new URL(baseUrl); } catch (_) { throw new TypeError('baseUrl must be a valid HTTP(S) URL.'); }
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname.toLowerCase());
    if ((parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) ||
        parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new TypeError('baseUrl must use HTTPS (HTTP is allowed only for loopback tests) without credentials or query values.');
    }
  }
  const publicSdk = sdk || require('./index.js');
  if (!publicSdk || typeof publicSdk.M2MSentinelClient !== 'function') {
    throw new TypeError('The public SDK must expose M2MSentinelClient.');
  }
  const options = { apiKey };
  if (baseUrl !== undefined) options.baseUrl = baseUrl;
  if (timeoutMs !== undefined) options.timeoutMs = timeoutMs;
  return new publicSdk.M2MSentinelClient(options);
}

module.exports = {
  BASE_CHAIN_ID,
  BASE_CHAIN_HEX,
  BASE_NETWORK,
  MAX_CALLS,
  MAX_PREFLIGHT_CONCURRENCY,
  MAX_RPC_OBSERVATION_CALLS,
  MAX_DATA_BYTES,
  WalletSendCallsInputError,
  ExecutionIdentityBlockedError,
  PreflightInputError,
  PreflightBlockedError,
  isAffirmativePolicyResult,
  validateWalletSendCallsRequest,
  normalizeWalletSendCallsRequest,
  transactionFromCall,
  toPreflightTransaction,
  assertObservationReady,
  guardWalletSendCalls,
  preflightWalletSendCalls,
  sendCallsWithPreflight,
  executeWalletSendCalls,
  BaseAccountPaymasterGuard,
  BaseAccountExecutionGuard,
  createBaseAccountPaymasterGuard: (options) => new BaseAccountPaymasterGuard(options),
  createExecutionIdentityGuard: (options) => new BaseAccountPaymasterGuard(options),
  createPublicClient
};
