export const BASE_USDC_CONTRACT = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const BASE_CHAIN_ID = 8453;
export const EXPECTED_PAYOUT_RECIPIENT = '0x6d6c398390cfb88f1cd42715b84906a0bd6652aa';
export const DEFAULT_MAX_PRICE_USD = 0.05;

export interface X402SignerClientOptions {
  wallet?: any;
  walletSigner?: any;
  baseUrl?: string;
  timeoutMs?: number;
  expectedRecipient?: string;
  maxPriceUsd?: number;
}

export interface X402PaymentChallenge {
  x402Version?: number;
  scheme?: string;
  tokenName?: string;
  tokenVersion?: string;
  assetContract?: string;
  chainId?: number | string;
  payTo?: string;
  recipient?: string;
  amountUnits?: string;
  maxAmountRequired?: string;
  /** x402 v2 nests the offer here. Its presence selects the v2 envelope. */
  accepts?: any[];
  resource?: any;
  asset?: string;
  network?: string;
  extra?: { name?: string; version?: string };
  maxTimeoutSeconds?: number;
  amount?: string;
  price?: string;
  [key: string]: any;
}

/** The canonical x402 v2 payment payload. */
export interface X402SignedAuthorizationV2 {
  x402Version: 2;
  resource?: any;
  /** The server's advertised extensions, echoed back. The CDP Bazaar indexes a
   *  resource from the bazaar extension carried by the settlement. */
  extensions?: any;
  /** The chosen offer echoed back verbatim. The server deep-equality matches
   *  this against its own requirements to learn which offer is being paid. */
  accepted: any;
  payload: {
    authorization: {
      from: string;
      to: string;
      value: string;
      validAfter: string;
      validBefore: string;
      nonce: string;
    };
    signature: string;
  };
}

export type X402SignedPayload = X402SignedAuthorization | X402SignedAuthorizationV2;

export interface X402SignedAuthorization {
  x402Version: number;
  scheme: string;
  network: string;
  token: string;
  assetContract: string;
  authorization: {
    from: string;
    to: string;
    value: string;
    validAfter: number;
    validBefore: number;
    nonce: string;
    v: number;
    r: string;
    s: string;
    signature: string;
  };
}

export function parsePriceToUnits(priceStr: string | number, decimals: number = 6): bigint {
  if (typeof priceStr === 'number') return BigInt(Math.round(priceStr * 10 ** decimals));
  const clean = String(priceStr).replace(/[^0-9.]/g, '');
  const [whole, fraction = ''] = clean.split('.');
  const paddedFraction = (fraction + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt(whole || '0') * BigInt(10 ** decimals) + BigInt(paddedFraction);
}

export function parsePaymentHeader(value: string | null): any {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    try {
      const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
      const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
      if (typeof atob === 'function') {
        return JSON.parse(atob(padded));
      }
      return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
    } catch {
      return null;
    }
  }
}

export class X402SignerClient {
  public readonly wallet: any;
  public readonly baseUrl: string;
  public readonly timeoutMs: number;
  public readonly expectedRecipient: string;
  public readonly maxPriceUsd: number;
  public readonly maxAmountUnits: bigint;

  constructor(options: X402SignerClientOptions = {}) {
    this.wallet = options.wallet || options.walletSigner || null;
    this.baseUrl = (options.baseUrl || 'https://api.m2msentinel.com').replace(/\/+$/, '');
    this.timeoutMs = Number(options.timeoutMs || 30000);
    this.expectedRecipient = EXPECTED_PAYOUT_RECIPIENT;
    this.maxPriceUsd = options.maxPriceUsd !== undefined ? Number(options.maxPriceUsd) : DEFAULT_MAX_PRICE_USD;
    this.maxAmountUnits = parsePriceToUnits(this.maxPriceUsd, 6);
  }

  async signPaymentAuthorization(challenge: X402PaymentChallenge = {}): Promise<X402SignedPayload> {
    if (!this.wallet) {
      throw new Error('Signer wallet is required to sign x402 payment authorization');
    }

    // 1. IMMUTABLE LOCAL SECURITY CONSTANTS (Never challenge-controlled)
    const chainId = BASE_CHAIN_ID; // Base Mainnet (8453)
    const tokenContract = BASE_USDC_CONTRACT; // Base USDC (0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913)
    const payTo = EXPECTED_PAYOUT_RECIPIENT; // M2M Sentinel Payout (0x6d6c398390cfb88f1cd42715b84906a0bd6652aa)

    // x402 v2 nests the offer under `accepts` and is identified by its presence.
    // Reading only the flat shape made every guard below miss silently: they
    // compared undefined and passed, and the amount fell back to a hardcoded
    // default, signing for less than the server demanded.
    const isV2 = Array.isArray(challenge.accepts) && challenge.accepts.length > 0;
    const offer: any = isV2 ? challenge.accepts![0] : challenge;

    const offeredChainId = typeof offer.network === 'string' && offer.network.startsWith('eip155:')
      ? Number(offer.network.slice('eip155:'.length))
      : (offer.chainId || challenge.chainId);
    // v2 carries the address in `asset`; the flat shape carries a symbol there
    // and the address in `assetContract`. Compare addresses to addresses only.
    const offeredAsset = [offer.assetContract, challenge.assetContract, offer.asset, challenge.asset]
      .find((value: any) => typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value)) || null;
    const offeredPayTo = offer.payTo || offer.recipient || challenge.payTo;
    const offeredTokenName = (offer.extra && offer.extra.name) || challenge.tokenName;
    const offeredTokenVersion = (offer.extra && offer.extra.version) || challenge.tokenVersion;

