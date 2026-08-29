/**
 * Buyer proof: Openfort-compatible EIP-7702/ERC-4337 signing boundary.
 *
 * The adapter uses the real UserOperation signing boundary exposed by
 * Openfort-style account clients. It is original example code, not an
 * official Openfort integration or partnership and does not copy upstream
 * implementation code. No wallet, private key, or credential is required.
 */

const {
  DEFAULT_BASE_URL,
  SAMPLE_BASE_ADDRESS,
  PreflightBlockedError,
  callerDefinedEvidencePolicy,
  createSentinelObserver,
  formatObservation,
  normalizeObservation,
  runPreflightBeforeAction
} = require('./preflight_core.ts');

const OFFICIAL_OPENFORT_REPOSITORY = 'https://github.com/openfort-xyz/openfort-7702-account';
const OFFICIAL_OPENFORT_DEMO = 'https://7702.openfort.io/';

function resolvedFixture(address: string = SAMPLE_BASE_ADDRESS): any {
  return normalizeObservation({
    address,
    notASafetyGuarantee: true,
    reachability: 'NOT_ESTABLISHED',
    evidenceGrade: true,
    proxyResolution: {
      isProxy: false,
      proxyType: null,
      targetAddress: null,
      resolutionComplete: true,
      note: null
    },
    provenance: { trustLevel: 'QUORUM_PUBLIC' },
    dissection: { isValidContract: true, instructionCount: 12 }
  }, address);
}

function unresolvedFixture(address: string = SAMPLE_BASE_ADDRESS): any {
  return normalizeObservation({
    address,
    notASafetyGuarantee: true,
    reachability: 'NOT_ESTABLISHED',
    evidenceGrade: true,
    proxyResolution: {
      isProxy: true,
      proxyType: 'EIP7702_DELEGATED_EOA',
      targetAddress: null,
      resolutionComplete: false,
      warning: 'Delegated implementation could not be established at the observation block.'
    },
    provenance: { trustLevel: 'QUORUM_PUBLIC' }
  }, address);
}

async function signOpenfortUserOperation(options: any): Promise<any> {
  const userOperation = options.userOperation;
  const targetAddress = options.targetAddress || userOperation?.targetAddress || userOperation?.sender;
  if (!targetAddress) throw new Error('An execution target address is required before signing');
  const observe = options.observe;
  if (typeof observe !== 'function') throw new Error('An observer is required before signing');
  const observation = await observe(targetAddress);
  return runPreflightBeforeAction({
    observation,
    policy: options.policy,
    context: {
      integration: 'openfort-compatible',
      standards: ['EIP-7702', 'ERC-4337'],
      targetAddress,
      userOperation
    },
    onDecision: options.onDecision,
    actionName: 'Openfort signUserOperation',
    action: () => options.signer.signUserOperation(userOperation)
  });
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const targetAddress = SAMPLE_BASE_ADDRESS;
  let observation;
  let observe;
  if (args.has('--live')) {
    console.log('mode: LIVE_OBSERVATION_ONLY (the signing callback remains a mock)');
    observe = createSentinelObserver({
      baseUrl: process.env.M2M_SENTINEL_BASE_URL || DEFAULT_BASE_URL,
      apiKey: process.env.M2M_SENTINEL_API_KEY
    });
  } else {
    observation = args.has('--unresolved') ? unresolvedFixture(targetAddress) : resolvedFixture(targetAddress);
    observe = async () => observation;
  }

  const userOperation = {
    sender: '0x1111111111111111111111111111111111111111',
    nonce: '0x0',
    callData: '0x1234',
    targetAddress
  };
  const signer = {
    async signUserOperation(value: any): Promise<any> {
      console.log('OPENFORT_SIGN_USER_OPERATION (mock signer; no wallet action)');
      return { signature: '0xmock-signature', userOperation: value };
    }
  };
  const policy = async (value: any) => callerDefinedEvidencePolicy(value);
  try {
    const result = await signOpenfortUserOperation({
      targetAddress,
      userOperation,
      observe,
      signer,
      policy,
      onDecision: (decision: any) => console.log(`policy: ${decision.allow ? 'ALLOW' : `BLOCK (${decision.code})`}`)
    });
    console.log('M2M_SENTINEL_PREFLIGHT');
    console.log(formatObservation(result.observation));
    console.log(`result: ${JSON.stringify(result.result)}`);
    console.log(`official-reference: ${OFFICIAL_OPENFORT_REPOSITORY}`);
    console.log(`demo-reference: ${OFFICIAL_OPENFORT_DEMO}`);
  } catch (error: any) {
    if (error instanceof PreflightBlockedError) {
      console.error(`BLOCKED_BEFORE_SIGNING: ${error.code} — ${error.reason}`);
      process.exitCode = 1;
      return;
    }
    console.error(`OPENFORT_PREFLIGHT_ERROR: ${error?.message || error}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  OFFICIAL_OPENFORT_REPOSITORY,
  OFFICIAL_OPENFORT_DEMO,
  resolvedFixture,
  unresolvedFixture,
  signOpenfortUserOperation
};
