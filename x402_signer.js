'use strict';

/**
 * Facilitator-Independent Headless x402 Signer Client.
 *
 * Implements automated HTTP 402 challenge negotiation and EIP-712 / EIP-3009
 * transfer authorization signing directly on Base mainnet (chainId: 8453).
 * Zero browser or UI wallet dependencies — pure headless operation for autonomous agents.
 */

const https = require('https');
const http = require('http');
const crypto = require('crypto');

const BASE_USDC_CONTRACT = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const BASE_CHAIN_ID = 8453;

function parsePaymentHeader(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_) {}
  try {
    const normalized = String(value).replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch (_) {
    return null;
  }
}

function parsePriceToUnits(priceStr, decimals = 6) {
  if (typeof priceStr === 'number') return BigInt(Math.round(priceStr * 10 ** decimals));
  const clean = String(priceStr).replace(/[^0-9.]/g, '');
  const [whole, fraction = ''] = clean.split('.');
  const paddedFraction = (fraction + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt(whole || '0') * BigInt(10 ** decimals) + BigInt(paddedFraction);
}

const EXPECTED_PAYOUT_RECIPIENT = '0x6d6c398390cfb88f1cd42715b84906a0bd6652aa';
const DEFAULT_MAX_PRICE_USD = 0.05; // 5 cents maximum per autonomous request
const EIP712_TOKEN_NAME = 'USD Coin';
const EIP712_TOKEN_VERSION = '2';

class X402SignerClient {
  constructor(options = {}) {
    this.wallet = options.wallet || options.walletSigner || null;
    this.baseUrl = (options.baseUrl || 'https://api.m2msentinel.com').replace(/\/+$/, '');
    this.timeoutMs = Number(options.timeoutMs || 30000);
    this.expectedRecipient = EXPECTED_PAYOUT_RECIPIENT;
    this.maxPriceUsd = options.maxPriceUsd !== undefined ? Number(options.maxPriceUsd) : DEFAULT_MAX_PRICE_USD;
    this.maxAmountUnits = parsePriceToUnits(this.maxPriceUsd, 6);
  }

  async signPaymentAuthorization(challenge = {}) {
    if (!this.wallet) {
      throw new Error('Signer wallet is required to sign x402 payment authorization');
    }

    // 1. IMMUTABLE LOCAL SECURITY CONSTANTS (Never challenge-controlled)
    const chainId = BASE_CHAIN_ID; // Base Mainnet (8453)
    const tokenContract = BASE_USDC_CONTRACT; // Base USDC (0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913)
    const payTo = EXPECTED_PAYOUT_RECIPIENT; // M2M Sentinel Payout (0x6d6c398390cfb88f1cd42715b84906a0bd6652aa)

    // x402 v2 nests the offer under `accepts` and is identified by its presence.
    // Reading only the flat shape made every check below miss silently: the
    // guards passed vacuously because the fields they read were undefined, and
    // the amount fell back to a hardcoded default, signing for less than the
    // server demanded. Read the offer first, keep the flat shape as fallback.
    const isV2 = Array.isArray(challenge.accepts) && challenge.accepts.length > 0;
    const offer = isV2 ? challenge.accepts[0] : challenge;

    const offeredChainId = typeof offer.network === 'string' && offer.network.startsWith('eip155:')
      ? Number(offer.network.slice('eip155:'.length))
      : (offer.chainId || challenge.chainId);
    // v2 carries the address in `asset`; the flat shape carries a symbol there
    // and the address in `assetContract`. Compare addresses to addresses only.
    const offeredAsset = [offer.assetContract, challenge.assetContract, offer.asset, challenge.asset]
      .find((value) => typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value)) || null;
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
    if (offeredTokenName && offeredTokenName !== EIP712_TOKEN_NAME) {
      throw new Error(`[x402 Security Policy] Refusing to sign for unexpected tokenName: ${offeredTokenName}. Expected ${EIP712_TOKEN_NAME}.`);
    }
    if (offeredTokenVersion && offeredTokenVersion !== EIP712_TOKEN_VERSION) {
      throw new Error(`[x402 Security Policy] Refusing to sign for unexpected tokenVersion: ${offeredTokenVersion}. Expected ${EIP712_TOKEN_VERSION}.`);
    }

    // 3. STRICT LOCAL PRICE CEILING CHECK
    // Never invent a price. A guessed amount produces an authorization the
    // server refuses, which is indistinguishable from a rejected payment.
    // v2 states base units ("20000"); the flat shape states a price ("$0.005").
    const rawAmount = offer.amount ?? offer.maxAmountRequired ??
      challenge.maxAmountRequired ?? challenge.amountUnits ?? challenge.amount ?? challenge.price;
    let requestedAmountUnits = null;
    if (typeof rawAmount === 'number' && Number.isInteger(rawAmount) && rawAmount > 0) {
      requestedAmountUnits = String(rawAmount);
    } else if (typeof rawAmount === 'string' && /^\d+$/.test(rawAmount.trim())) {
      requestedAmountUnits = rawAmount.trim();
    } else if (typeof rawAmount === 'string' && /[$.]/.test(rawAmount)) {
      requestedAmountUnits = parsePriceToUnits(rawAmount, 6).toString();
    }
    if (!requestedAmountUnits || !/^\d+$/.test(requestedAmountUnits) || BigInt(requestedAmountUnits) <= 0n) {
      throw new Error('[x402] The challenge carried no readable amount. Refusing to guess a price.');
    }
    if (BigInt(requestedAmountUnits) > this.maxAmountUnits) {
      throw new Error(`[x402 Security Policy] Requested amount (${requestedAmountUnits} units) exceeds local client authorized price ceiling (${this.maxAmountUnits.toString()} units / $${this.maxPriceUsd}).`);
    }
    const amountUnits = requestedAmountUnits;

    const now = Math.floor(Date.now() / 1000);
    // v2 servers bound the window with `maxTimeoutSeconds`; a longer window
    // than advertised is not more permissive, just outside what settles.
    const validAfter = isV2 ? '0' : now - 60;
    const validBefore = isV2 ? String(now + (Number(offer.maxTimeoutSeconds) || 120)) : now + 3600;
    const nonce = '0x' + crypto.randomBytes(32).toString('hex');

    const domain = {
      name: EIP712_TOKEN_NAME,
      version: EIP712_TOKEN_VERSION,
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

    const message = {
      from: typeof this.wallet.getAddress === 'function' ? await this.wallet.getAddress() : (this.wallet.address || this.wallet.account?.address),
      to: payTo,
      value: amountUnits.toString(),
      validAfter,
      validBefore,
      nonce
    };

    let signature;
    if (typeof this.wallet.signTypedData === 'function') {
      signature = await this.wallet.signTypedData(domain, types, message);
    } else if (typeof this.wallet._signTypedData === 'function') {
      signature = await this.wallet._signTypedData(domain, types, message);
    } else if (typeof this.wallet.signTypedDataV4 === 'function') {
      signature = await this.wallet.signTypedDataV4({ domain, types, message, primaryType: 'TransferWithAuthorization' });
    } else {
      throw new Error('Wallet does not implement EIP-712 signTypedData');
    }

    let v, r, s;
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

    if (isV2) {
      // The canonical v2 envelope. `accepted` is the offer echoed back verbatim:
      // the server deep-equality matches it against its own requirements to learn
      // which offer is being paid. Omitting it does not read as "no payment" --
      // it crashes the server's matcher, which then answers 402 with an opaque
      // body. Reconstructing the offer fails the same way, so it is passed
      // through untouched. Note there is no top-level scheme/network in v2:
      // both live inside `accepted`.
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
            from: message.from,
            to: message.to,
            value: message.value,
            validAfter: message.validAfter,
            validBefore: message.validBefore,
            nonce: message.nonce
          },
          signature: typeof signature === 'string' ? signature : `0x${r.slice(2)}${s.slice(2)}${v.toString(16)}`
        }
      };
    }

    // Legacy flat envelope, for servers that do not advertise `accepts`.
    return {
      x402Version: 2,
      scheme: 'eip3009',
      network: 'eip155:8453',
      token: tokenContract,
      authorization: {
        from: message.from,
        to: message.to,
        value: message.value,
        validAfter: message.validAfter,
        validBefore: message.validBefore,
        nonce: message.nonce,
        v,
        r,
        s
      }
    };
  }

  async fetchWithAutoPayment(path, options = {}) {
    const url = path.startsWith('http') ? path : `${this.baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;
    const initialRes = await this._makeHttpRequest(url, options);

    if (initialRes.status !== 402) {
      return initialRes;
    }

    const challengeHeader = initialRes.headers['payment-required'] || initialRes.headers['x402-payment-required'] || initialRes.headers['www-authenticate'];
    const challenge = parsePaymentHeader(challengeHeader) || (initialRes.json ? initialRes.json : null);

    if (!challenge) {
      throw new Error('Received HTTP 402 Payment Required but could not parse payment challenge header');
    }

    const paymentPayload = await this.signPaymentAuthorization(challenge);
    const paymentHeaderValue = Buffer.from(JSON.stringify(paymentPayload)).toString('base64');

    const paymentOptions = {
      ...options,
      headers: {
        ...(options.headers || {}),
        'PAYMENT-SIGNATURE': paymentHeaderValue,
        'Accept': 'application/json'
      }
    };

    return this._makeHttpRequest(url, paymentOptions);
  }

  _makeHttpRequest(urlStr, options = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(urlStr);
      const isHttps = url.protocol === 'https:';
      const client = isHttps ? https : http;

      const reqOptions = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: options.method || 'GET',
        headers: {
          'User-Agent': 'M2M-Sentinel-X402Signer/1.2.3',
          'Accept': 'application/json',
          ...(options.headers || {})
        },
        timeout: options.timeoutMs || this.timeoutMs
      };

      const req = client.request(reqOptions, (res) => {
        let rawData = '';
        res.on('data', (chunk) => { rawData += chunk; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(rawData); } catch (_) {}
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text: rawData,
            json
          });
        });
      });

      req.on('error', (err) => reject(err));
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });

      if (options.body) {
        req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
      }
      req.end();
    });
  }
}

module.exports = {
  X402SignerClient,
  x402SignerClient: (opts) => new X402SignerClient(opts),
  parsePaymentHeader,
  parsePriceToUnits
};
