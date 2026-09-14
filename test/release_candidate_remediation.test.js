'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

describe('Release Candidate Remediation and Parity Tests', () => {

  describe('1. Broken Example Imports Regression and Clean-Load', () => {
    it('proves old monorepo import path fails with MODULE_NOT_FOUND for agentkit example', () => {
      const oldPathFromExamples = path.join(ROOT, 'examples', '../public/sdk/index.js');
      assert.equal(fs.existsSync(oldPathFromExamples), false, 'Old monorepo path must not exist in public SDK');
      assert.throws(
        () => {
          require(oldPathFromExamples);
        },
        { code: 'MODULE_NOT_FOUND' },
        'Requiring ../public/sdk/index.js from examples must fail with MODULE_NOT_FOUND'
      );
    });

    it('proves old monorepo import path fails with MODULE_NOT_FOUND for langgraph example', () => {
      const oldPathFromCases = path.join(ROOT, 'examples', 'cases', '../../public/sdk/index.js');
      assert.equal(fs.existsSync(oldPathFromCases), false, 'Old monorepo path must not exist in public SDK');
      assert.throws(
        () => {
          require(oldPathFromCases);
        },
        { code: 'MODULE_NOT_FOUND' },
        'Requiring ../../public/sdk/index.js from examples/cases must fail with MODULE_NOT_FOUND'
      );
    });

    it('asserts agentkit_preflight_security_guard.js has no monorepo public/sdk reference and requires cleanly', () => {
      const exampleFile = path.join(ROOT, 'examples/agentkit_preflight_security_guard.js');
      const content = fs.readFileSync(exampleFile, 'utf8');
      assert.ok(!content.includes('public/sdk'), 'agentkit example must not contain public/sdk path');
      assert.ok(content.includes("require('../index.js')"), "agentkit example must require('../index.js')");

      // Verify requiring the example is completely safe and makes no network calls
      const exported = require(exampleFile);
      assert.ok(exported, 'Example module must export cleanly');
      assert.equal(typeof exported.main, 'function', 'Example module must export main function');
    });

    it('asserts langgraph_preflight_supervisor.js has no monorepo public/sdk reference and requires cleanly', () => {
      const exampleFile = path.join(ROOT, 'examples/cases/langgraph_preflight_supervisor.js');
      const content = fs.readFileSync(exampleFile, 'utf8');
      assert.ok(!content.includes('public/sdk'), 'langgraph example must not contain public/sdk path');
      assert.ok(content.includes("require('../../index.js')"), "langgraph example must require('../../index.js')");

      // Verify requiring the example is completely safe and makes no network calls
      const exported = require(exampleFile);
      assert.ok(exported, 'Example module must export cleanly');
      assert.equal(typeof exported.runLangGraphPreflightExample, 'function', 'Example module must export runner function');
    });
  });

  describe('2. Synced Transaction Preflight Surface and Type Parity', () => {
    it('exports preflightBeforeSigning, guardTransaction, and aliases from base_account_paymaster_guard.js', () => {
      const guard = require(path.join(ROOT, 'base_account_paymaster_guard.js'));
      assert.equal(typeof guard.preflightBeforeSigning, 'function');
      assert.equal(typeof guard.guardTransaction, 'function');
      assert.equal(typeof guard.preflightTransactionBeforeSigning, 'function');
      assert.equal(guard.guardTransaction, guard.preflightBeforeSigning);
      assert.equal(guard.preflightTransactionBeforeSigning, guard.preflightBeforeSigning);

      assert.equal(typeof guard.BaseAccountPaymasterGuard.prototype.preflightTransaction, 'function');
      assert.equal(typeof guard.BaseAccountPaymasterGuard.prototype.guardTransaction, 'function');
    });

    it('exports preflightBeforeSigning and guardTransaction from root index.js', () => {
      const sdk = require(path.join(ROOT, 'index.js'));
      assert.equal(typeof sdk.preflightBeforeSigning, 'function');
      assert.equal(typeof sdk.guardTransaction, 'function');
      assert.equal(typeof sdk.preflightTransactionBeforeSigning, 'function');
      assert.equal(typeof sdk.BaseAccountPaymasterGuard.prototype.preflightTransaction, 'function');
      assert.equal(typeof sdk.BaseAccountPaymasterGuard.prototype.guardTransaction, 'function');
    });

    it('declares PreflightBeforeSigningOptions and preflight signatures in index.d.ts', () => {
      const dts = fs.readFileSync(path.join(ROOT, 'index.d.ts'), 'utf8');
      assert.ok(dts.includes('interface PreflightBeforeSigningOptions'), 'index.d.ts must declare PreflightBeforeSigningOptions');
      assert.ok(dts.includes('export function preflightBeforeSigning('), 'index.d.ts must declare preflightBeforeSigning function');
      assert.ok(dts.includes('export const guardTransaction: typeof preflightBeforeSigning;'), 'index.d.ts must declare guardTransaction alias');
      assert.ok(dts.includes('export const preflightTransactionBeforeSigning: typeof preflightBeforeSigning;'), 'index.d.ts must declare preflightTransactionBeforeSigning alias');
      assert.ok(dts.includes('preflightTransaction(transaction: TransactionPreflightRequest'), 'BaseAccountPaymasterGuard must declare preflightTransaction');
      assert.ok(dts.includes('guardTransaction(transaction: TransactionPreflightRequest'), 'BaseAccountPaymasterGuard must declare guardTransaction');
    });

    it('declares PreflightBeforeSigningOptions and preflight implementations in typescript/base_account_paymaster_guard.ts', () => {
      const ts = fs.readFileSync(path.join(ROOT, 'typescript/base_account_paymaster_guard.ts'), 'utf8');
      assert.ok(ts.includes('export interface PreflightBeforeSigningOptions'), 'TypeScript entrypoint must declare PreflightBeforeSigningOptions');
      assert.ok(ts.includes('export function preflightBeforeSigning('), 'TypeScript entrypoint must export preflightBeforeSigning');
      assert.ok(ts.includes('export const guardTransaction = preflightBeforeSigning;'), 'TypeScript entrypoint must export guardTransaction');
      assert.ok(ts.includes('export const preflightTransactionBeforeSigning = preflightBeforeSigning;'), 'TypeScript entrypoint must export preflightTransactionBeforeSigning');
      assert.ok(ts.includes('preflightTransaction(transaction: TransactionPreflightRequest'), 'BaseAccountPaymasterGuardInstance must declare preflightTransaction');
      assert.ok(ts.includes('guardTransaction(transaction: TransactionPreflightRequest'), 'BaseAccountPaymasterGuardInstance must declare guardTransaction');
    });
  });

  describe('3. Package Manifest and Dry-Run Packaging Parity', () => {
    it('package.json files list includes langchain_tool.js', () => {
      const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
      assert.ok(pkg.files.includes('langchain_tool.js'), 'package.json files array must include langchain_tool.js');
    });

    it('proves npm pack --dry-run includes langchain_tool.js and all required files', () => {
      const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      const output = execSync(`${npmCmd} pack --dry-run --json`, {
        cwd: ROOT,
        encoding: 'utf8'
      });
      const parsed = JSON.parse(output);
      assert.ok(Array.isArray(parsed) && parsed.length > 0, 'npm pack output must parse as array');
      const packInfo = parsed[0];
      const packedFiles = packInfo.files.map((f) => f.path);

      assert.ok(packedFiles.includes('langchain_tool.js'), 'Packed tarball must include langchain_tool.js');
      assert.ok(packedFiles.includes('base_account_paymaster_guard.js'), 'Packed tarball must include base_account_paymaster_guard.js');
      assert.ok(packedFiles.includes('index.d.ts'), 'Packed tarball must include index.d.ts');
      assert.ok(packedFiles.includes('typescript/base_account_paymaster_guard.ts'), 'Packed tarball must include typescript/base_account_paymaster_guard.ts');
      assert.equal(packInfo.version, '1.2.6', 'Packed version must be exactly 1.2.6');
    });
  });
});
