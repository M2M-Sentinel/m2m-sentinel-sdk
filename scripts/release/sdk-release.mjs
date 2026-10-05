import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIRECTORY, '../..');
const REGISTRY_ORIGIN = 'https://registry.npmjs.org';
const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024;

function fail(message) {
  throw new Error(message);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function sha512(bytes) {
  return createHash('sha512').update(bytes).digest('hex');
}

function sha512Sri(bytes) {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

function readManifest(manifestPath) {
  const raw = readFileSync(manifestPath);
  const manifest = JSON.parse(raw.toString('utf8'));
  validateManifest(manifest);
  return { manifest, raw };
}

export function validateManifest(manifest) {
  if (manifest?.schemaVersion !== 1) fail('Unsupported SDK release manifest schema');
  if (manifest.repository?.owner !== 'M2M-Sentinel' || manifest.repository?.name !== 'm2m-sentinel-sdk') {
    fail('Release repository must be M2M-Sentinel/m2m-sentinel-sdk');
  }
  if (manifest.repository?.url !== 'https://github.com/M2M-Sentinel/m2m-sentinel-sdk.git') {
    fail('Release repository URL must be https://github.com/M2M-Sentinel/m2m-sentinel-sdk.git');
  }
  if (manifest.workflow?.file !== 'publish_sdk.yml' || manifest.workflow?.environment !== 'npm-release') {
    fail('Release workflow identity must use publish_sdk.yml and npm-release');
  }
  if (!/^\d+\.\d+\.\d+$/.test(manifest.release?.version ?? '')) fail('Release version must be exact semver');
  if ('sourceCommitSha' in (manifest.release ?? {})) fail('Source commit SHA must be a dispatch input, not a self-referential manifest field');
  if (!Array.isArray(manifest.packages) || manifest.packages.length !== 2) fail('Manifest must bind both npm aliases');
  if (!Array.isArray(manifest.sharedFiles) || manifest.sharedFiles.length !== 20) fail('Manifest must bind the 20 shared tar members');
  if (manifest.toolchain?.nodeVersion !== '22.23.2' || manifest.toolchain?.npmVersion !== '11.6.2') {
    fail('Release toolchain must be Node 22.23.2 and npm 11.6.2');
  }
  if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(manifest.toolchain?.npmPackageIntegrity ?? '')) {
    fail('Pinned npm CLI integrity is missing or malformed');
  }

  const aliases = new Set();
  const normalizedFiles = [];
  for (const pkg of manifest.packages) {
    if (!['@m2msentinel/sdk', 'm2m-sentinel-sdk'].includes(pkg.name)) fail(`Unexpected package alias: ${pkg.name}`);
    if (aliases.has(pkg.name)) fail(`Duplicate package alias: ${pkg.name}`);
    aliases.add(pkg.name);
    if (pkg.version !== manifest.release.version) fail(`Version mismatch for ${pkg.name}`);
    if (pkg.repositoryUrl !== manifest.repository.url) fail(`Repository URL mismatch for ${pkg.name}`);
    if (!/^\d+$/.test(String(pkg.archive?.size ?? ''))) fail(`Archive size missing for ${pkg.name}`);
    if (!/^[a-f0-9]{64}$/.test(pkg.archive?.sha256 ?? '') || !/^[a-f0-9]{128}$/.test(pkg.archive?.sha512 ?? '')) {
      fail(`Archive digests malformed for ${pkg.name}`);
    }
    if (!Array.isArray(pkg.files) || pkg.files.length !== 21) fail(`Expected 21 archive members for ${pkg.name}`);
    const paths = new Set();
    for (const file of pkg.files) {
      if (typeof file.path !== 'string' || !file.path.startsWith('package/') || file.path.includes('..') || file.path.includes('\\')) {
        fail(`Unsafe tar path in ${pkg.name}: ${file.path}`);
      }
      if (paths.has(file.path)) fail(`Duplicate tar path in ${pkg.name}: ${file.path}`);
      paths.add(file.path);
      if (!/^\d+$/.test(String(file.size)) || !/^[a-f0-9]{64}$/.test(file.sha256 ?? '')) {
        fail(`Malformed member digest in ${pkg.name}: ${file.path}`);
      }
    }
    if (!paths.has('package/package.json')) fail(`Missing package.json member for ${pkg.name}`);
    normalizedFiles.push(new Map(pkg.files.map((file) => [file.path, `${file.size}:${file.sha256}`])));
  }
  if (!aliases.has('@m2msentinel/sdk') || !aliases.has('m2m-sentinel-sdk')) fail('Both scoped and unscoped aliases are required');

  const [left, right] = normalizedFiles;
  for (const file of manifest.sharedFiles) {
    if (file.path === 'package/package.json') fail('package.json must be represented per alias');
    for (const map of normalizedFiles) {
      if (map.get(file.path) !== `${file.size}:${file.sha256}`) fail(`Shared file mismatch: ${file.path}`);
    }
  }
  const sharedPaths = new Set(manifest.sharedFiles.map((file) => file.path));
  const allPaths = new Set([...left.keys(), ...right.keys()]);
  if (allPaths.size !== 21) fail('Alias path sets are not identical');
  for (const member of allPaths) {
    if (member !== 'package/package.json' && !sharedPaths.has(member)) fail(`Unexpected non-shared member: ${member}`);
  }
  return manifest;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    ...options
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const details = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    fail(`${command} ${args.join(' ')} failed${details ? `:\n${details}` : ''}`);
  }
  return result;
}

