/**
 * Small, dependency-free preflight primitives shared by the buyer proofs.
 *
 * This is original adapter code. It deliberately keeps the caller's policy
 * separate from M2M Sentinel's observation so an integration can choose how
 * to handle unknown evidence without turning it into a safety claim.
 * No private key, seed phrase, wallet credential, or raw API key is stored here.
 */

const DEFAULT_BASE_URL = 'https://api.m2msentinel.com';
const SAMPLE_BASE_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

class PreflightBlockedError extends Error {
  code: string;
  reason: string;
  observation: any;
  decision: any;

  constructor(code: string, reason: string, observation: any, decision: any) {
    super(`Preflight blocked before action: ${reason}`);
    this.name = 'PreflightBlockedError';
    this.code = code;
    this.reason = reason;
    this.observation = observation;
    this.decision = decision;
  }
}

function stringOrNull(value: any): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function normalizeObservation(payload: any, address?: string): any {
  const envelope = payload && typeof payload === 'object' ? payload : {};
  const source = envelope.audit && typeof envelope.audit === 'object'
    ? envelope.audit
    : envelope;
  const rawProxy = source.proxyResolution && typeof source.proxyResolution === 'object'
    ? source.proxyResolution
    : null;
  const proxyType = stringOrNull(rawProxy?.proxyType);
  const isDelegation = Boolean(proxyType && /(?:EIP.?7702|DELEGAT)/i.test(proxyType));
  const hasProxyRecord = Boolean(rawProxy);
  const isProxy = rawProxy && typeof rawProxy.isProxy === 'boolean'
    ? rawProxy.isProxy
    : null;
  const resolutionComplete = rawProxy
    ? rawProxy.resolutionComplete === true
    : null;

  return {
    address: stringOrNull(source.address) || stringOrNull(envelope.address) || address || null,
    notASafetyGuarantee: source.notASafetyGuarantee === true,
    reachability: stringOrNull(source.reachability),
    evidenceGrade: source.evidenceGrade === true,
    proxyResolution: {
      present: hasProxyRecord,
      isProxy,
      isDelegation,
      proxyType,
      targetAddress: stringOrNull(rawProxy?.targetAddress),
      resolutionComplete,
      warning: stringOrNull(rawProxy?.warning),
      note: stringOrNull(rawProxy?.note)
    },
    provenance: source.provenance && typeof source.provenance === 'object'
      ? { trustLevel: stringOrNull(source.provenance.trustLevel) }
      : { trustLevel: null },
    dissection: source.dissection && typeof source.dissection === 'object'
      ? {
        isValidContract: source.dissection.isValidContract === true,
        instructionCount: Number.isInteger(source.dissection.instructionCount)
          ? source.dissection.instructionCount
          : null
      }
      : null
  };
}

function observationSummary(observation: any): any {
  const proxy = observation?.proxyResolution || {};
  return {
    address: observation?.address || null,
    notASafetyGuarantee: observation?.notASafetyGuarantee === true,
    reachability: observation?.reachability || 'UNREPORTED',
    evidenceGrade: observation?.evidenceGrade === true,
    proxyType: proxy.proxyType || 'NONE_REPORTED',
    targetAddress: proxy.targetAddress || 'NONE_REPORTED',
    resolutionComplete: proxy.resolutionComplete === true,
    warning: proxy.warning || proxy.note || null,
    trustLevel: observation?.provenance?.trustLevel || 'UNREPORTED'
  };
}

function callerDefinedEvidencePolicy(observation: any): any {
  const proxy = observation?.proxyResolution;
  const checks: any[] = [];
  if (!observation) {
    return { allow: false, code: 'OBSERVATION_MISSING', reason: 'M2M Sentinel returned no observation', checks };
  }
  if (observation.notASafetyGuarantee !== true) {
    return {
      allow: false,
      code: 'SAFETY_FLAG_MISSING',
      reason: 'The response did not preserve notASafetyGuarantee=true',
      checks
    };
  }
  checks.push('notASafetyGuarantee=true');
  if (observation.reachability !== 'NOT_ESTABLISHED') {
    return {
      allow: false,
      code: 'REACHABILITY_UNEXPECTED',
      reason: 'The caller requires reachability to remain NOT_ESTABLISHED',
      checks
    };
  }
  checks.push('reachability=NOT_ESTABLISHED');
  if (observation.evidenceGrade !== true) {
    return {
      allow: false,
      code: 'EVIDENCE_GRADE_NOT_ESTABLISHED',
      reason: 'Evidence grade is not established',
      checks
    };
  }
  checks.push('evidenceGrade=true');
  if (!proxy || proxy.present !== true) {
    return {
      allow: false,
      code: 'PROXY_OR_DELEGATION_UNRESOLVED',
      reason: 'Proxy/delegation resolution was not reported',
      checks
    };
  }
  const indirection = proxy.isProxy === true || proxy.isDelegation === true;
  if (indirection && (proxy.resolutionComplete !== true || !proxy.targetAddress)) {
    return {
      allow: false,
      code: 'PROXY_OR_DELEGATION_UNRESOLVED',
      reason: proxy.warning || proxy.note || 'Proxy or delegated execution target is unresolved',
      checks
    };
  }
  checks.push(indirection ? 'proxy/delegation=resolved' : 'no-proxy-or-delegation-reported');
  return {
    allow: true,
    code: 'EVIDENCE_GRADE_AND_RESOLUTION_REQUIREMENTS_MET',
    reason: 'Caller-defined evidence requirements are met',
    checks
  };
}

