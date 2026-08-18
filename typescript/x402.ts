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
  amount?: string;
  price?: string;
  [key: string]: any;
}

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
    this.expectedRecipient = options.expectedRecipient || EXPECTED_PAYOUT_RECIPIENT;
    this.maxPriceUsd = options.maxPriceUsd !== undefined ? Number(options.maxPriceUsd) : DEFAULT_MAX_PRICE_USD;
    this.maxAmountUnits = parsePriceToUnits(this.maxPriceUsd, 6);
  }

  async signPaymentAuthorization(challenge: X402PaymentChallenge): Promise<X402SignedAuthorization> {
    if (!this.wallet) {
      throw new Error('Signer wallet is required to sign x402 payment authorization');
    }

    const payTo = challenge.payTo || challenge.recipient || this.expectedRecipient;
    const amountUnits = challenge.maxAmountRequired || challenge.amountUnits || parsePriceToUnits(challenge.amount || challenge.price || '$0.005', 6).toString();
    const tokenContract = challenge.assetContract || BASE_USDC_CONTRACT;
    const chainId = Number(challenge.chainId || BASE_CHAIN_ID);

    // Local Security Invariant Checks
    if (chainId !== BASE_CHAIN_ID) {
      throw new Error(`[x402 Security Policy] Refusing to sign on unverified network chainId: ${chainId}. Expected Base Mainnet (8453).`);
    }
    if (tokenContract.toLowerCase() !== BASE_USDC_CONTRACT.toLowerCase()) {
      throw new Error(`[x402 Security Policy] Refusing to sign for unapproved asset: ${tokenContract}. Expected Base USDC (${BASE_USDC_CONTRACT}).`);
    }
    if (payTo.toLowerCase() !== this.expectedRecipient.toLowerCase()) {
      throw new Error(`[x402 Security Policy] Refusing to sign for unexpected recipient: ${payTo}. Expected ${this.expectedRecipient}.`);
    }
    if (BigInt(amountUnits) > this.maxAmountUnits) {
      throw new Error(`[x402 Security Policy] Requested amount (${amountUnits} units) exceeds local client authorized price ceiling (${this.maxAmountUnits.toString()} units).`);
    }

    const now = Math.floor(Date.now() / 1000);
    const validAfter = now - 60;
    const validBefore = now + 3600;
    
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
      name: challenge.tokenName || 'USD Coin',
      version: challenge.tokenVersion || '2',
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
    const headers = { 'Accept': 'application/json', 'User-Agent': '@m2msentinel/sdk-ts/1.1.1', ...(options.headers || {}) };

    let res = await fetch(url, { method: options.method || 'GET', headers, body: options.body });
    if (res.status !== 402) {
      return res;
    }

    const challengeHeader = res.headers.get('PAYMENT-REQUIRED') || res.headers.get('x402-payment-required');
    let challenge: any = parsePaymentHeader(challengeHeader);

    if (!challenge) {
      try {
        const bodyJson = await res.clone().json();
        challenge = bodyJson.accepts?.[0] || bodyJson.paymentRequired;
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
