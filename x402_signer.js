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

class X402SignerClient {
  constructor(options = {}) {
    this.wallet = options.wallet || options.walletSigner || null;
    this.baseUrl = (options.baseUrl || 'https://api.m2msentinel.com').replace(/\/+$/, '');
    this.timeoutMs = Number(options.timeoutMs || 30000);
  }

  async signPaymentAuthorization(challenge) {
    if (!this.wallet) {
      throw new Error('Signer wallet is required to sign x402 payment authorization');
    }

    const payTo = challenge.payTo || challenge.recipient || '0x6d6c398390cfb88f1cd42715b84906a0bd6652aa';
    const amountUnits = challenge.maxAmountRequired || challenge.amountUnits || parsePriceToUnits(challenge.amount || challenge.price || '$0.005', 6).toString();
    const tokenContract = challenge.assetContract || BASE_USDC_CONTRACT;
    const chainId = Number(challenge.chainId || BASE_CHAIN_ID);

    const now = Math.floor(Date.now() / 1000);
    const validAfter = now - 60;
    const validBefore = now + 3600;
    const nonce = '0x' + crypto.randomBytes(32).toString('hex');

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
          'User-Agent': 'M2M-Sentinel-X402Signer/1.1.1',
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
