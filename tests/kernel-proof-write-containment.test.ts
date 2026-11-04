import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { executeTrustedProof } from '../src/host/kernel/proof/proof-executor.js';
import { ProofWriteContainmentUnavailableError } from '../src/host/kernel/proof/write-containment.js';

const awaitFile = async (filename: string): Promise<void> => {
  for (let i = 0; i < 160 && !existsSync(filename); i++) await delay(35);
  assert.ok(existsSync(filename), `missing bounded test-only evidence ${filename}`);
};
const physicallyExited = (pid: number): boolean => {
  const result = spawnSync('/bin/ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
  return result.status !== 0 || !result.stdout.trim() || result.stdout.trim().startsWith('Z');
};

test('write-scoped Trusted Proof fails closed where OS enforcement is not available', {
  skip: process.platform === 'darwin' && 'macOS has a separate live enforcement test',
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'proof-write-unavailable-'));
  try {
    await writeFile(path.join(root, 'package.json'), JSON.stringify({
      scripts: { 'test:scope': 'node --version' },
    }));
    assert.throws(() => executeTrustedProof({
      projectRoot: root, commandRef: 'test:scope', writeScope: root,
    }), (cause: unknown) => cause instanceof ProofWriteContainmentUnavailableError);
    assert.equal(existsSync(path.join(root, 'scope-passed')), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('macOS OS write scope survives a detached proof process, denying owner and symlink aliases', {
  skip: process.platform !== 'darwin' && 'requires macOS Seatbelt',
  timeout: 20000,
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'proof-write-sandbox-'));
  const integration = path.join(root, 'integration');
  const owner = path.join(root, 'owner');
  const sibling = path.join(root, 'sibling');
  await Promise.all([mkdir(integration), mkdir(owner), mkdir(sibling)]);
  let knownExited = false;
  try {
    await symlink(owner, path.join(integration, 'alias-to-owner'));
    await writeFile(path.join(integration, 'package.json'), JSON.stringify({
      name: 'proof-write-sandbox-test', scripts: { 'test:scope': 'node proof.cjs' },
    }));
    const childCode = [
      "const fs=require('node:fs');const path=require('node:path');",
      `const work=${JSON.stringify(integration)},owner=${JSON.stringify(owner)},other=${JSON.stringify(sibling)};`,
      "setTimeout(()=>{",
      "fs.writeFileSync(path.join(work,'allowed.txt'),'allowed\\n');",
      "const attempt=(target)=>{try{fs.writeFileSync(target,'unsafe');return 'allowed';}catch(e){return e.code||String(e);}};",
      "const results={owner:attempt(path.join(owner,'outside.txt')),sibling:attempt(path.join(other,'outside.txt')),",
      "alias:attempt(path.join(work,'alias-to-owner','aliased.txt'))};",
      "fs.writeFileSync(path.join(work,'verdict.json'),JSON.stringify(results));",
      "},150);setTimeout(()=>process.exit(0),400);",
    ].join('\n');
    const parentCode = [
      "const fs=require('node:fs');const path=require('node:path');const {spawn}=require('node:child_process');",
      `const root=${JSON.stringify(integration)};`,
      `const child=spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{detached:true,stdio:'inherit'});`,
      "child.unref();fs.writeFileSync(path.join(root,'child.pid'),String(child.pid));",
    ].join('\n');
    await writeFile(path.join(integration, 'proof.cjs'), parentCode + '\n');
    const proof = executeTrustedProof({
      projectRoot: integration,
      commandRef: 'test:scope',
      timeoutMs: 12000,
      writeScope: integration,
    });
    assert.equal(proof.status, 'passed', proof.errorSummary || 'scoped Proof failed');
    assert.deepEqual(proof.writeContainment, {
      mechanism: 'macos-seatbelt', scope: realpathSync(integration),
    });
    await awaitFile(path.join(integration, 'verdict.json'));
    const verdict: { owner: string; sibling: string; alias: string } = JSON.parse(await readFile(path.join(integration, 'verdict.json'), 'utf8'));
    assert.deepEqual(Object.values(verdict), ['EPERM', 'EPERM', 'EPERM']);
    assert.equal(await readFile(path.join(integration, 'allowed.txt'), 'utf8'), 'allowed\n');
    for (const file of ['outside.txt', 'aliased.txt']) assert.equal(existsSync(path.join(owner, file)), false);
    assert.equal(existsSync(path.join(sibling, 'outside.txt')), false);
    const pid = Number(await readFile(path.join(integration, 'child.pid'), 'utf8'));
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    for (let i = 0; i < 120 && !physicallyExited(pid); i++) await delay(30);
    assert.ok(physicallyExited(pid), 'test-only detached process must self-retire before fixture cleanup');
    knownExited = true;
  } finally {
    if (knownExited) await rm(root, { recursive: true, force: true });
    else console.warn('Retained uncertain test-only macOS proof workspace:', root);
  }
});