function runBinary(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: null, maxBuffer: MAX_ARCHIVE_BYTES * 2, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const details = result.stderr?.toString('utf8').trim();
    fail(`${command} ${args.join(' ')} failed${details ? `: ${details}` : ''}`);
  }
  return result.stdout;
}

function compareMemberList(actual, expected, label) {
  const normalized = [...actual].sort();
  const wanted = [...expected].sort();
  if (normalized.length !== wanted.length || normalized.some((item, index) => item !== wanted[index])) {
    fail(`${label} member paths differ from the committed manifest`);
  }
}

export function verifyArchiveFile(archivePath, pkg, { tarCommand = 'tar' } = {}) {
  const actualSize = statSync(archivePath).size;
  if (actualSize !== pkg.archive.size) fail(`${pkg.name} tarball size mismatch`);
  const archiveBytes = readFileSync(archivePath);
  if (sha256(archiveBytes) !== pkg.archive.sha256 || sha512(archiveBytes) !== pkg.archive.sha512) {
    fail(`${pkg.name} tarball digest mismatch`);
  }

  const listing = run(tarCommand, ['-tzf', archivePath]).stdout.trimEnd().split(/\r?\n/).filter(Boolean);
  const members = listing.filter((entry) => !entry.endsWith('/'));
  const expectedByPath = new Map(pkg.files.map((file) => [file.path, file]));
  compareMemberList(members, expectedByPath.keys(), pkg.name);
  for (const [memberPath, expected] of expectedByPath) {
    const bytes = runBinary(tarCommand, ['-xOzf', archivePath, memberPath]);
    if (bytes.length !== expected.size || sha256(bytes) !== expected.sha256) {
      fail(`${pkg.name} member bytes mismatch: ${memberPath}`);
    }
  }
  return { archiveSize: actualSize, archiveSha256: pkg.archive.sha256, memberCount: members.length };
}

export function packCandidateAliases({ manifest, repoRoot = REPOSITORY_ROOT, npmCliPath, destination }) {
  validateManifest(manifest);
  if (!npmCliPath || !existsSync(npmCliPath)) fail('An exact npm CLI path is required for local packing');
  const npmVersion = run(process.execPath, [npmCliPath, '--version']).stdout.trim();
  if (npmVersion !== manifest.toolchain.npmVersion) fail('Packing requires the exact npm 11.6.2 CLI');
  if (existsSync(destination)) {
    if (!statSync(destination).isDirectory() || readdirSync(destination).length !== 0) fail('Pack destination must be fresh or empty');
  } else {
    mkdirSync(destination, { recursive: true });
  }
  return manifest.packages.map((pkg) => packAlias(repoRoot, pkg, npmCliPath, destination));
}

