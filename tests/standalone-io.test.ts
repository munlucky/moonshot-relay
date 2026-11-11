import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createStandaloneIo, applyStandaloneIoCandidate, type StandaloneIoCandidate } from '../src/host/kernel/io-standalone.js';
import { evaluateReadHook, fullReadPath } from '../src/host/kernel/io-read-hook.js';

const server = String.raw`
const send=m=>process.stdout.write(JSON.stringify(m)+'\n');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')send({id:m.id,result:{}});
 if(m.method==='config/read')send({id:m.id,result:{config:{}}});
 if(m.method==='thread/start'){
  if(m.params.config.features.shell_tool!==false||m.params.config.features.hooks!==false)throw Error('tools enabled');
  send({id:m.id,result:{thread:{id:'standalone'},model:m.params.model,reasoningEffort:m.params.config.model_reasoning_effort}});
 }
 if(m.method==='turn/start'){
  const r=JSON.parse(m.params.input[0].text.split('\n').at(-1));
  const output=r.question?{summary:'The token is 7.',facts:[{path:'ref.mjs',symbol:'token',quote:'export const token = 7;',uncertainty:'none'}]}:{path:r.filePath,code:'export const generated = 7;\n'};
  send({id:m.id,result:{turn:{id:'turn'}}});
  send({method:'thread/tokenUsage/updated',params:{threadId:'standalone',turnId:'turn',tokenUsage:{total:{inputTokens:100,cachedInputTokens:20,outputTokens:30}}}});
  send({method:'item/completed',params:{threadId:'standalone',turnId:'turn',item:{id:'final',type:'agentMessage',phase:'final_answer',text:JSON.stringify(output)}}});
  send({method:'turn/completed',params:{threadId:'standalone',turn:{id:'turn',status:'completed'}}});
 }
});`;

async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), 'standalone-io-test-'));
  const project = path.join(base, 'project');
  await mkdir(project);
  await writeFile(path.join(project, 'ref.mjs'), 'export const token = 7;\n');
  await writeFile(path.join(base, 'server.cjs'), server);
  const io = createStandaloneIo({ projectRoot: project, runtimeHome: base, env: {},
    transportOptions: { executable: process.execPath, args: [path.join(base, 'server.cjs')], requestTimeoutMs: 1500 } });
  const request = { references: ['ref.mjs'], maxInputBytes: 20000, maxOutputBytes: 10000, timeoutMs: 3000 };
  return { base, project, io, request };
}

test('standalone Reader and Writer share checked model calls without a Kernel Run or DB', async () => {
  const f = await fixture();
  let candidate: StandaloneIoCandidate | undefined;
  try {
    const read = await f.io.read({ ...f.request, question: 'What is token?' });
    assert.equal(read.status, 'evidence-ready', JSON.stringify(read));
    if ('evidence' in read) assert.equal(read.evidence[0]?.quote, 'export const token = 7;');
    assert.equal(read.usage?.inputTokens, 100);
    const result = await f.io.write({ ...f.request, filePath: 'generated/new.mjs', specification: 'Create the new constant.' });
    assert.equal(result.status, 'generated', JSON.stringify(result));
    assert.equal(Object.hasOwn(result, 'code'), false);
    candidate = result as StandaloneIoCandidate;
    await assert.rejects(access(path.join(f.project, candidate.filePath)));
    assert.equal((await applyStandaloneIoCandidate(f.project, candidate)).status, 'created');
    assert.equal(await readFile(path.join(f.project, candidate.filePath), 'utf8'), 'export const generated = 7;\n');
    const duplicate = await f.io.write({ ...f.request, filePath: 'generated/other.mjs', specification: 'A second distinct destination.' });
    assert.equal(duplicate.status, 'generated');
    if ('candidatePath' in duplicate) await rm(path.dirname(path.dirname(duplicate.candidatePath)), { recursive: true, force: true });
    const kernelRequest = { ...f.request, question: 'invalid', runId: 'fake' };
    await assert.rejects(f.io.read(kernelRequest), { code: 'standalone_io_kernel_request_rejected' });
    await assert.rejects(f.io.write({ ...f.request, references: [], filePath: 'next.mjs', specification: 'none' }), { code: 'host_io_reference_required' });
    await assert.rejects(access(path.join(f.project, '.moon-relay')));
  } finally {
    if (candidate) await rm(path.dirname(path.dirname(candidate.candidatePath)), { recursive: true, force: true });
    await rm(f.base, { recursive: true, force: true });
  }
});

