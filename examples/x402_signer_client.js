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

    // 2. STRICT CHALLENGE INTEGRITY CHECKS (Refuse if challenge alters network, asset, or recipient)
    if (challenge.chainId && Number(challenge.chainId) !== BASE_CHAIN_ID) {
      throw new Error(`[x402 Security Policy] Refusing to sign on unverified network chainId: ${challenge.chainId}. Autonomous signer strictly requires Base Mainnet (8453).`);
    }
    if (challenge.assetContract && challenge.assetContract.toLowerCase() !== BASE_USDC_CONTRACT.toLowerCase()) {
      throw new Error(`[x402 Security Policy] Refusing to sign for unapproved asset: ${challenge.assetContract}. Autonomous signer strictly requires Base USDC (${BASE_USDC_CONTRACT}).`);
    }
    if (challenge.payTo && challenge.payTo.toLowerCase() !== EXPECTED_PAYOUT_RECIPIENT.toLowerCase()) {
      throw new Error(`[x402 Security Policy] Refusing to sign for unexpected recipient: ${challenge.payTo}. Autonomous signer strictly requires ${EXPECTED_PAYOUT_RECIPIENT}.`);
    }
    if (challenge.tokenName && challenge.tokenName !== EIP712_TOKEN_NAME) {
      throw new Error(`[x402 Security Policy] Refusing to sign for unexpected tokenName: ${challenge.tokenName}. Expected ${EIP712_TOKEN_NAME}.`);
    }
    if (challenge.tokenVersion && challenge.tokenVersion !== EIP712_TOKEN_VERSION) {
      throw new Error(`[x402 Security Policy] Refusing to sign for unexpected tokenVersion: ${challenge.tokenVersion}. Expected ${EIP712_TOKEN_VERSION}.`);
    }

    // 3. STRICT LOCAL PRICE CEILING CHECK
    const requestedAmountUnits = challenge.maxAmountRequired || challenge.amountUnits || parsePriceToUnits(challenge.amount || challenge.price || '$0.005', 6).toString();
    if (BigInt(requestedAmountUnits) > this.maxAmountUnits) {
      throw new Error(`[x402 Security Policy] Requested amount (${requestedAmountUnits} units) exceeds local client authorized price ceiling (${this.maxAmountUnits.toString()} units / $${this.maxPriceUsd}).`);
    }
    const amountUnits = requestedAmountUnits;

    const now = Math.floor(Date.now() / 1000);
    const validAfter = now - 60;
    const validBefore = now + 3600;
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
      'x-payment-response': encodedPaymentHeader,
      'payment-response': encodedPaymentHeader
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