async function verifyArchiveBuffer(bytes, pkg) {
  if (bytes.length > MAX_ARCHIVE_BYTES) fail(`${pkg.name} registry tarball exceeds the size limit`);
  const directory = mkdtempSync(path.join(os.tmpdir(), 'sdk-release-registry-'));
  const archivePath = path.join(directory, 'registry.tgz');
  try {
    writeFileSync(archivePath, bytes);
    return verifyArchiveFile(archivePath, pkg);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function packageFilesToStage(pkgJson) {
  if (!Array.isArray(pkgJson.files)) fail('Source package.json must contain an explicit files allowlist');
  const sourceFiles = ['package.json', 'LICENSE', ...pkgJson.files];
  return [...new Set(sourceFiles)];
}

function replacePackageNameBytes(raw, fromName, toName) {
  const source = raw.toString('utf8');
  const before = `"name": ${JSON.stringify(fromName)}`;
  const after = `"name": ${JSON.stringify(toName)}`;
  const first = source.indexOf(before);
  if (first === -1 || source.indexOf(before, first + before.length) !== -1) {
    fail('Could not identify a unique package name field for the unscoped alias');
  }
  const changed = source.slice(0, first) + after + source.slice(first + before.length);
  if (JSON.parse(changed).name !== toName) fail('Unscoped package manifest name rewrite failed');
  return Buffer.from(changed, 'utf8');
}

function makeNpmEnv(userNpmrc, globalNpmrc, cacheDirectory, extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.NODE_AUTH_TOKEN;
  delete env.NPM_TOKEN;
  delete env.npm_config_userconfig;
  delete env.npm_config_globalconfig;
  env.NPM_CONFIG_USERCONFIG = userNpmrc;
  env.NPM_CONFIG_GLOBALCONFIG = globalNpmrc;
  env.NPM_CONFIG_CACHE = cacheDirectory;
  env.NPM_CONFIG_AUDIT = 'false';
  env.NPM_CONFIG_FUND = 'false';
  env.NPM_CONFIG_UPDATE_NOTIFIER = 'false';
  return env;
}

function packAlias(repoRoot, pkg, npmCliPath, destination) {
  const sourceManifestPath = path.join(repoRoot, 'package.json');
  const sourceManifestBytes = readFileSync(sourceManifestPath);
  const sourceManifest = JSON.parse(sourceManifestBytes.toString('utf8'));
  if (sourceManifest.version !== pkg.version) fail(`Source version mismatch for ${pkg.name}`);
  if (sourceManifest.repository?.url !== pkg.repositoryUrl) fail(`Source repository URL mismatch for ${pkg.name}`);
  const stage = mkdtempSync(path.join(os.tmpdir(), 'sdk-release-stage-'));
  const emptyUserNpmrc = path.join(stage, '.npmrc-user-empty');
  const emptyGlobalNpmrc = path.join(stage, '.npmrc-global-empty');
  writeFileSync(emptyUserNpmrc, '');
  writeFileSync(emptyGlobalNpmrc, '');
  const cacheDirectory = path.join(stage, '.npm-cache');
  mkdirSync(destination, { recursive: true });
  try {
    const packageManifestBytes = pkg.name === sourceManifest.name
      ? sourceManifestBytes
      : replacePackageNameBytes(sourceManifestBytes, sourceManifest.name, pkg.name);
    writeFileSync(path.join(stage, 'package.json'), packageManifestBytes);
    for (const sourcePath of packageFilesToStage(sourceManifest)) {
      if (sourcePath === 'package.json') continue;
      if (path.isAbsolute(sourcePath) || sourcePath.split(/[\\/]/).includes('..')) fail(`Unsafe source path in package.files: ${sourcePath}`);
      const from = path.join(repoRoot, sourcePath);
      const to = path.join(stage, sourcePath);
      if (!existsSync(from) || !statSync(from).isFile()) fail(`Allowlisted package file is missing: ${sourcePath}`);
      mkdirSync(path.dirname(to), { recursive: true });
      copyFileSync(from, to);
    }
    const result = run(process.execPath, [npmCliPath, 'pack', '--ignore-scripts', '--json', '--pack-destination', destination], {
      cwd: stage,
      env: makeNpmEnv(emptyUserNpmrc, emptyGlobalNpmrc, cacheDirectory)
    });
    const packInfo = JSON.parse(result.stdout.trim());
    if (!Array.isArray(packInfo) || packInfo.length !== 1 || typeof packInfo[0].filename !== 'string') {
      fail(`npm pack returned an unexpected result for ${pkg.name}`);
    }
    const producedArchive = path.join(destination, packInfo[0].filename);
    const expectedArchive = path.join(destination, pkg.archive.file);
    if (path.resolve(producedArchive) !== path.resolve(expectedArchive)) {
      if (existsSync(expectedArchive)) rmSync(expectedArchive);
      copyFileSync(producedArchive, expectedArchive);
      rmSync(producedArchive);
    }
    verifyArchiveFile(expectedArchive, pkg);
    return expectedArchive;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

async function downloadNpmCli(manifest, destination, fetchImpl = fetch) {
  const url = new URL(manifest.toolchain.npmPackageTarball);
  if (url.protocol !== 'https:' || url.hostname !== 'registry.npmjs.org' || url.pathname !== '/npm/-/npm-11.6.2.tgz') {
    fail('Pinned npm CLI tarball URL is not the official npm registry artifact');
  }
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(30_000), redirect: 'error' });
  if (!response.ok) fail(`Could not download the pinned npm CLI artifact (HTTP ${response.status})`);
  if (response.url && new URL(response.url).origin !== url.origin) fail('Pinned npm CLI download left the official registry origin');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_ARCHIVE_BYTES || sha512Sri(bytes) !== manifest.toolchain.npmPackageIntegrity) {
    fail('Pinned npm CLI tarball failed its integrity check');
  }
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, bytes);
  return destination;
}

function extractNpmCli(archivePath, destination) {
  mkdirSync(destination, { recursive: true });
  run('tar', ['-xzf', archivePath, '-C', destination]);
  const packageJson = JSON.parse(readFileSync(path.join(destination, 'package', 'package.json'), 'utf8'));
  if (packageJson.name !== 'npm' || packageJson.version !== '11.6.2') fail('Extracted npm CLI version does not match the release manifest');
  const cliPath = path.join(destination, 'package', 'bin', 'npm-cli.js');
  if (!existsSync(cliPath)) fail('Pinned npm CLI entry point is missing');
  return cliPath;
}

