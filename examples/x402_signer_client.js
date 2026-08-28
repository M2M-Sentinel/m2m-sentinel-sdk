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
const { ethers } = require('ethers');

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
    this.wallet = options.wallet || (options.privateKey ? new ethers.Wallet(options.privateKey) : null);
    this.baseUrl = options.baseUrl || 'https://api.m2msentinel.com';
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

    // x402 v2 nests the offer under `accepts`. Reading the flat shape alone made
    // every lookup below miss, so the integrity checks passed vacuously and the
    // amount silently fell back to a hardcoded default -- signing an
    // authorization for less than the server demanded, which is refused. Read
    // the offer first, then keep the flat shape as a fallback for older servers.
    const offer = (Array.isArray(challenge.accepts) && challenge.accepts[0]) || challenge;
    const offeredChainId = typeof offer.network === 'string' && offer.network.startsWith('eip155:')
      ? Number(offer.network.slice('eip155:'.length))
      : (offer.chainId || challenge.chainId);
    // v2 carries the address in `asset`; the legacy shape carries a symbol there
    // and the address in `assetContract`. Only ever compare address to address,
    // so a symbol cannot be mistaken for a mismatched contract.
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
    // Never invent a price. Signing a guessed amount produces an authorization
    // the server refuses, which is indistinguishable from a rejected payment and
    // was exactly the failure this client shipped with.
    //
    // v2 states base units ("20000"); the legacy shape states a price ("$0.005").
    // Both are read, neither is assumed.
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

    // x402 v2 is identified by the presence of `accepts`. The two protocol
    // versions need different envelopes, and sending a v1 envelope to a v2
    // server is silently unpayable, so the version is decided once, here.
    const isV2 = Array.isArray(challenge.accepts) && challenge.accepts.length > 0;

    const now = Math.floor(Date.now() / 1000);
    // v2 servers bound the authorization window with `maxTimeoutSeconds`. A
    // longer window than the server advertised is not more permissive, it is
    // simply outside what the facilitator will settle.
    const validAfter = isV2 ? '0' : now - 60;
    const validBefore = isV2
      ? String(now + (Number(offer.maxTimeoutSeconds) || 120))
      : now + 3600;
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
      from: await this.wallet.getAddress(),
      to: payTo,
      value: amountUnits.toString(),
      validAfter,
      validBefore,
      nonce
    };

    let signature;
    if (typeof this.wallet.signTypedData === 'function') {
      signature = await this.wallet.signTypedData(domain, types, message);
    } else {
      signature = await this.wallet._signTypedData(domain, types, message);
    }

    const sigParts = ethers.Signature.from(signature);

    if (isV2) {
      // The canonical v2 envelope. `accepted` is the offer echoed back
      // verbatim: the server matches it against its own requirements with a
      // deep equality check to learn *which* offer is being paid. Omitting it
      // does not read as "no payment" -- it crashes the server's matcher, which
      // answers 402 with an opaque body. Reconstructing the offer instead of
      // echoing it fails the same way, so `offer` is passed through untouched.
      //
      // Note there is deliberately no top-level `scheme`/`network` here: in v2
      // they live inside `accepted`, and the payload schema does not carry them.
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
            validAfter,
            validBefore,
            nonce
          },
          signature
        }
      };
    }

    // Legacy flat envelope, for servers that do not advertise `accepts`.
    return {
      x402Version: 2,
      scheme: 'eip3009',
      network: 'base',
      chainId,
      asset: 'USDC',
      assetContract: tokenContract,
      authorization: {
        from: message.from,
        to: message.to,
        value: message.value,
        validAfter,
        validBefore,
        nonce,
        v: sigParts.v,
        r: sigParts.r,
        s: sigParts.s,
        signature
      }
    };
  }

  async request(endpointPath, options = {}) {
    const url = new URL(endpointPath, this.baseUrl);
    const isHttps = url.protocol === 'https:';
    const transport = isHttps ? https : http;

    const perform = (headers = {}) => new Promise((resolve, reject) => {
      const allHeaders = {
        Accept: 'application/json',
        'User-Agent': 'M2MSentinel-X402Signer/1.1.0',
        ...options.headers,
        ...headers
      };

      const req = transport.request(url, {
        method: options.method || 'GET',
        headers: allHeaders,
        timeout: this.timeoutMs
      }, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          let body = null;
          if (data) {
            try { body = JSON.parse(data); } catch (_) { body = { raw: data }; }
          }
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body
          });
        });
      });

      req.on('timeout', () => req.destroy(new Error('Request timeout')));
      req.on('error', reject);
      if (options.body) {
        req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
      }
      req.end();
    });

    // Step 1: initial request
    const firstRes = await perform();

    // If 200 OK or not 402, return immediately
    if (firstRes.statusCode !== 402) {
      return firstRes;
    }

    // Step 2: Extract payment challenge
    const challengeHeader = firstRes.headers['payment-required'] || firstRes.headers['x-payment-required'];
    let challenge = parsePaymentHeader(challengeHeader);
    if (!challenge && firstRes.body && (firstRes.body.accepts || firstRes.body.paymentRequired)) {
      challenge = firstRes.body.accepts ? firstRes.body.accepts[0] : firstRes.body.paymentRequired;
    }

    if (!challenge) {
      throw new Error('HTTP 402 received but no valid payment challenge was present');
    }

    // Step 3: Sign payment authorization
    const paymentPayload = await this.signPaymentAuthorization(challenge);
    const encodedPaymentHeader = Buffer.from(JSON.stringify(paymentPayload)).toString('base64');

    // Step 4: Re-submit request with payment authorization
    const paidRes = await perform({
      // x402 v2 uses PAYMENT-SIGNATURE for the signed retry. The old
      // payment-response names are response headers and are ignored by the
      // gateway, which made this otherwise-correct example unpayable.
      'PAYMENT-SIGNATURE': encodedPaymentHeader
    });

    paidRes.paymentPayload = paymentPayload;
    return paidRes;
  }
}

module.exports = {
  X402SignerClient,
  BASE_USDC_CONTRACT,
  BASE_CHAIN_ID,
  parsePaymentHeader,
  parsePriceToUnits
};

if (require.main === module) {
  console.log('M2M Sentinel Headless x402 Signer Client ready.');
}