    // 2. STRICT CHALLENGE INTEGRITY CHECKS (Refuse if challenge alters network, asset, or recipient)
    if (offeredChainId && Number(offeredChainId) !== BASE_CHAIN_ID) {
      throw new Error(`[x402 Security Policy] Refusing to sign on unverified network chainId: ${offeredChainId}. Autonomous signer strictly requires Base Mainnet (8453).`);
    }
    if (offeredAsset && offeredAsset.toLowerCase() !== BASE_USDC_CONTRACT.toLowerCase()) {
      throw new Error(`[x402 Security Policy] Refusing to sign for unapproved asset: ${offeredAsset}. Autonomous signer strictly requires Base USDC (${BASE_USDC_CONTRACT}).`);
    }
    if (offeredPayTo && offeredPayTo.toLowerCase() !== EXPECTED_PAYOUT_RECIPIENT.toLowerCase()) {
      throw new Error(`[x402 Security Policy] Refusing to sign for unexpected recipient: ${offeredPayTo}. Autonomous signer strictly requires ${EXPECTED_PAYOUT_RECIPIENT}.`);
    }
    if (offeredTokenName && offeredTokenName !== 'USD Coin') {
      throw new Error(`[x402 Security Policy] Refusing to sign for unexpected tokenName: ${offeredTokenName}. Expected USD Coin.`);
    }
    if (offeredTokenVersion && offeredTokenVersion !== '2') {
      throw new Error(`[x402 Security Policy] Refusing to sign for unexpected tokenVersion: ${offeredTokenVersion}. Expected 2.`);
    }

    // 3. STRICT LOCAL PRICE CEILING CHECK
    // Never invent a price. A guessed amount produces an authorization the
    // server refuses, which is indistinguishable from a rejected payment.
    const rawAmount = offer.amount ?? offer.maxAmountRequired ??
      challenge.maxAmountRequired ?? challenge.amountUnits ?? challenge.amount ?? challenge.price;
    let requestedAmountUnits: string | null = null;
    if (typeof rawAmount === 'number' && Number.isInteger(rawAmount) && rawAmount > 0) {
      requestedAmountUnits = String(rawAmount);
    } else if (typeof rawAmount === 'string' && /^[0-9]+$/.test(rawAmount.trim())) {
      requestedAmountUnits = rawAmount.trim();
    } else if (typeof rawAmount === 'string' && /[$.]/.test(rawAmount)) {
      requestedAmountUnits = parsePriceToUnits(rawAmount, 6).toString();
    }
    if (!requestedAmountUnits || !/^[0-9]+$/.test(requestedAmountUnits) || BigInt(requestedAmountUnits) <= BigInt(0)) {
      throw new Error('[x402] The challenge carried no readable amount. Refusing to guess a price.');
    }
    if (BigInt(requestedAmountUnits) > this.maxAmountUnits) {
      throw new Error(`[x402 Security Policy] Requested amount (${requestedAmountUnits} units) exceeds local client authorized price ceiling (${this.maxAmountUnits.toString()} units / $${this.maxPriceUsd}).`);
    }
    const amountUnits = requestedAmountUnits;

    const now = Math.floor(Date.now() / 1000);
    // v2 servers bound the window with `maxTimeoutSeconds`; a longer window
    // than advertised is not more permissive, just outside what settles.
    const validAfter: any = isV2 ? '0' : now - 60;
    const validBefore: any = isV2 ? String(now + (Number(offer.maxTimeoutSeconds) || 120)) : now + 3600;
    