function ensureNodeVersion(manifest) {
  if (process.version !== `v${manifest.toolchain.nodeVersion}`) {
    fail(`Expected Node v${manifest.toolchain.nodeVersion}, found ${process.version}`);
  }
}

async function prepareBundle({ manifestPath, outputDirectory, repoRoot = REPOSITORY_ROOT }) {
  const { manifest } = readManifest(manifestPath);
  ensureNodeVersion(manifest);
  if (existsSync(outputDirectory)) {
    if (!statSync(outputDirectory).isDirectory() || readdirSync(outputDirectory).length !== 0) {
      fail('Prepare output directory must be fresh or empty');
    }
  } else {
    mkdirSync(outputDirectory, { recursive: true });
  }
  const toolchainDirectory = path.join(outputDirectory, 'toolchain');
  const npmArchivePath = path.join(toolchainDirectory, 'npm-11.6.2.tgz');
  const npmCliDirectory = path.join(toolchainDirectory, 'npm-cli');
  await downloadNpmCli(manifest, npmArchivePath);
  const npmCliPath = extractNpmCli(npmArchivePath, npmCliDirectory);
  const versionResult = run(process.execPath, [npmCliPath, '--version']);
  if (versionResult.stdout.trim() !== manifest.toolchain.npmVersion) fail('Extracted npm CLI reported an unexpected version');
  const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  if (packageJson.repository?.url !== manifest.repository.url) fail('Candidate package repository URL differs from the release manifest');
  const archivesDirectory = path.join(outputDirectory, 'archives');
  const archives = packCandidateAliases({ manifest, repoRoot, npmCliPath, destination: archivesDirectory });
  const bundleDirectory = path.join(outputDirectory, 'publish-bundle');
  mkdirSync(bundleDirectory, { recursive: true });
  copyFileSync(manifestPath, path.join(bundleDirectory, 'sdk-1.2.8.json'));
  copyFileSync(fileURLToPath(import.meta.url), path.join(bundleDirectory, 'sdk-release.mjs'));
  for (const archive of archives) copyFileSync(archive, path.join(bundleDirectory, path.basename(archive)));
  copyFileSync(npmArchivePath, path.join(bundleDirectory, 'npm-11.6.2.tgz'));
  return { archives, npmArchivePath, npmCliPath, bundleDirectory };
}

function gitOutput(args, cwd = REPOSITORY_ROOT) {
  return run('git', args, { cwd }).stdout.trim();
}

export function dispatchContextFromEnvironment(env) {
  return {
    githubActor: env.GITHUB_ACTOR,
    allowedActor: env.SDK_RELEASE_DISPATCH_ACTOR,
    githubRepository: env.GITHUB_REPOSITORY,
    githubSha: env.GITHUB_SHA,
    githubRef: env.GITHUB_REF,
    githubRefType: env.GITHUB_REF_TYPE
  };
}

export function validateDispatch(manifest, {
  manifestBytes,
  expectedVersion,
  expectedSourceSha,
  expectedTag,
  expectedManifestSha256,
  githubActor,
  allowedActor,
  githubRepository,
  githubSha,
  githubRef,
  githubRefType,
  remoteTagExists = defaultRemoteTagExists,
  repositoryRoot = REPOSITORY_ROOT
}) {
  validateManifest(manifest);
  if (manifest.release.status !== 'ready') fail('Release manifest is not root-confirmed and ready');
  if (typeof manifest.release.tag !== 'string' || !/^(v)?\d+\.\d+\.\d+$/.test(manifest.release.tag)) {
    fail('Manifest tag must be an exact semver tag with an optional v prefix');
  }
  const tagVersion = manifest.release.tag.startsWith('v') ? manifest.release.tag.slice(1) : manifest.release.tag;
  if (tagVersion !== manifest.release.version) fail('Manifest tag version does not match the release version');
  if (expectedVersion !== manifest.release.version) fail('Dispatch version does not match the committed release manifest');
  if (expectedTag !== manifest.release.tag) fail('Dispatch tag does not match the committed release manifest');
  if (!/^[a-f0-9]{40}$/.test(expectedSourceSha ?? '') || expectedSourceSha !== githubSha) {
    fail('Dispatch source SHA must exactly equal github.sha');
  }
  if (!/^[a-f0-9]{64}$/.test(expectedManifestSha256 ?? '')) fail('Dispatch requires the exact committed manifest SHA-256');
  if (sha256(manifestBytes) !== expectedManifestSha256) fail('Dispatch manifest SHA-256 does not match the committed manifest');
  if (!allowedActor || githubActor !== allowedActor) fail('Dispatch actor is not the configured release operator');
  if ((githubRepository ?? '').toLowerCase() !== 'm2m-sentinel/m2m-sentinel-sdk') fail('Workflow is running outside M2M-Sentinel/m2m-sentinel-sdk');
  if (!/^[a-f0-9]{40}$/.test(githubSha ?? '') || githubRefType !== 'branch' || !githubRef?.startsWith('refs/heads/')) {
    fail('Workflow must run from a clean reviewed branch commit; tag refs are not accepted');
  }

  if (gitOutput(['rev-parse', 'HEAD'], repositoryRoot) !== githubSha) fail('Checked-out HEAD does not equal github.sha');
  if (gitOutput(['status', '--porcelain=v1', '--untracked-files=all'], repositoryRoot)) fail('Checked-out source tree is not clean');
  run('git', ['ls-files', '--error-unmatch', 'release/sdk-1.2.8.json'], { cwd: repositoryRoot });
  const committedManifest = run('git', ['show', 'HEAD:release/sdk-1.2.8.json'], { cwd: repositoryRoot }).stdout;
  if (sha256(Buffer.from(committedManifest, 'utf8')) !== expectedManifestSha256) fail('Manifest bytes are not committed at checked-out HEAD');
  assertReleaseVersionTagsAbsent(manifest.release.version, manifest.repository.url, remoteTagExists);
  return { version: manifest.release.version, tag: expectedTag, sourceSha: expectedSourceSha, manifestSha256: expectedManifestSha256 };
}

