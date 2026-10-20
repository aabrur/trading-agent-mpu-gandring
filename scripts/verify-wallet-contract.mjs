// Compiles and runs only on an in-memory EVM. Never contacts an RPC or uses a user's wallet.
// Install test-only tools outside the repo: npm install --prefix <temp-dir> solc@0.8.30 ganache@7.9.2
// Set CONTRACT_TEST_DEPS to that directory before running this script.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createPublicClient, createWalletClient, custom } from 'viem';

const dependencies = process.env.CONTRACT_TEST_DEPS ?? path.join(os.tmpdir(), 'mpu-contract-verification');
const require = createRequire(path.join(dependencies, 'package.json'));
const solc = require('solc');
const ganache = require('ganache');
const files = ['WalletSessionRegistry.sol', 'test/WalletSessionRegistry.t.sol'];
const compiled = JSON.parse(solc.compile(JSON.stringify({
  language: 'Solidity',
  sources: Object.fromEntries(files.map((file) => [file, { content: readFileSync(new URL(`../contracts/${file}`, import.meta.url), 'utf8') }])),
  settings: { evmVersion: 'shanghai', optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } }
})));
const errors = (compiled.errors ?? []).filter((error) => error.severity === 'error');
assert.deepEqual(errors, [], errors.map((error) => error.formattedMessage).join('\n'));
const provider = ganache.provider({ logging: { quiet: true }, chain: { hardfork: 'shanghai' } });
const publicClient = createPublicClient({ transport: custom(provider) });
const wallet = createWalletClient({ transport: custom(provider) });
try {
  const [account] = await wallet.getAddresses();
  async function deploy(source, name) {
    const artifact = compiled.contracts[source][name];
    const hash = await wallet.deployContract({ account, chain: null, gas: 12_000_000n, abi: artifact.abi, bytecode: `0x${artifact.evm.bytecode.object}` });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, 'success');
    return { address: receipt.contractAddress, abi: artifact.abi };
  }
  const test = await deploy('test/WalletSessionRegistry.t.sol', 'WalletSessionRegistryTest');
  for (const functionName of ['testRenewAndRevoke', 'testOwnerAndContextIsolation', 'testRevokeAllAndReauthorize', 'testRejectInvalidSessions']) {
    const { request } = await publicClient.simulateContract({ ...test, account, functionName });
    const hash = await wallet.writeContract({ ...request, chain: null, gas: 12_000_000n });
    assert.equal((await publicClient.waitForTransactionReceipt({ hash })).status, 'success');
    console.log(`PASS ${functionName}`);
  }
  const registry = await deploy('WalletSessionRegistry.sol', 'WalletSessionRegistry');
  const context = `0x${'11'.repeat(32)}`;
  const agent = '0x1111111111111111111111111111111111111111';
  const now = (await publicClient.getBlock()).timestamp;
  const hash = await wallet.writeContract({ ...registry, chain: null, account, functionName: 'authorize', args: [agent, context, now + 60n] });
  await publicClient.waitForTransactionReceipt({ hash });
  assert.equal(await publicClient.readContract({ ...registry, functionName: 'isAuthorized', args: [account, agent, context] }), true);
  await provider.request({ method: 'evm_increaseTime', params: [61] });
  await provider.request({ method: 'evm_mine', params: [] });
  assert.equal(await publicClient.readContract({ ...registry, functionName: 'isAuthorized', args: [account, agent, context] }), false);
  console.log('PASS expired session is rejected');
  await assert.rejects(() => publicClient.call({ account, to: registry.address, value: 1n }));
  console.log('PASS normal payments are rejected');
  console.log(`Solidity ${solc.version()}: compile and 6 local EVM checks passed.`);
} finally { await provider.disconnect(); }
