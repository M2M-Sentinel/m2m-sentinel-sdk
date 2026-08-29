/**
 * Buyer proof: Locus-compatible standalone agent-payment boundary.
 *
 * This example follows the public Locus model (Base smart-wallet execution,
 * scoped policies and pay-per-use requests) through an original adapter
 * interface. It does not use a Locus SDK, claim a Locus partnership, or
 * execute a real payment. The payment callback is a mock unless a buyer
 * replaces it in their own application.
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

const OFFICIAL_LOCUS_DOCS = 'https://docs.paywithlocus.com/';
const OFFICIAL_LOCUS_DEVELOPERS = 'https://paywithlocus.com/developers';

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
      proxyType: 'DELEGATECALL_PROXY_SUSPECTED',
      targetAddress: null,
      resolutionComplete: false,
      warning: 'Delegate execution target could not be established at the observation block.'
    },
    provenance: { trustLevel: 'QUORUM_PUBLIC' }
  }, address);
}

function isEvmAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

async function payWithLocusCompatiblePreflight(options: any): Promise<any> {
  const payment = options.payment;
  if (!payment || !isEvmAddress(payment.to)) throw new Error('Payment target must be a 20-byte EVM address');
  if (typeof options.observe !== 'function') throw new Error('An observer is required before payment');
  const observation = await options.observe(payment.to);
  return runPreflightBeforeAction({
    observation,
    policy: options.policy,
    context: {
      integration: 'locus-compatible-standalone',
      network: 'Base',
      paymentRail: 'USDC',
      targetAddress: payment.to,
      payment
    },
    onDecision: options.onDecision,
    actionName: 'Locus-compatible payment',
    action: () => options.paymentClient.pay(payment)
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const unresolved = args.includes('--unresolved');
  const live = args.includes('--live');
  const targetArg = args.find((value) => value.startsWith('--target='));
  const targetAddress = targetArg ? targetArg.slice('--target='.length) : SAMPLE_BASE_ADDRESS;
  if (!isEvmAddress(targetAddress)) {
    console.error('LOCUS_PREFLIGHT_ERROR: --target must be a 20-byte EVM address');
    process.exitCode = 1;
    return;
  }
  let observation;
  let observe;
  if (live) {
    console.log('mode: LIVE_OBSERVATION_ONLY (the payment callback remains a mock)');
    observe = createSentinelObserver({
      baseUrl: process.env.M2M_SENTINEL_BASE_URL || DEFAULT_BASE_URL,
      apiKey: process.env.M2M_SENTINEL_API_KEY
    });
  } else {
    observation = unresolved ? unresolvedFixture(targetAddress) : resolvedFixture(targetAddress);
    observe = async (address: string) => ({ ...observation, address });
  }
  const payment = {
    to: targetAddress,
    data: '0x1234',
    amountUsdc: '0.005',
    reason: 'bounded agent payment example'
  };
  const paymentClient = {
    async pay(value: any): Promise<any> {
      console.log('LOCUS_COMPATIBLE_PAYMENT_EXECUTED (mock only; no wallet or funds)');
      return { status: 'NOT_SUBMITTED', target: value.to, amountUsdc: value.amountUsdc };
    }
  };
  const policy = async (value: any) => callerDefinedEvidencePolicy(value);
  try {
    const result = await payWithLocusCompatiblePreflight({
      payment,
      observe,
      policy,
      paymentClient,
      onDecision: (decision: any) => console.log(`policy: ${decision.allow ? 'ALLOW' : `BLOCK (${decision.code})`}`)
    });
    console.log('M2M_SENTINEL_PREFLIGHT');
    console.log(formatObservation(result.observation));
    console.log(`result: ${JSON.stringify(result.result)}`);
    console.log(`docs-reference: ${OFFICIAL_LOCUS_DOCS}`);
    console.log(`developers-reference: ${OFFICIAL_LOCUS_DEVELOPERS}`);
  } catch (error: any) {
    if (error instanceof PreflightBlockedError) {
      console.error(`BLOCKED_BEFORE_PAYMENT: ${error.code} — ${error.reason}`);
      process.exitCode = 1;
      return;
    }
    console.error(`LOCUS_PREFLIGHT_ERROR: ${error?.message || error}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  OFFICIAL_LOCUS_DOCS,
  OFFICIAL_LOCUS_DEVELOPERS,
  resolvedFixture,
  unresolvedFixture,
  isEvmAddress,
  payWithLocusCompatiblePreflight
};