export function validateArtifactDispatch(manifest, {
  manifestBytes,
  expectedVersion,
  expectedSourceSha,
  expectedTag,
  expectedManifestSha256,
  githubActor,
  allowedActor,
  githubRepository,
  githubSha,
  githubRef,
  githubRefType
}) {
  validateManifest(manifest);
  if (manifest.release.status !== 'ready') fail('Release manifest is not root-confirmed and ready');
  if (typeof manifest.release.tag !== 'string' || !/^(v)?\d+\.\d+\.\d+$/.test(manifest.release.tag)) {
    fail('Manifest tag must be an exact semver tag with an optional v prefix');
  }
  const tagVersion = manifest.release.tag.startsWith('v') ? manifest.release.tag.slice(1) : manifest.release.tag;
  if (tagVersion !== manifest.release.version) fail('Manifest tag version does not match the release version');
  if (expectedVersion !== manifest.release.version) fail('Dispatch version does not match the committed release manifest');
  if (expectedTag !== manifest.release.tag) fail('Dispatch tag does not match the committed release manifest');
  if (!/^[a-f0-9]{40}$/.test(expectedSourceSha ?? '') || expectedSourceSha !== githubSha) {
    fail('Dispatch source SHA must exactly equal github.sha');
  }
  if (!/^[a-f0-9]{64}$/.test(expectedManifestSha256 ?? '') || sha256(manifestBytes) !== expectedManifestSha256) {
    fail('Dispatch manifest SHA-256 does not match the bundled manifest');
  }
  if (!allowedActor || githubActor !== allowedActor) fail('Dispatch actor is not the configured release operator');
  if ((githubRepository ?? '').toLowerCase() !== 'm2m-sentinel/m2m-sentinel-sdk') fail('Workflow is running outside M2M-Sentinel/m2m-sentinel-sdk');
  if (githubRefType !== 'branch' || !githubRef?.startsWith('refs/heads/')) fail('Workflow must run from a reviewed branch; tag refs are not accepted');
  return { version: manifest.release.version, tag: expectedTag, sourceSha: expectedSourceSha, manifestSha256: expectedManifestSha256 };
}

function defaultRemoteTagExists(tag, repositoryUrl) {
  const result = spawnSync('git', ['ls-remote', '--refs', repositoryUrl, `refs/tags/${tag}`], {
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  });
  if (result.error) throw result.error;
  if (result.status !== 0) fail(`Could not read remote tag state for ${tag}`);
  return Boolean(result.stdout.trim());
}

function assertReleaseVersionTagsAbsent(version, repositoryUrl, remoteTagExists) {
  const tags = [`v${version}`, version];
  const present = tags.filter((tag) => remoteTagExists(tag, repositoryUrl));
  if (present.length) fail(`Expected release version tags to be absent; found: ${present.join(', ')}`);
}

function metadataUrl(packageName, version, registryOrigin = REGISTRY_ORIGIN) {
  const encodedName = packageName.startsWith('@') ? packageName.replace('/', '%2f') : encodeURIComponent(packageName);
  return `${registryOrigin}/${encodedName}/${encodeURIComponent(version)}`;
}

async function downloadRegistryTarball(metadata, fetchImpl, registryOrigin) {
  const url = new URL(metadata.dist?.tarball ?? '');
  const expectedOrigin = new URL(registryOrigin);
  if (url.origin !== expectedOrigin.origin || !['https:', 'http:'].includes(url.protocol)) fail('Registry metadata points outside the configured registry');
  if (expectedOrigin.hostname !== '127.0.0.1' && expectedOrigin.hostname !== 'localhost' && url.protocol !== 'https:') {
    fail('Non-loopback registry tarballs must use HTTPS');
  }
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(30_000), redirect: 'error' });
  if (!response.ok) fail(`Could not read the existing registry tarball (HTTP ${response.status})`);
  if (response.url && new URL(response.url).origin !== expectedOrigin.origin) fail('Registry tarball response redirected outside the configured registry');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_ARCHIVE_BYTES) fail('Registry tarball exceeds the safe size limit');
  return bytes;
}