    // Generate 32-byte hex nonce
    let nonce = '0x';
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      const bytes = new Uint8Array(32);
      crypto.getRandomValues(bytes);
      nonce += Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    } else {
      const cryptoNode = require('crypto');
      nonce += cryptoNode.randomBytes(32).toString('hex');
    }

    const domain = {
      name: 'USD Coin',
      version: '2',
      chainId,
      verifyingContract: tokenContract
    };

    const types = {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' }
      ]
    };

    const fromAddress = typeof this.wallet.getAddress === 'function' 
      ? await this.wallet.getAddress() 
      : (this.wallet.address || this.wallet.account?.address);

    const message = {
      from: fromAddress,
      to: payTo,
      value: amountUnits.toString(),
      validAfter,
      validBefore,
      nonce
    };

    let signature: string | { r: string; s: string; v: number };
    if (typeof this.wallet.signTypedData === 'function') {
      signature = await this.wallet.signTypedData(domain, types, message);
    } else if (typeof this.wallet._signTypedData === 'function') {
      signature = await this.wallet._signTypedData(domain, types, message);
    } else if (typeof this.wallet.signTypedDataV4 === 'function') {
      signature = await this.wallet.signTypedDataV4({ domain, types, message, primaryType: 'TransferWithAuthorization' });
    } else {
      throw new Error('Wallet does not implement EIP-712 signTypedData');
    }

    let v: number, r: string, s: string;
    if (typeof signature === 'string') {
      const clean = signature.startsWith('0x') ? signature.slice(2) : signature;
      r = '0x' + clean.slice(0, 64);
      s = '0x' + clean.slice(64, 128);
      v = parseInt(clean.slice(128, 130), 16);
      if (v < 27) v += 27;
    } else {
      r = signature.r;
      s = signature.s;
      v = signature.v;
    }

    const flatSignature = typeof signature === 'string' 
      ? signature 
      : '0x' + r.slice(2) + s.slice(2) + v.toString(16).padStart(2, '0');

    if (isV2) {
      // The canonical v2 envelope. Omitting `accepted` does not read as "no
      // payment": it crashes the server's offer matcher, which then answers 402
      // with an opaque body. There is deliberately no top-level scheme/network
      // in v2 -- both live inside `accepted`.
      return {
        x402Version: 2,
        resource: challenge.resource,
        accepted: offer,
          // Echo the server's advertised extensions back. The canonical client
          // merges paymentRequired.extensions into the payload; omitting the
          // field still settles the payment, so this failed silently -- but the
          // CDP Bazaar indexes a resource from the bazaar extension carried by
          // the settlement, so a payment without it is invisible to discovery.
        extensions: challenge.extensions,
        payload: {
          authorization: {
            from: fromAddress,
            to: payTo,
            value: amountUnits.toString(),
            validAfter: String(validAfter),
            validBefore: String(validBefore),
            nonce
          },
          signature: flatSignature
        }
      };
    }

    // Legacy flat envelope, for servers that do not advertise `accepts`.
    return {
      x402Version: 2,
      scheme: 'eip3009',
      network: `eip155:${chainId}`,
      token: tokenContract,
      assetContract: tokenContract,
      authorization: {
        from: fromAddress,
        to: payTo,
        value: amountUnits.toString(),
        validAfter,
        validBefore,
        nonce,
        v,
        r,
        s,
        signature: flatSignature
      }
    };
  }

  async fetchWithAutoPayment(path: string, options: any = {}): Promise<any> {
    const url = path.startsWith('http') ? path : `${this.baseUrl}/${path.replace(/^\/+/, '')}`;
    const headers = { 'Accept': 'application/json', 'User-Agent': '@m2msentinel/sdk-ts/1.2.3', ...(options.headers || {}) };

    let res = await fetch(url, { method: options.method || 'GET', headers, body: options.body });
    if (res.status !== 402) {
      return res;
    }

    const challengeHeader = res.headers.get('PAYMENT-REQUIRED') || res.headers.get('x402-payment-required');
    let challenge: any = parsePaymentHeader(challengeHeader);

    if (!challenge) {
      try {
        const bodyJson = await res.clone().json();
        // Pass the whole PaymentRequired, not just accepts[0]: the signer
        // needs `resource` and must echo the offer back as `accepted`.
        challenge = bodyJson.accepts ? bodyJson : bodyJson.paymentRequired;
      } catch {
        // Body was not JSON
      }
    }

    if (!challenge) {
      throw new Error('HTTP 402 received but no valid x402 payment challenge was found in headers or response body.');
    }

    const paymentPayload = await this.signPaymentAuthorization(challenge);
    const paymentB64 = typeof btoa === 'function'
      ? btoa(JSON.stringify(paymentPayload))
      : Buffer.from(JSON.stringify(paymentPayload)).toString('base64');

    const retryHeaders = {
      ...headers,
      'PAYMENT-SIGNATURE': paymentB64,
      'x402-payment-authorization': paymentB64
    };

    return fetch(url, { method: options.method || 'GET', headers: retryHeaders, body: options.body });
  }
}

export function x402SignerClient(options: X402SignerClientOptions = {}): X402SignerClient {
  return new X402SignerClient(options);
}
