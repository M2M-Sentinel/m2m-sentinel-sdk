#!/usr/bin/env node
'use strict';

const { M2MSentinelClient } = require('../index.js');

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

function localTestBaseUrl(value) {
  if (!value) return undefined;
  let url;
  try {
    url = new URL(value);
  } catch (_) {
    throw new Error('M2M_SENTINEL_DEMO_BASE_URL must be a loopback HTTP URL for local tests.');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'http:' || !loopback || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('M2M_SENTINEL_DEMO_BASE_URL must be a loopback HTTP origin for local tests.');
  }
  return url.origin;
}

async function main() {
  let baseUrl;
  try {
    baseUrl = localTestBaseUrl(process.env.M2M_SENTINEL_DEMO_BASE_URL);
  } catch (error) {
    console.error(error.message);
    return 1;
  }

  // This example supplies no API key, payment signature, wallet, or payment handler.
  const client = new M2MSentinelClient({ baseUrl });
  try {
    const result = await client.demoAudit(USDC);
    console.log(JSON.stringify(result, null, 2));
    return 0;
  } catch (error) {
    if (error.status === 429) {
      const retryAfter = error.retryAfter ? ` Retry-After: ${error.retryAfter}.` : '';
      console.error(`Public demo rate limited (HTTP 429). No retry was attempted.${retryAfter}`);
    } else if (error.status === 503) {
      console.error('Public demo evidence source is unavailable (HTTP 503). No fallback or paid request was attempted.');
    } else {
      console.error(`Public demo request failed${error.status ? ` (HTTP ${error.status})` : ''}: ${error.message}`);
    }
    return 1;
  }
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(`Public demo example failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { main, USDC };