export async function preflightAliases(manifest, {
  fetchImpl = fetch,
  verifyTarball = verifyArchiveBuffer,
  registryOrigin = REGISTRY_ORIGIN
} = {}) {
  validateManifest(manifest);
  const results = [];
  for (const pkg of manifest.packages) {
    const response = await fetchImpl(metadataUrl(pkg.name, pkg.version, registryOrigin), {
      headers: { accept: 'application/vnd.npm.install-v1+json' },
      signal: AbortSignal.timeout(30_000),
      redirect: 'error'
    });
    if (response.status === 404) {
      results.push({ package: pkg.name, version: pkg.version, state: 'absent' });
      continue;
    }
    if (!response.ok) fail(`Read-only registry preflight failed for ${pkg.name}@${pkg.version} (HTTP ${response.status})`);
    if (response.url && new URL(response.url).origin !== new URL(registryOrigin).origin) fail('Registry metadata response redirected outside the configured registry');
    const metadata = await response.json();
    if (metadata.name !== pkg.name || metadata.version !== pkg.version) fail(`Registry identity mismatch for ${pkg.name}@${pkg.version}`);
    const bytes = await downloadRegistryTarball(metadata, fetchImpl, registryOrigin);
    await verifyTarball(bytes, pkg);
    results.push({ package: pkg.name, version: pkg.version, state: 'exact-existing', bytes });
  }
  return results;
}

async function verifyPublished(pkg, {
  fetchImpl,
  verifyTarball,
  registryOrigin = REGISTRY_ORIGIN,
  attempts = 6,
  delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const response = await fetchImpl(metadataUrl(pkg.name, pkg.version, registryOrigin), {
      headers: { accept: 'application/vnd.npm.install-v1+json' },
      signal: AbortSignal.timeout(30_000),
      redirect: 'error'
    });
    if (response.status === 404 && attempt + 1 < attempts) {
      await delay(Math.min(1000 * (attempt + 1), 5000));
      continue;
    }
    if (!response.ok) fail(`Post-publish verification failed for ${pkg.name}@${pkg.version} (HTTP ${response.status})`);
    if (response.url && new URL(response.url).origin !== new URL(registryOrigin).origin) fail('Post-publish metadata response redirected outside the configured registry');
    const metadata = await response.json();
    if (metadata.name !== pkg.name || metadata.version !== pkg.version) fail(`Post-publish registry identity mismatch for ${pkg.name}`);
    const bytes = await downloadRegistryTarball(metadata, fetchImpl, registryOrigin);
    await verifyTarball(bytes, pkg);
    return;
  }
  fail(`Registry did not expose ${pkg.name}@${pkg.version} after publish`);
}

function saveReceipt(receiptPath, receipt) {
  if (!receiptPath) return;
  mkdirSync(path.dirname(receiptPath), { recursive: true });
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
}

export async function publishAliasesSequentially(manifest, preflight, {
  publish,
  verifyPublished,
  receiptPath,
  onStatus = () => {}
}) {
  if (preflight.length !== manifest.packages.length) fail('Both aliases must finish preflight before publishing');
  const preflightKeys = new Set(preflight.map((item) => `${item.package}@${item.version}`));
  if (preflightKeys.size !== manifest.packages.length || manifest.packages.some((pkg) => !preflightKeys.has(`${pkg.name}@${pkg.version}`))) {
    fail('Preflight results do not uniquely cover both committed aliases');
  }
  if (preflight.some((item) => !['absent', 'exact-existing'].includes(item.state))) fail('Preflight contains an unsafe alias state');
  const receipt = { status: 'preflight-complete', packages: preflight.map((item) => ({ package: item.package, version: item.version, state: item.state })) };
  saveReceipt(receiptPath, receipt);
  try {
    for (const pkg of manifest.packages) {
      const item = preflight.find((candidate) => candidate.package === pkg.name && candidate.version === pkg.version);
      if (!item) fail(`No preflight result for ${pkg.name}@${pkg.version}`);
      if (item.state === 'exact-existing') {
        onStatus({ package: pkg.name, state: 'exact-existing-skipped' });
        continue;
      }
      if (item.state !== 'absent') fail(`Unsafe preflight state for ${pkg.name}: ${item.state}`);
      const status = receipt.packages.find((candidate) => candidate.package === pkg.name);
      status.state = 'publishing';
      saveReceipt(receiptPath, receipt);
      await publish(pkg);
      status.state = 'publish-command-succeeded';
      saveReceipt(receiptPath, receipt);
      await verifyPublished(pkg);
      status.state = 'published-and-verified';
      saveReceipt(receiptPath, receipt);
      onStatus({ package: pkg.name, state: 'published-and-verified' });
    }
    receipt.status = 'both-aliases-verified';
    saveReceipt(receiptPath, receipt);
    return receipt;
  } catch (error) {
    receipt.status = receipt.packages.some((pkg) => pkg.state === 'published-and-verified' || pkg.state === 'publish-command-succeeded')
      ? 'partial-or-unknown'
      : 'failed-before-confirming-publish';
    receipt.error = error.message;
    saveReceipt(receiptPath, receipt);
    throw error;
  }
}

