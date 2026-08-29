# Runnable paid-integration proofs

These two examples show a buyer where to place M2M Sentinel immediately before
a signing or payment callback. They are original adapters, not upstream code.
Both examples keep `notASafetyGuarantee: true` and
`reachability: NOT_ESTABLISHED`; the sample caller policy blocks when evidence
or proxy/delegation resolution is unresolved.

## Requirements and installation

- Node.js 22 or newer (the repository's supported engine).
- A checkout of this repository. No wallet, private key, seed phrase, or
  external account is needed for the hermetic examples; no npm package is
  required either.

From the repository root:

```sh
node --experimental-strip-types examples/proofs/openfort-7702-preflight.ts
node --experimental-strip-types examples/proofs/locus-compatible-agent-payment.ts
```

The default commands use deterministic mocks. The action markers are printed
only after the policy has allowed the preflight.

## Openfort-compatible EIP-7702/ERC-4337 proof

The adapter observes the execution target, evaluates the caller-defined policy,
and only then calls `signer.signUserOperation(userOperation)`. This is the
signing boundary used by Openfort-style EIP-7702/ERC-4337 account flows; it is
not an official Openfort integration or partnership.

```sh
node --experimental-strip-types examples/proofs/openfort-7702-preflight.ts --unresolved
```

Expected failure includes `BLOCKED_BEFORE_SIGNING:
PROXY_OR_DELEGATION_UNRESOLVED` and never prints
`OPENFORT_SIGN_USER_OPERATION`.

Official references:

- [Openfort 7702 account repository](https://github.com/openfort-xyz/openfort-7702-account)
  (the repository README states its MIT license; this proof copies no code).
- [Openfort 7702 demo](https://7702.openfort.io/)

## Locus-compatible standalone agent-payment proof

The adapter takes a dynamically selected Base `payment.to` address, observes
that address, evaluates policy, and only then calls `paymentClient.pay`. It is
compatible with the public Locus-style model of scoped Base smart-wallet
payments, but it does not use a Locus SDK and makes no Locus partnership claim.

```sh
node --experimental-strip-types examples/proofs/locus-compatible-agent-payment.ts --target=0x1111111111111111111111111111111111111111
node --experimental-strip-types examples/proofs/locus-compatible-agent-payment.ts --unresolved
```

Expected failure includes `BLOCKED_BEFORE_PAYMENT:
PROXY_OR_DELEGATION_UNRESOLVED` and never prints
`LOCUS_COMPATIBLE_PAYMENT_EXECUTED`.

Official public references:

- [Locus documentation](https://docs.paywithlocus.com/)
- [Locus developers page](https://paywithlocus.com/developers)

## Optional live observation (no signing or payment)

Live mode performs a GET against the paid M2M Sentinel audit route and still
uses a mock action callback. It does not need a funded wallet. Supply a
customer API key only through an environment variable; it is sent in the
`x-api-key` header and never in a URL. A 401, 402, 503, network error, invalid
JSON response, or an unresolved observation fails closed before the callback.

POSIX shell:

```sh
export M2M_SENTINEL_API_KEY='(supply a key locally; do not commit it)'
node --experimental-strip-types examples/proofs/openfort-7702-preflight.ts --live
node --experimental-strip-types examples/proofs/locus-compatible-agent-payment.ts --live --target=0x1111111111111111111111111111111111111111
```

PowerShell:

```powershell
$env:M2M_SENTINEL_API_KEY = '(supply a key locally; do not commit it)'
node --experimental-strip-types examples/proofs/openfort-7702-preflight.ts --live
node --experimental-strip-types examples/proofs/locus-compatible-agent-payment.ts --live --target=0x1111111111111111111111111111111111111111
```

Set `M2M_SENTINEL_BASE_URL` only when pointing at an explicitly approved API
environment. Do not place credentials in query parameters.

## Limits and fulfillment relevance

These proofs observe deployed bytecode and common indirection; they do not
prove safety, maliciousness, exploitability, reachability, or authorization.
The caller owns the policy and must decide whether an unresolved path blocks a
transaction. The paid sprint can adapt the same boundary to one Growth signing
flow or up to two Pro flows and hand over runnable tests and documentation;
fulfillment remains bounded by the purchased plan and the runbook at
`docs/PAID_INTEGRATION_SPRINT_RUNBOOK.md`.
