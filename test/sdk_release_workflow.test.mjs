import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  dispatchContextFromEnvironment,
  preflightAliases,
  publishAliasesSequentially,
  runPreflightThenPublish,
  validateArtifactDispatch,
  validateDispatch,
  validateManifest
} from '../scripts/release/sdk-release.mjs';

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(TEST_DIRECTORY, '..');
const manifestPath = path.join(REPOSITORY_ROOT, 'release', 'sdk-1.2.8.json');
const workflowPath = path.join(REPOSITORY_ROOT, '.github', 'workflows', 'publish_sdk.yml');
const helperPath = path.join(REPOSITORY_ROOT, 'scripts', 'release', 'sdk-release.mjs');

function loadManifest() {
  return JSON.parse(readFileSync(manifestPath, 'utf8'));
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function withRegistry(states, callback) {
  const tarballs = new Map();
  const requests = [];
  const manifest = loadManifest();
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    requests.push({ host: url.hostname, path: url.pathname });
    const decodedPath = decodeURIComponent(url.pathname);
    if (decodedPath.startsWith('/tarball/')) {
      const packageName = decodedPath.slice('/tarball/'.length);
      const bytes = tarballs.get(packageName);
      if (!bytes) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/octet-stream' }).end(bytes);
      return;
    }

    const pkg = manifest.packages.find((entry) => decodedPath === `/${entry.name}/${entry.version}`);
    if (!pkg) {
      response.writeHead(404).end();
      return;
    }
    const state = states[pkg.name] ?? { status: 404 };
    if (state.status !== 200) {
      response.writeHead(state.status ?? 404).end();
      return;
    }
    const bytes = Buffer.from(state.bytes ?? `fixture:${pkg.name}`);
    tarballs.set(pkg.name, bytes);
    const port = server.address().port;
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      name: pkg.name,
      version: pkg.version,
      dist: { tarball: `http://127.0.0.1:${port}/tarball/${encodeURIComponent(pkg.name)}` }
    }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const registryOrigin = `http://127.0.0.1:${server.address().port}`;
  try {
    return await callback({ registryOrigin, requests });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function noNetworkVerifier(expectedByName) {
  return async (bytes, pkg) => {
    const expected = expectedByName[pkg.name];
    assert.ok(expected, `fixture archive was expected for ${pkg.name}`);
    assert.deepEqual(bytes, expected);
  };
}

test('release manifest binds both aliases and leaves root-only identity pending', () => {
  const manifest = loadManifest();
  assert.equal(validateManifest(manifest), manifest);
  assert.equal(manifest.release.version, '1.2.8');
  assert.equal(manifest.release.status, 'awaiting_root_confirmation');
  assert.equal(manifest.release.tag, '1.2.8');
  assert.equal(Object.hasOwn(manifest.release, 'sourceCommitSha'), false);
  assert.equal(manifest.packages.length, 2);
  assert.deepEqual(manifest.packages.map((pkg) => pkg.name).sort(), ['@m2msentinel/sdk', 'm2m-sentinel-sdk']);
  for (const pkg of manifest.packages) {
    assert.equal(pkg.files.length, 21);
    assert.equal(pkg.version, manifest.release.version);
    assert.match(pkg.archive.sha256, /^[a-f0-9]{64}$/);
    assert.match(pkg.archive.sha512, /^[a-f0-9]{128}$/);
  }
});

test('release manifest rejects a non-canonical public repository URL', () => {
  const tampered = loadManifest();
  tampered.repository.url = 'https://github.com/AntoineSakkalis/M2M-Sentinel.git';
  for (const pkg of tampered.packages) pkg.repositoryUrl = tampered.repository.url;
  assert.throws(() => validateManifest(tampered), /Release repository URL must be https:\/\/github\.com\/M2M-Sentinel\/m2m-sentinel-sdk\.git/);
});

test('workflow is manual-only, defaults publish off, and isolates OIDC to npm-release', () => {
  const workflow = readFileSync(workflowPath, 'utf8');
  const triggerBlock = workflow.slice(workflow.indexOf('on:'), workflow.indexOf('\npermissions:'));
  assert.match(triggerBlock, /workflow_dispatch:/);
  assert.doesNotMatch(triggerBlock, /^\s+(push|pull_request|schedule|workflow_run):/m);
  assert.match(triggerBlock, /publish_enabled:[\s\S]*?default: false/);
  const prepare = workflow.slice(workflow.indexOf('  prepare-and-verify:'), workflow.indexOf('  publish:'));
  const publisher = workflow.slice(workflow.indexOf('  publish:'));
  assert.doesNotMatch(prepare, /id-token:\s*write/);
  assert.match(publisher, /environment:\s*\n\s+name: npm-release/);
  assert.match(publisher, /contents:\s*read[\s\S]*id-token:\s*write/);
  assert.doesNotMatch(publisher, /npm\s+(ci|install)\b|NODE_AUTH_TOKEN|NPM_TOKEN|secrets\./);
  assert.doesNotMatch(workflow, /git tag|npm dist-tag|publish-mcp|publish-mcp\.yml|twine|pypi|server\.json/i);
  assert.match(publisher, /if:\s*\$\{\{\s*always\(\)\s*\}\}/);
  assert.match(publisher, /Print non-secret alias publication receipt/);
  const helper = readFileSync(helperPath, 'utf8');
  const validateCli = helper.slice(helper.indexOf("if (command === 'validate-dispatch')"), helper.indexOf("if (command === 'publish')"));
  assert.match(validateCli, /\.\.\.dispatchContextFromEnvironment\(process\.env\)/);
  assert.match(helper, /githubSha:\s*env\.GITHUB_SHA/);
  assert.match(helper, /githubRefType:\s*env\.GITHUB_REF_TYPE/);
  assert.match(helper, /const REGISTRY_ORIGIN = 'https:\/\/registry\.npmjs\.org'/);
});

test('dispatch identity requires the clean exact branch SHA and committed manifest bytes', () => {
  const manifest = loadManifest();
  const ready = structuredClone(manifest);
  ready.release.status = 'ready';
  ready.release.tag = '1.2.8';
  const raw = Buffer.from(JSON.stringify(ready));
  const sourceSha = 'a'.repeat(40);
  const dispatchContext = dispatchContextFromEnvironment({
    GITHUB_ACTOR: 'release-operator',
    SDK_RELEASE_DISPATCH_ACTOR: 'release-operator',
    GITHUB_REPOSITORY: 'M2M-Sentinel/m2m-sentinel-sdk',
    GITHUB_SHA: sourceSha,
    GITHUB_REF: 'refs/heads/release-review',
    GITHUB_REF_TYPE: 'branch'
  });
  const expected = {
    manifestBytes: raw,
    expectedVersion: '1.2.8',
    expectedSourceSha: sourceSha,
    expectedTag: '1.2.8',
    expectedManifestSha256: sha256(raw),
    ...dispatchContext
  };
  assert.deepEqual(validateArtifactDispatch(ready, expected), {
    version: '1.2.8', tag: '1.2.8', sourceSha, manifestSha256: sha256(raw)
  });
  assert.throws(() => validateArtifactDispatch(ready, { ...expected, expectedSourceSha: 'b'.repeat(40) }), /github\.sha/);
  assert.throws(() => validateArtifactDispatch(ready, { ...expected, expectedTag: 'v9.9.9' }), /tag does not match/);
  assert.throws(() => validateArtifactDispatch(ready, { ...expected, githubRefType: 'tag', githubRef: 'refs/tags/1.2.8' }), /reviewed branch/);
  assert.throws(() => validateArtifactDispatch(ready, { ...expected, githubActor: 'other' }), /release operator/);
});

test('dispatch rejects superseded Windows and tampered manifest digests', () => {
  const manifest = structuredClone(loadManifest());
  manifest.release.status = 'ready';
  manifest.release.tag = '1.2.8';
  const raw = Buffer.from(JSON.stringify(manifest));
  const directory = mkdtempSync(path.join(os.tmpdir(), 'sdk-release-digest-fixture-'));
  try {
    mkdirSync(path.join(directory, 'release'), { recursive: true });
    writeFileSync(path.join(directory, 'release', 'sdk-1.2.8.json'), raw);
    execFileSync('git', ['init', '-q'], { cwd: directory });
    execFileSync('git', ['config', 'user.name', 'SDK release test'], { cwd: directory });
    execFileSync('git', ['config', 'user.email', 'sdk-release-test@example.invalid'], { cwd: directory });
    execFileSync('git', ['add', 'release/sdk-1.2.8.json'], { cwd: directory });
    execFileSync('git', ['commit', '-q', '-m', 'release digest fixture'], { cwd: directory });
    const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: directory, encoding: 'utf8' }).trim();
    const expected = {
      manifestBytes: raw,
      expectedVersion: '1.2.8',
      expectedSourceSha: sourceSha,
      expectedTag: '1.2.8',
      expectedManifestSha256: sha256(raw),
      githubActor: 'release-operator',
      allowedActor: 'release-operator',
      githubRepository: 'M2M-Sentinel/m2m-sentinel-sdk',
      githubSha: sourceSha,
      githubRef: 'refs/heads/release-review',
      githubRefType: 'branch',
      remoteTagExists: () => false,
      repositoryRoot: directory
    };

    assert.equal(validateDispatch(manifest, expected).manifestSha256, sha256(raw));
    assert.throws(() => validateDispatch(manifest, {
      ...expected,
      expectedManifestSha256: '54a14c29ca823311f61184c90f42337bcb117e4bee89bf7c45a1cbcdcf3abf12'
    }), /Dispatch manifest SHA-256 does not match the committed manifest/);

    const tamperedBytes = Buffer.concat([raw, Buffer.from('\n')]);
    const tamperedManifest = JSON.parse(tamperedBytes.toString('utf8'));
    assert.throws(() => validateDispatch(tamperedManifest, {
      ...expected,
      manifestBytes: tamperedBytes
    }), /Dispatch manifest SHA-256 does not match the committed manifest/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test('dispatch validation rejects either v-prefixed or bare version tag', () => {
  for (const selectedTag of ['v1.2.8', '1.2.8']) {
    const manifest = structuredClone(loadManifest());
    manifest.release.status = 'ready';
    manifest.release.tag = selectedTag;
    const raw = Buffer.from(JSON.stringify(manifest));
    const directory = mkdtempSync(path.join(os.tmpdir(), 'sdk-release-git-fixture-'));
    try {
      mkdirSync(path.join(directory, 'release'), { recursive: true });
      writeFileSync(path.join(directory, 'release', 'sdk-1.2.8.json'), raw);
      execFileSync('git', ['init', '-q'], { cwd: directory });
      execFileSync('git', ['config', 'user.name', 'SDK release test'], { cwd: directory });
      execFileSync('git', ['config', 'user.email', 'sdk-release-test@example.invalid'], { cwd: directory });
      execFileSync('git', ['add', 'release/sdk-1.2.8.json'], { cwd: directory });
      execFileSync('git', ['commit', '-q', '-m', 'release manifest fixture'], { cwd: directory });
      const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: directory, encoding: 'utf8' }).trim();
      const counterpart = selectedTag.startsWith('v') ? '1.2.8' : 'v1.2.8';
      const seen = [];
      assert.throws(() => validateDispatch(manifest, {
        manifestBytes: raw,
        expectedVersion: '1.2.8',
        expectedSourceSha: sourceSha,
        expectedTag: selectedTag,
        expectedManifestSha256: sha256(raw),
        githubActor: 'release-operator',
        allowedActor: 'release-operator',
        githubRepository: 'M2M-Sentinel/m2m-sentinel-sdk',
        githubSha: sourceSha,
        githubRef: 'refs/heads/release-review',
        githubRefType: 'branch',
        remoteTagExists: (tag) => { seen.push(tag); return tag === counterpart; },
        repositoryRoot: directory
      }), /Expected release version tags to be absent/);
      assert.deepEqual(seen, ['v1.2.8', '1.2.8']);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test('read-only preflight treats both 404 versions as absent', async () => {
  const manifest = loadManifest();
  await withRegistry({}, async ({ registryOrigin, requests }) => {
    const result = await preflightAliases(manifest, { registryOrigin });
    assert.deepEqual(result.map((item) => item.state), ['absent', 'absent']);
    assert.equal(requests.length, 2);
    assert.ok(requests.every((item) => item.host === '127.0.0.1'));
  });
});

test('publish preflight checks both tag spellings before and after registry lookup', async () => {
  for (const existingTag of ['v1.2.8', '1.2.8']) {
    const manifest = loadManifest();
    manifest.release.tag = 'v1.2.8';
    const seen = [];
    let calls = 0;
    await assert.rejects(runPreflightThenPublish(manifest, {
      remoteTagExists: (tag) => { seen.push(tag); return tag === existingTag; },
      fetchImpl: async () => { calls += 1; throw new Error('registry lookup should not run'); },
      publish: async () => assert.fail('publish should not run')
    }), /Expected release version tags to be absent/);
    assert.deepEqual(seen, ['v1.2.8', '1.2.8']);
    assert.equal(calls, 0);
  }

  for (const appearingTag of ['v1.2.8', '1.2.8']) {
    const manifest = loadManifest();
    manifest.release.tag = 'v1.2.8';
    const seen = [];
    let tagChecks = 0;
    await withRegistry({}, async ({ registryOrigin, requests }) => {
      await assert.rejects(runPreflightThenPublish(manifest, {
        registryOrigin,
        remoteTagExists: (tag) => {
          seen.push(tag);
          tagChecks += 1;
          return tagChecks > 2 && tag === appearingTag;
        },
        fetchImpl: fetch,
        publish: async () => assert.fail('publish should not run')
      }), /Expected release version tags to be absent/);
      assert.equal(requests.length, 2);
    });
    assert.deepEqual(seen, ['v1.2.8', '1.2.8', 'v1.2.8', '1.2.8']);
  }
});

test('read-only preflight verifies and skips an exact existing alias', async () => {
  const manifest = loadManifest();
  const scoped = manifest.packages[0];
  const exactBytes = Buffer.from('exact accepted archive fixture');
  await withRegistry({ [scoped.name]: { status: 200, bytes: exactBytes } }, async ({ registryOrigin }) => {
    const result = await preflightAliases(manifest, {
      registryOrigin,
      verifyTarball: noNetworkVerifier({ [scoped.name]: exactBytes })
    });
    assert.deepEqual(result.map((item) => item.state), ['exact-existing', 'absent']);
    assert.deepEqual(result[0].bytes, exactBytes);
  });
});

test('a payload mismatch aborts preflight before either alias can publish', async () => {
  const manifest = loadManifest();
  const [scoped, unscoped] = manifest.packages;
  let publishCalls = 0;
  const directory = mkdtempSync(path.join(os.tmpdir(), 'sdk-release-preflight-test-'));
  const receiptPath = path.join(directory, 'receipt.json');
  try {
    await withRegistry({
      [scoped.name]: { status: 200, bytes: Buffer.from('scoped exact') },
      [unscoped.name]: { status: 200, bytes: Buffer.from('wrong payload') }
    }, async ({ registryOrigin }) => {
      await assert.rejects(runPreflightThenPublish(manifest, {
        registryOrigin,
        remoteTagExists: () => false,
        receiptPath,
        verifyTarball: async (bytes, pkg) => {
          if (pkg.name === scoped.name) assert.deepEqual(bytes, Buffer.from('scoped exact'));
          else assert.fail('unscoped payload must not match the committed alias bytes');
        },
        publish: async () => { publishCalls += 1; },
        verifyPublished: async () => {}
      }), /unscoped payload must not match/);
    });
    assert.equal(publishCalls, 0);
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    assert.equal(receipt.status, 'preflight-aborted');
    assert.ok(receipt.packages.every((pkg) => pkg.state === 'not-published'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a non-200 preflight response aborts before any publish', async () => {
  const manifest = loadManifest();
  let publishCalls = 0;
  await withRegistry({ [manifest.packages[0].name]: { status: 503 } }, async ({ registryOrigin }) => {
    await assert.rejects(runPreflightThenPublish(manifest, {
      registryOrigin,
      remoteTagExists: () => false,
      verifyTarball: async () => assert.fail('no tarball should be read'),
      publish: async () => { publishCalls += 1; },
      verifyPublished: async () => {}
    }), /HTTP 503/);
  });
  assert.equal(publishCalls, 0);
});

test('first alias success followed by second failure is reported partial, never both published', async () => {
  const manifest = loadManifest();
  const directory = mkdtempSync(path.join(os.tmpdir(), 'sdk-release-test-'));
  const receiptPath = path.join(directory, 'receipt.json');
  const published = [];
  try {
    await assert.rejects(publishAliasesSequentially(manifest, manifest.packages.map((pkg) => ({
      package: pkg.name,
      version: pkg.version,
      state: 'absent'
    })), {
      receiptPath,
      publish: async (pkg) => {
        published.push(pkg.name);
        if (pkg.name === manifest.packages[1].name) throw new Error('fixture publish failure');
      },
      verifyPublished: async () => {}
    }), /fixture publish failure/);
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    assert.equal(published.length, 2);
    assert.equal(receipt.status, 'partial-or-unknown');
    assert.notEqual(receipt.status, 'both-aliases-verified');
    assert.equal(receipt.packages[0].state, 'published-and-verified');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('retry skips the first alias after its exact tarball is visible and publishes only the second', async () => {
  const manifest = loadManifest();
  const [scoped, unscoped] = manifest.packages;
  const scopedBytes = Buffer.from('scoped exact after prior partial run');
  const published = [];
  const verified = [];
  await withRegistry({ [scoped.name]: { status: 200, bytes: scopedBytes } }, async ({ registryOrigin }) => {
    const receipt = await runPreflightThenPublish(manifest, {
      registryOrigin,
      remoteTagExists: () => false,
      verifyTarball: noNetworkVerifier({ [scoped.name]: scopedBytes }),
      publish: async (pkg) => { published.push(pkg.name); },
      verifyPublished: async (pkg) => { verified.push(pkg.name); }
    });
    assert.deepEqual(receipt.packages.map((item) => item.state), ['exact-existing', 'published-and-verified']);
  });
  assert.deepEqual(published, [unscoped.name]);
  assert.deepEqual(verified, [unscoped.name]);
});