export async function runPreflightThenPublish(manifest, {
  fetchImpl = fetch,
  verifyTarball = verifyArchiveBuffer,
  verifyPublished,
  publish,
  registryOrigin = REGISTRY_ORIGIN,
  remoteTagExists = defaultRemoteTagExists,
  receiptPath,
  onStatus = () => {}
}) {
  validateManifest(manifest);
  try {
    assertReleaseVersionTagsAbsent(manifest.release.version, manifest.repository.url, remoteTagExists);
    const preflight = await preflightAliases(manifest, { fetchImpl, verifyTarball, registryOrigin });
    assertReleaseVersionTagsAbsent(manifest.release.version, manifest.repository.url, remoteTagExists);
    return await publishAliasesSequentially(manifest, preflight, { publish, verifyPublished, receiptPath, onStatus });
  } catch (error) {
    if (receiptPath) {
      let current;
      try { current = JSON.parse(readFileSync(receiptPath, 'utf8')); } catch {}
      if (!current || current.status === 'publisher-started') {
        saveReceipt(receiptPath, {
          status: 'preflight-aborted',
          packages: manifest.packages.map((pkg) => ({ package: pkg.name, version: pkg.version, state: 'not-published' })),
          error: error.message
        });
      }
    }
    throw error;
  }
}

function npmPublishFunction(npmCliPath, bundleDirectory) {
  const emptyUserNpmrc = path.join(bundleDirectory, '.npmrc-user-empty');
  const emptyGlobalNpmrc = path.join(bundleDirectory, '.npmrc-global-empty');
  const cacheDirectory = path.join(bundleDirectory, '.npm-cache');
  writeFileSync(emptyUserNpmrc, '');
  writeFileSync(emptyGlobalNpmrc, '');
  return async (pkg) => {
    const archivePath = path.join(bundleDirectory, pkg.archive.file);
    verifyArchiveFile(archivePath, pkg);
    run(process.execPath, [npmCliPath, 'publish', archivePath, '--access', 'public', '--registry', REGISTRY_ORIGIN, '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: bundleDirectory,
      env: makeNpmEnv(emptyUserNpmrc, emptyGlobalNpmrc, cacheDirectory)
    });
  };
}

async function publishBundle({ bundleDirectory, manifestPath, inputs, env = process.env }) {
  const { manifest, raw } = readManifest(manifestPath);
  validateArtifactDispatch(manifest, {
    manifestBytes: raw,
    expectedVersion: inputs.expectedVersion,
    expectedSourceSha: inputs.expectedSourceSha,
    expectedTag: inputs.expectedTag,
    expectedManifestSha256: inputs.expectedManifestSha256,
    githubActor: env.GITHUB_ACTOR,
    allowedActor: env.SDK_RELEASE_DISPATCH_ACTOR,
    githubRepository: env.GITHUB_REPOSITORY,
    githubSha: env.GITHUB_SHA,
    githubRef: env.GITHUB_REF,
    githubRefType: env.GITHUB_REF_TYPE
  });
  ensureNodeVersion(manifest);
  const npmArchivePath = path.join(bundleDirectory, 'npm-11.6.2.tgz');
  if (sha512Sri(readFileSync(npmArchivePath)) !== manifest.toolchain.npmPackageIntegrity) fail('Bundled npm CLI artifact failed integrity verification');
  const npmCliDirectory = path.join(bundleDirectory, 'npm-cli');
  const npmCliPath = extractNpmCli(npmArchivePath, npmCliDirectory);
  const npmVersion = run(process.execPath, [npmCliPath, '--version']).stdout.trim();
  if (npmVersion !== manifest.toolchain.npmVersion) fail('Publisher npm CLI version mismatch');
  for (const pkg of manifest.packages) verifyArchiveFile(path.join(bundleDirectory, pkg.archive.file), pkg);
  const receiptPath = env.SDK_RELEASE_RECEIPT_PATH || path.join(bundleDirectory, 'publish-status.json');
  return runPreflightThenPublish(manifest, {
    verifyTarball: verifyArchiveBuffer,
    verifyPublished: (pkg) => verifyPublished(pkg, { fetchImpl: fetch, verifyTarball: verifyArchiveBuffer }),
    remoteTagExists: defaultRemoteTagExists,
    receiptPath,
    publish: npmPublishFunction(npmCliPath, bundleDirectory),
    onStatus: (status) => process.stdout.write(`${status.package}: ${status.state}\n`)
  });
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const values = {};
  for (let index = 0; index < rest.length; index += 1) {
    const key = rest[index];
    if (!key.startsWith('--')) fail(`Unexpected argument: ${key}`);
    values[key.slice(2)] = rest[index + 1];
    index += 1;
  }
  return { command, values };
}

