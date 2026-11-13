import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createStandaloneIo, applyStandaloneIoCandidate, type StandaloneIoCandidate } from '../src/host/kernel/io-standalone.js';
import { evaluateReadHook, fullReadPath } from '../src/host/kernel/io-read-hook.js';
import { evaluateWriteHook } from '../src/host/kernel/io-write-hook.js';

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
  if(r.question==='stale')require('node:fs').writeFileSync(sourcePath,'changed');
  const answer=r.question==='empty'?'':r.question==='long'?'한글'.repeat(100):r.question==='repeated'?'same quote; same quote':'The value is 7. No citation required.';
  const output=r.question?answer:r.specification==='bad format'?'not JSON':JSON.stringify({path:r.filePath,code:'export const generated = 7;\n'});
  require('node:fs').appendFileSync(callsPath,'call\n');
  send({id:m.id,result:{turn:{id:'turn'}}});
  send({method:'thread/tokenUsage/updated',params:{threadId:'standalone',turnId:'turn',tokenUsage:{total:{inputTokens:100,cachedInputTokens:20,outputTokens:30}}}});
  send({method:'item/completed',params:{threadId:'standalone',turnId:'turn',item:{id:'final',type:'agentMessage',phase:'final_answer',text:output}}});
  send({method:'turn/completed',params:{threadId:'standalone',turn:{id:'turn',status:'completed'}}});
 }
});`;

async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), 'standalone-io-test-'));
  const project = path.join(base, 'project');
  await mkdir(project);
  await writeFile(path.join(project, 'ref.mjs'), 'export const token = 7;\n');
  await writeFile(path.join(base, 'calls'), '');
  await writeFile(path.join(base, 'server.cjs'), 'const sourcePath='+JSON.stringify(path.join(project,'ref.mjs'))+';const callsPath='+JSON.stringify(path.join(base,'calls'))+';\n'+server);
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
    assert.equal(read.status, 'answered', JSON.stringify(read));
    if ('answer' in read) assert.equal(read.answer, 'The value is 7. No citation required.');
    assert.equal(Object.hasOwn(read, 'semanticReview'), false);
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

test('explicit Writer hook prepares one isolated candidate for normal apply', async () => {
  const f = await fixture();
  let candidateRoot: string | undefined;
  try {
    const options = { runtimeHome: path.resolve('.'), env: {},
      transportOptions: { executable: process.execPath, args: [path.join(f.base, 'server.cjs')], requestTimeoutMs: 1500 } };
    const input = { hook_event_name: 'UserPromptSubmit', permission_mode: 'bypassPermissions', cwd: f.project,
      prompt: 'Writer: nested/created.mjs\r\nReferences: ref.mjs\r\n\r\nCreate the new constant.' };
    assert.deepEqual(await evaluateWriteHook({ ...input, prompt: 'Create the new constant.' }, options), {});
    assert.match(JSON.stringify(await evaluateWriteHook({ ...input, permission_mode: 'plan' }, options)), /permission_mode_unsupported/);
    assert.match(JSON.stringify(await evaluateWriteHook({ ...input, prompt: input.prompt.replace('nested/', '../') }, options)), /path_invalid/);
    assert.equal(await readFile(path.join(f.base, 'calls'), 'utf8'), '');

    const output = await evaluateWriteHook(input, options);
    const command = output.hookSpecificOutput?.additionalContext ?? '';
    assert.match(command, /io-apply/);
    assert.doesNotMatch(command, /export const|--apply/);
    const match = command.match(/'([^']+\/apply-[^']+\.json)'$/);
    assert.ok(match?.[1], command);
    const metadata = match[1];
    candidateRoot = path.dirname(metadata);
    assert.notEqual(candidateRoot, await realpath(f.project));
    const candidate = JSON.parse(await readFile(metadata, 'utf8'));
    assert.equal(candidate.status, 'generated');
    assert.equal(candidate.projectRoot, await realpath(f.project));
    assert.equal(await readFile(path.join(f.base, 'calls'), 'utf8'), 'call\n');
    await assert.rejects(access(path.join(f.project, 'nested')));
    const args = [path.resolve('bin/moonshot-io.mjs'), 'io-apply', metadata];
    const applied = spawnSync(process.execPath, args, { cwd: f.project, encoding: 'utf8' });
    assert.equal(applied.status, 0, applied.stdout || applied.stderr);
    assert.equal(JSON.parse(applied.stdout).status, 'created');
    assert.equal(await readFile(path.join(f.project, 'nested/created.mjs'), 'utf8'), 'export const generated = 7;\n');
    assert.match(JSON.stringify(await evaluateWriteHook(input, options)), /host_io_existing_file/);
    assert.equal(await readFile(path.join(f.base, 'calls'), 'utf8'), 'call\n');
  } finally {
    if (candidateRoot) await rm(candidateRoot, { recursive: true, force: true });
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

test('Reader preserves uncited/repeated text, bounds UTF-8 previews, and distinguishes empty and stale answers', async () => {
  for (const question of ['plain', 'repeated', 'empty', 'long', 'stale']) {
    const f = await fixture();
    try {
      const result = await f.io.read({ ...f.request, question, maxOutputBytes: 17 });
      assert.equal(result.status, question === 'empty' ? 'failed' : question === 'stale' ? 'stale' : 'truncated');
      assert.equal(result.usage?.inputTokens, 100);
      if ('answer' in result) {
        assert.ok(Buffer.byteLength(result.answer) <= 17);
        assert.ok(!result.answer.includes('\uFFFD'));
        assert.equal(result.sources[0]?.path, 'ref.mjs');
      }
      if (question === 'empty') assert.equal(result.failureCode, 'host_io_response_empty');
      if (question === 'stale') assert.equal(result.failureCode, 'host_io_stale_reference');
      if (question === 'repeated') {
        const full = await f.io.read({ ...f.request, question });
        assert.equal(full.status, 'answered');
        if ('answer' in full) assert.equal(full.answer, 'same quote; same quote');
      }
    } finally { await rm(f.base, { recursive: true, force: true }); }
  }
});

async function cliFixture(f: Awaited<ReturnType<typeof fixture>>, injection = '') {
  const file = path.join(f.base, 'cli-inject.mjs');
  await writeFile(path.join(f.base, 'codex.exe'), 'test-only intercepted executable');
  await writeFile(file, `import cp from 'node:child_process';import fs from 'node:fs';import path from 'node:path';import {syncBuiltinESMExports} from 'node:module';const spawn=cp.spawn;cp.spawn=(cmd,args,options)=>(cmd==='codex'||path.basename(cmd).toLowerCase()==='codex.exe')&&args.length===1&&args[0]==='app-server'?spawn(process.execPath,[${JSON.stringify(path.join(f.base,'server.cjs'))}],{...options,shell:false}):spawn(cmd,args,options);${injection};syncBuiltinESMExports();`);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
  env.Path = f.base;
  return (args: string[], request: unknown) => spawnSync(process.execPath, ['--import', pathToFileURL(file).href,
    path.resolve('bin/moonshot-io.mjs'), ...args], { cwd: f.project, env, encoding: 'utf8', input: JSON.stringify(request), timeout: 15000 });
}

test('CLI stdin Writer creates in one call, returns metadata only, cleans its candidate and refuses existing output before calling', async () => {
  const f = await fixture();
  try {
    const cli = await cliFixture(f);
    const request = { ...f.request, filePath: 'generated/new.mjs', specification: 'Create a constant.' };
    const run = cli(['io-write', '-', '--apply'], request);
    assert.equal(run.status, 0, run.stderr + run.stdout);
    const result = JSON.parse(run.stdout);
    assert.equal(result.status, 'created');
    assert.equal(result.bytes, 28);
    for (const key of ['code', 'candidatePath', 'candidateRoot', 'hostProductProof', 'ownerDelivery', 'kernelDone']) assert.equal(Object.hasOwn(result,key),false,key);
    assert.equal(result.usage.inputTokens,100);
    assert.equal(await readFile(path.join(f.base,'calls'),'utf8'),'call\n');
    assert.equal(await readFile(path.join(f.project,'generated/new.mjs'),'utf8'),'export const generated = 7;\n');
    // Existing metadata must fail before model invocation, including via stdin.
    await writeFile(path.join(f.project,'metadata.json'),'keep');
    const preflight = cli(['io-write','-','metadata.json','--apply'], {...request,filePath:'other.mjs'});
    assert.equal(preflight.status,1);
    assert.equal(JSON.parse(preflight.stdout).failureCode,'EEXIST');
    assert.equal(await readFile(path.join(f.base,'calls'),'utf8'),'call\n');
    assert.equal(cli(['io-read','-','--apply'],request).status,1);
  } finally { await rm(f.base,{recursive:true,force:true}); }
});

test('CLI retains paid results when metadata saving fails and retains malformed Writer diagnostics without retry', async () => {
  const f = await fixture();
  let candidateRoot: string | undefined;
  try {
    const cli = await cliFixture(f, `const write=fs.promises.writeFile;fs.promises.writeFile=(file,...args)=>String(file).endsWith('metadata.json')?Promise.reject(Object.assign(new Error('injected'),{code:'EIO'})):write(file,...args)`);
    const result = cli(['io-write','-','metadata.json','--apply'], { ...f.request,filePath:'new.mjs',specification:'create' });
    assert.equal(result.status,1,result.stderr);
    const saved = JSON.parse(result.stdout);
    assert.equal(saved.status,'created');
    assert.equal(saved.metadataFailure,'EIO');
    assert.equal(saved.usage.inputTokens,100);
    assert.equal(await readFile(path.join(f.project,'new.mjs'),'utf8'),'export const generated = 7;\n');
    const invalid = JSON.parse(cli(['io-write','-','--apply'], { ...f.request,filePath:'invalid.mjs',specification:'bad format' }).stdout);
    candidateRoot = invalid.candidateRoot;
    assert.equal(invalid.status,'failed');
    assert.equal(invalid.responsePreview,'not JSON');
    assert.equal(invalid.usage.inputTokens,100);
    assert.equal(await readFile(path.join(f.base,'calls'),'utf8'),'call\ncall\n');
    await assert.rejects(access(path.join(f.project,'invalid.mjs')));
  } finally {
    if(candidateRoot) await rm(candidateRoot,{recursive:true,force:true});
    await rm(f.base,{recursive:true,force:true});
  }
});

test('one-call Writer keeps candidate and usage after a partial destination write', async () => {
  const f = await fixture();
  let root: string | undefined;
  try {
    const cli = await cliFixture(f, `const open=fs.promises.open;fs.promises.open=async(file,flag,...args)=>{const h=await open(file,flag,...args);if(flag!=='wx'||!String(file).endsWith('new.mjs'))return h;return{writeFile:async bytes=>{await h.writeFile(bytes.subarray(0,1));throw Object.assign(new Error('injected'),{code:'EIO'});},close:()=>h.close()};}`);
    const result = JSON.parse(cli(['io-write','-','--apply'], { ...f.request,filePath:'new.mjs',specification:'create' }).stdout);
    root=result.candidateRoot;
    assert.equal(result.status,'failed');
    assert.equal(result.generationStatus,'generated');
    assert.equal(result.failureCode,'host_io_apply_write_failed');
    assert.equal(result.destinationState,'partial-or-changed');
    assert.equal(result.usage.inputTokens,100);
    assert.equal(await readFile(result.candidatePath,'utf8'),'export const generated = 7;\n');
    assert.equal(await readFile(path.join(f.project,'new.mjs'),'utf8'),'e');
    assert.equal(await readFile(path.join(f.base,'calls'),'utf8'),'call\n');
  } finally {
    if(root)await rm(root,{recursive:true,force:true});
    await rm(f.base,{recursive:true,force:true});
  }
});