function createSentinelObserver(options: any = {}): any {
  const baseUrl = String(options.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
  const route = String(options.route || '/v1/audit/').replace(/^\/?/, '/');
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required for live preflight');
  return async function observe(address: string): Promise<any> {
    const url = `${baseUrl}${route}${encodeURIComponent(address)}`;
    const headers: any = { Accept: 'application/json' };
    if (options.apiKey) headers['x-api-key'] = String(options.apiKey);
    let response: any;
    try {
      response = await fetchImpl(url, { method: 'GET', headers });
    } catch (error: any) {
      throw new Error(`M2M Sentinel preflight failed before action: ${error?.message || 'network error'}`);
    }
    if (!response || !response.ok) {
      const status = response?.status || 'unknown';
      throw new Error(`M2M Sentinel preflight failed before action: HTTP ${status}`);
    }
    let payload: any;
    try {
      payload = await response.json();
    } catch (_) {
      throw new Error('M2M Sentinel preflight failed before action: invalid JSON response');
    }
    return normalizeObservation(payload, address);
  };
}

async function runPreflightBeforeAction(options: any): Promise<any> {
  if (!options || typeof options.policy !== 'function') {
    throw new PreflightBlockedError(
      'POLICY_REQUIRED',
      'A caller-defined policy is required',
      options?.observation || null,
      { allow: false, code: 'POLICY_REQUIRED', reason: 'A caller-defined policy is required', checks: [] }
    );
  }
  if (typeof options.action !== 'function') {
    throw new PreflightBlockedError(
      'ACTION_REQUIRED',
      'An action callback is required',
      options?.observation || null,
      { allow: false, code: 'ACTION_REQUIRED', reason: 'An action callback is required', checks: [] }
    );
  }
  let decision: any;
  try {
    decision = await options.policy(options.observation, options.context || {});
  } catch (error: any) {
    decision = {
      allow: false,
      code: 'POLICY_ERROR',
      reason: `Caller policy failed: ${error?.message || 'unknown policy error'}`,
      checks: []
    };
  }
  if (decision === true) decision = { allow: true, code: 'CALLER_POLICY_ALLOWED', reason: 'Caller policy allowed the action', checks: [] };
  if (!decision || decision.allow !== true) {
    const blocked = decision || {
      allow: false,
      code: 'POLICY_DENIED',
      reason: 'Caller policy denied the action',
      checks: []
    };
    if (typeof options.onDecision === 'function') options.onDecision(blocked);
    throw new PreflightBlockedError(blocked.code, blocked.reason, options.observation, blocked);
  }
  if (typeof options.onDecision === 'function') options.onDecision(decision);
  const result = await options.action();
  return { observation: options.observation, decision, result };
}

function formatObservation(observation: any): string {
  const summary = observationSummary(observation);
  return [
    `address: ${summary.address || 'UNREPORTED'}`,
    `notASafetyGuarantee: ${summary.notASafetyGuarantee}`,
    `reachability: ${summary.reachability}`,
    `evidenceGrade: ${summary.evidenceGrade}`,
    `proxyType: ${summary.proxyType}`,
    `targetAddress: ${summary.targetAddress}`,
    `resolutionComplete: ${summary.resolutionComplete}`,
    `trustLevel: ${summary.trustLevel}`,
    `warning: ${summary.warning || 'none reported'}`
  ].join('\n');
}

module.exports = {
  DEFAULT_BASE_URL,
  SAMPLE_BASE_ADDRESS,
  PreflightBlockedError,
  normalizeObservation,
  observationSummary,
  callerDefinedEvidencePolicy,
  createSentinelObserver,
  runPreflightBeforeAction,
  formatObservation
};