async function main() {
  const { command, values } = parseArgs(process.argv.slice(2));
  if (command === 'prepare') {
    const manifestPath = path.resolve(values.manifest ?? path.join(REPOSITORY_ROOT, 'release/sdk-1.2.8.json'));
    const outputDirectory = path.resolve(values.output ?? path.join(os.tmpdir(), 'sdk-release-bundle'));
    const result = await prepareBundle({ manifestPath, outputDirectory });
    process.stdout.write(`${JSON.stringify({ status: 'prepared', ...result }, null, 2)}\n`);
    return;
  }
  if (command === 'pack') {
    const manifestPath = path.resolve(values.manifest ?? path.join(REPOSITORY_ROOT, 'release/sdk-1.2.8.json'));
    const { manifest } = readManifest(manifestPath);
    ensureNodeVersion(manifest);
    const npmCliPath = path.resolve(values['npm-cli'] ?? '');
    const destination = path.resolve(values.output ?? path.join(os.tmpdir(), 'sdk-release-pack-output'));
    const archives = packCandidateAliases({ manifest, npmCliPath, destination });
    process.stdout.write(`${JSON.stringify({ status: 'packed-and-verified', archives }, null, 2)}\n`);
    return;
  }
  if (command === 'validate-dispatch') {
    const manifestPath = path.resolve(values.manifest ?? path.join(REPOSITORY_ROOT, 'release/sdk-1.2.8.json'));
    const { manifest, raw } = readManifest(manifestPath);
    const result = validateDispatch(manifest, {
      manifestBytes: raw,
      expectedVersion: process.env.EXPECTED_VERSION,
      expectedSourceSha: process.env.EXPECTED_SOURCE_SHA,
      expectedTag: process.env.EXPECTED_TAG,
      expectedManifestSha256: process.env.EXPECTED_MANIFEST_SHA256,
      ...dispatchContextFromEnvironment(process.env),
      repositoryRoot: path.resolve(values['repo-root'] ?? REPOSITORY_ROOT)
    });
    process.stdout.write(`${JSON.stringify({ status: 'validated', ...result })}\n`);
    return;
  }
  if (command === 'publish') {
    const bundleDirectory = path.resolve(values.bundle ?? '.');
    const manifestPath = path.resolve(values.manifest ?? path.join(bundleDirectory, 'sdk-1.2.8.json'));
    const receiptPath = path.resolve(process.env.SDK_RELEASE_RECEIPT_PATH || path.join(bundleDirectory, 'publish-status.json'));
    saveReceipt(receiptPath, {
      status: 'publisher-started',
      packages: ['@m2msentinel/sdk', 'm2m-sentinel-sdk'].map((name) => ({ package: name, state: 'not-published' }))
    });
    try {
      const receipt = await publishBundle({
        bundleDirectory,
        manifestPath,
        inputs: {
          expectedVersion: process.env.EXPECTED_VERSION,
          expectedSourceSha: process.env.EXPECTED_SOURCE_SHA,
          expectedTag: process.env.EXPECTED_TAG,
          expectedManifestSha256: process.env.EXPECTED_MANIFEST_SHA256
        }
      });
      process.stdout.write(`PUBLISH_STATUS_JSON\n${JSON.stringify(receipt, null, 2)}\n`);
    } catch (error) {
      let receipt;
      try { receipt = JSON.parse(readFileSync(receiptPath, 'utf8')); } catch { receipt = null; }
      if (!receipt || receipt.status === 'publisher-started') {
        receipt = {
          status: 'blocked-before-publish',
          packages: ['@m2msentinel/sdk', 'm2m-sentinel-sdk'].map((name) => ({ package: name, state: 'not-published' })),
          error: error.message
        };
        saveReceipt(receiptPath, receipt);
      }
      process.stdout.write(`PUBLISH_STATUS_JSON\n${JSON.stringify(receipt, null, 2)}\n`);
      throw error;
    }
    return;
  }
  fail('Usage: sdk-release.mjs <prepare|pack|validate-dispatch|publish> [--manifest PATH] [--output PATH] [--npm-cli PATH] [--bundle PATH]');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`SDK release workflow blocked: ${error.message}\n`);
    process.exitCode = 1;
  });
}

export const releaseInternals = { metadataUrl, sha256, sha512, sha512Sri, replacePackageNameBytes };