test('apply rejects reference/candidate changes, existing files, linked parents, and concurrent creation', async () => {
  for (const mode of ['reference', 'candidate', 'existing', 'linked', 'concurrent']) {
    const f = await fixture();
    let candidate: StandaloneIoCandidate | undefined;
    try {
      const result = await f.io.write({ ...f.request, filePath: 'generated/new.mjs', specification: 'Create one new constant.' });
      assert.equal(result.status, 'generated', JSON.stringify(result));
      candidate = result as StandaloneIoCandidate;
      if (mode === 'reference') await writeFile(path.join(f.project, 'ref.mjs'), 'changed');
      if (mode === 'candidate') await writeFile(candidate.candidatePath, 'changed');
      if (mode === 'existing') {
        await mkdir(path.join(f.project, 'generated'));
        await writeFile(path.join(f.project, candidate.filePath), 'keep');
      }
      if (mode === 'linked') await symlink(f.base, path.join(f.project, 'generated'), 'junction');
      if (mode === 'concurrent') {
        const outcomes = await Promise.allSettled([applyStandaloneIoCandidate(f.project, candidate), applyStandaloneIoCandidate(f.project, candidate)]);
        assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1);
        assert.equal(outcomes.filter(x => x.status === 'rejected').length, 1);
        assert.equal(await readFile(path.join(f.project, candidate.filePath), 'utf8'), 'export const generated = 7;\n');
      } else {
        const codes: Record<string, string> = { reference: 'host_io_stale_reference', candidate: 'host_io_candidate_tampered', existing: 'host_io_existing_file', linked: 'host_io_symlink_rejected' };
        await assert.rejects(applyStandaloneIoCandidate(f.project, candidate), { code: codes[mode] });
        if (mode === 'existing') assert.equal(await readFile(path.join(f.project, candidate.filePath), 'utf8'), 'keep');
        else await assert.rejects(access(path.join(f.project, candidate.filePath)));
      }
    } finally {
      if (candidate) await rm(path.dirname(path.dirname(candidate.candidatePath)), { recursive: true, force: true });
      await rm(f.base, { recursive: true, force: true });
    }
  }
});

test('Reader Hook recognizes only plain full reads and allows missing runtime/auth and bounded tools', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'io-hook-test-'));
  try {
    const input = (command: string) => ({ tool_name: 'Bash', tool_input: { command }, cwd: base });
    for (const command of ["Get-Content 'long file.ts'", "Get-Content -Raw -LiteralPath 'long file.ts'", "Get-Content -Path 'long file.ts' -Raw", "cat 'long file.ts'"]) assert.equal(fullReadPath(input(command)), 'long file.ts');
    for (const command of ['rg token long.ts', 'Get-Content long.ts -TotalCount 4', 'Get-Content long.ts | Select-Object -Skip 4 -First 2', 'Get-Content a; Get-Content b', 'Get-Content $x', 'cat a b', 'cat -- a']) assert.equal(fullReadPath(input(command)), null);
    await writeFile(path.join(base, 'long file.ts'), 'source\n'.repeat(400));
    await writeFile(path.join(base, 'short.ts'), 'short');
    await writeFile(path.join(base, 'boundary.ts'), 'line\n'.repeat(350));
    const options = { runtimeHome: base, minLines: 350, env: { CODEX_HOME: base } };
    assert.deepEqual(await evaluateReadHook(input("Get-Content -Raw 'long file.ts'"), options), {});
    await mkdir(path.join(base, 'bin'));
    await writeFile(path.join(base, 'bin/moonshot-io.mjs'), '// executable placeholder');
    assert.deepEqual(await evaluateReadHook(input("Get-Content -Raw 'long file.ts'"), options), {});
    await writeFile(path.join(base, 'auth.json'), JSON.stringify({ tokens: { access_token: 'fixture' } }));
    const denied = await evaluateReadHook(input("Get-Content -Raw 'long file.ts'"), options);
    assert.match(JSON.stringify(denied), /permissionDecision.*deny/);
    assert.match(JSON.stringify(denied), /io-read/);
    for (const command of ['Get-Content short.ts', 'Get-Content boundary.ts', 'rg source .', 'Get-Content -Raw ../escape.ts']) assert.deepEqual(await evaluateReadHook(input(command), options), {});
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('an actual apply write failure reports the observed partial destination without overwriting or hiding it', async () => {
  const f = await fixture();
  let candidate: StandaloneIoCandidate | undefined;
  try {
    const generated = await f.io.write({ ...f.request, filePath: 'generated/new.mjs', specification: 'Create one constant.' });
    assert.equal(generated.status, 'generated');
    candidate = generated as StandaloneIoCandidate;
    const metadata = path.join(f.base, 'candidate.json'), injection = path.join(f.base, 'fail-write.mjs');
    await writeFile(metadata, JSON.stringify(candidate));
    await writeFile(injection, `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const open=fs.promises.open;fs.promises.open=async(file,flag,...args)=>{const h=await open(file,flag,...args);if(flag!=='wx')return h;return{writeFile:async(bytes)=>{await h.writeFile(bytes.subarray(0,1));throw Object.assign(new Error('injected write'),{code:'EIO'});},close:()=>h.close()};};syncBuiltinESMExports();`);
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(injection).href,
      path.resolve('bin/moonshot-io.mjs'), 'io-apply', metadata], { cwd: f.project, encoding: 'utf8' });
    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { status: 'failed', failureCode: 'host_io_apply_write_failed', destinationState: 'partial-or-changed' });
    assert.equal(await readFile(path.join(f.project, candidate.filePath), 'utf8'), 'e');
  } finally {
    if (candidate) await rm(path.dirname(path.dirname(candidate.candidatePath)), { recursive: true, force: true });
    await rm(f.base, { recursive: true, force: true });
  }
});
