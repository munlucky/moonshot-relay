import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir, symlink, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { createKernelControlPlane } from '../src/host/kernel/control-plane-runtime.js';
import { createHostWorkerSessions } from '../src/host/kernel/host-worker-sessions.js';
import { createLocalWorkerControl, startLocalWorkerControl } from '../src/host/kernel/local-worker-control.js';
import { assertTestRecord } from './helpers/assert-value.js';
import { observeWorkspaceIdentity } from '../src/host/kernel/workspace/workspace-identity.js';
import { CODEX_MODELS } from '../src/host/kernel/codex-model-policy.js';
import { createMcpBridgeHandler, startMcpBridgeServer } from '../src/kernel/bridge/mcp.js';

const fixture = async (allowedPaths = ['README.md']) => {
  const root = await mkdtemp(path.join(tmpdir(), 'kernel-local-control-'));
  const projectRoot = path.join(root, 'owner');
  const runtimeHome = path.join(root, 'runtime');
  await mkdir(projectRoot);
  await mkdir(runtimeHome);
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({ scripts: { test: 'node --version' } }));
  await writeFile(path.join(projectRoot, 'README.md'), 'initial\n');
  for (const args of [['init', '--quiet'], ['add', '.'],
    ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'initial']]) {
    const result = spawnSync('git', args, { cwd: projectRoot, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  const cp = await createKernelControlPlane({ projectRoot, runtimeHome, env: {} });
  const runId = 'run-local-control';
  await cp.startRun({ runId, objective: 'update README',
    taskContract: { acceptance: ['README updated'], allowedPaths } });
  return { root, projectRoot, runtimeHome, runId, cp };
};

test('local control rejects unsupported or malformed starts without preparing a Step', async () => {
  const f = await fixture();
  try {
    const control = createLocalWorkerControl({ ...f, env: {} });
    const before = f.cp.getCurrentStep(f.runId);
    const capabilities = await control({ action: 'capabilities' });
    assert.equal(capabilities.status, 'unsupported');
    assert.equal(capabilities.writableStart, false);
    assert.equal((await control({ action: 'start', runId: f.runId })).failureCode, 'host_worker_start_fields_missing');
    const denied = await control({ action: 'start', runId: f.runId, model: 'fixture', effort: 'high' });
    assert.equal(denied.status, 'unsupported');
    assert.equal(denied.failureCode, 'host_worker_native_isolation_unverified');
    assert.deepEqual(f.cp.getCurrentStep(f.runId), before);
    assert.equal(f.cp.getHostRoutingSnapshot(f.runId).stepAttempts.length, 0);
    const observed = await control({ action: 'attach', runId: f.runId });
    assert.equal(observed.status, 'attached');
    assert.equal(observed.liveWorker, null);
    assert.equal(assertTestRecord(observed.canonical).status, 'active');
  } finally { await f.cp.close(); await rm(f.root, { recursive: true, force: true }); }
});

const ioServer = String.raw`
const fs=require('node:fs');
const send=m=>process.stdout.write(JSON.stringify(m)+'\n');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
  const m=JSON.parse(line),mode=process.env.IO_MODE;
  if(m.method==='initialize')send({id:m.id,result:{}});
  if(m.method==='config/read')send({id:m.id,result:{config:{mcp_servers:{fixture:{command:'must-not-forward',env:{SECRET:'private'}}},apps:{fixture:{enabled:true}},plugins:{fixture:{enabled:true}}}}});
  if(m.method==='thread/start'){
    if(m.params.sandbox!=='read-only'||m.params.approvalPolicy!=='never')throw Error('not read-only');
    const c=m.params.config;
    if(c.features.shell_tool!==false||c.features.multi_agent!==false||c.features.apps!==false||c.features.hooks!==false
      ||c.web_search!=='disabled'||c.mcp_servers.fixture.enabled!==false||c.plugins.fixture.enabled!==false
      ||c.apps.fixture.enabled!==false||JSON.stringify(c).includes('must-not-forward')||JSON.stringify(c).includes('private'))throw Error('tools not disabled');
    send({id:m.id,result:{thread:{id:'io-thread'},model:mode==='model'? 'wrong-model':m.params.model,reasoningEffort:m.params.config.model_reasoning_effort}});
  }
  if(m.method==='turn/start'){
    if(m.params.model!==process.env.IO_MODEL||m.params.sandboxPolicy.type!=='readOnly')throw Error('wrong Host policy');
    fs.appendFileSync(process.env.IO_CALLS,'call\n');
    if(mode==='source-change'||mode==='ignored-change')fs.appendFileSync(process.env.IO_SOURCE,'changed\n');
    if(mode==='tamper')fs.writeFileSync(require('node:path').join(m.params.cwd,'extra.txt'),'extra');
    const usage={last:{inputTokens:3},total:{inputTokens:30,cachedInputTokens:0,outputTokens:8}};
    send({method:'thread/tokenUsage/updated',params:{threadId:'other',turnId:'io-turn',tokenUsage:{total:{inputTokens:999}}}});
    send({method:'thread/tokenUsage/updated',params:{threadId:'io-thread',turnId:'other',tokenUsage:{total:{inputTokens:999}}}});
    send({method:'thread/tokenUsage/updated',params:{threadId:'io-thread',turnId:'io-turn',tokenUsage:usage}});
    const request=JSON.parse(m.params.input[0].text.split('\n').at(-1));
    const filePath=request.filePath;
    let response={path:filePath,code:'export const generated = true;\n'};
    if(request.question){
      const fact={path:request.references[0].path,symbol:'initial',quote:'initial',uncertainty:'none'};
      if(mode==='read-quote')fact.quote='invented initial';
      if(mode==='read-symbol')fact.symbol='init';
      if(mode==='read-path')fact.path='elsewhere.md';
      response={summary:'An unverified interpretation of the fixture.',facts:[fact]};
    }
    const event=(threadId,turnId,type,method)=>({method,params:{threadId,turnId,item:{type,id:'forbidden'}}});
    send(event('other-thread','io-turn','commandExecution','item/completed'));
    send(event('io-thread','other-turn','commandExecution','item/completed'));
    const toolMode=mode.startsWith('tool-');
    if(toolMode&&!mode.endsWith('-after'))send(event('io-thread','io-turn',mode.includes('unknown')?'futureTool':'commandExecution',mode.includes('delta')?'item/commandExecution/outputDelta':mode.includes('started')?'item/started':'item/completed'));
    if(mode==='path')response.path='../escape';
    if(mode==='extra')response.extra=true;
    if(mode==='empty')response.code='';
    if(mode==='size')response.code='x'.repeat(50000);
    if(mode!=='missing')send({method:'item/completed',params:{threadId:'io-thread',turnId:'io-turn',item:{id:'final',type:'agentMessage',phase:'final_answer',text:mode==='json'?'bad json':JSON.stringify(response)}}});
    send({id:m.id,result:{turn:{id:'io-turn'}}});
    if(toolMode&&mode.endsWith('-after'))send(event('io-thread','io-turn','mcpToolCall','item/completed'));
    send({method:'turn/completed',params:{threadId:'io-thread',turn:{id:'io-turn',status:mode==='failed'?'failed':'completed'}}});
    send({method:'thread/tokenUsage/updated',params:{threadId:'io-thread',turnId:'io-turn',tokenUsage:{total:{inputTokens:999}}}});
  }
});
`;

const ioFixture = async (mode = '') => {
  const f = await fixture(['generated/**']);
  const server = path.join(f.root, 'io-server.cjs');
  const calls = path.join(f.root, 'calls');
  await writeFile(server, ioServer);
  await writeFile(calls, '');
  const reference = mode === 'ignored-change' ? 'ignored-reference.mjs' : 'README.md';
  if (mode === 'ignored-change') {
    await writeFile(path.join(f.projectRoot, '.gitignore'), 'ignored-reference.mjs\n');
    await writeFile(path.join(f.projectRoot, reference), 'initial\n');
  }
  const options = { projectRoot: f.projectRoot, runtimeHome: f.runtimeHome, env: {}, ioWriter: {
    transportOptions: { executable: process.execPath, args: [server], requestTimeoutMs: 1500,
      env: { ...process.env, IO_MODE: mode, IO_CALLS: calls, IO_SOURCE: path.join(f.projectRoot, reference), IO_MODEL: CODEX_MODELS.luna } },
  } };
  const request = { action: 'io-write', runId: f.runId, stepId: f.cp.getCurrentStep(f.runId)!.stepId,
    expectedWorkspaceIdentity: observeWorkspaceIdentity({ projectRoot: f.projectRoot }).identity,
    filePath: 'generated/candidate.test.mjs', specification: 'Return the fixed module.',
    references: [{ path: reference, sha256: 'sha256:' + createHash('sha256').update('initial\n').digest('hex') }],
    maxInputBytes: 10000, maxOutputBytes: 10000, timeoutMs: 3000 };
  return { ...f, calls, options, request, control: createLocalWorkerControl(options) };
};

test('Reader opt-in serves checked source quotes through local and MCP controls without advancing the Run', async () => {
  const f = await ioFixture();
  try {
    const { filePath: _filePath, specification: _spec, action: _action, ...bound } = f.request;
    const { runId, ...fixed } = { ...bound, question: 'What text is in the reference?' };
    const options = { ...f.options, ioReader: f.options.ioWriter };
    const control = createLocalWorkerControl(options);
    const request = { ...fixed, runId, action: 'io-read' };
    const before = await f.cp.getRun(runId);
    assert.equal((await f.control(request)).failureCode, 'host_io_not_enabled');
    assert.equal(await readFile(f.calls, 'utf8'), '');
    const handler = createMcpBridgeHandler(options);
    const invoke = async (args: Record<string, unknown>) => {
      const result = assertTestRecord(assertTestRecord(await handler({ id: 1, method: 'tools/call',
        params: { name: 'kernel_attach', arguments: args } })).result);
      const payload = JSON.parse(String(assertTestRecord((result.content as unknown[])[0]).text));
      return { payload, isError: result.isError };
    };
    const mcpArgs = { workspaceRoot: f.projectRoot, runId, ioRead: fixed };
    for (const extra of [{ ioWrite: {} }, { worker: { action: 'interrupt' } }, { contractJson: {} },
      { report: {} }, { ioRead: { ...fixed, model: 'forged' } }]) {
      const rejected = await invoke({ ...mcpArgs, ...extra });
      assert.equal(rejected.isError, true);
      assert.equal(rejected.payload.code, 'host_io_request_invalid');
    }
    assert.equal(await readFile(f.calls, 'utf8'), '');
    const local = await control(request);
    const mcp = await invoke(mcpArgs);
    assert.equal(mcp.isError, false);
    for (const result of [local, mcp.payload]) {
      assert.equal(result.status, 'evidence-ready', JSON.stringify(result));
      assert.equal(result.semanticReview, 'REQUIRED');
      assert.equal(result.kernelDone, false);
      assert.deepEqual(result.evidence, [{ ...fixed.references[0], symbol: 'initial', quote: 'initial',
        uncertainty: 'none', startLine: 1, endLine: 1 }]);
      assert.equal(result.usage.inputTokens, 30);
    }
    assert.equal(await readFile(f.calls, 'utf8'), 'call\ncall\n');
    assert.equal((await f.cp.getRun(runId))?.revision, before?.revision);
    assert.equal(f.cp.getHostRoutingSnapshot(runId).stepAttempts.length, 0);
  } finally { await f.cp.close(); await rm(f.root, { recursive: true, force: true }); }
});

test('Reader refuses unbound input and discards incorrect citations, tool events and stale source', async () => {
  for (const [mode, expected] of [
    ['read-quote', 'host_io_citation_invalid'], ['read-symbol', 'host_io_citation_invalid'],
    ['read-path', 'host_io_scope_rejected'], ['ignored-change', 'host_io_stale_reference'],
    ['tool-completed', 'codex_app_server_tool_event_forbidden'],
  ] as const) {
    const f = await ioFixture(mode);
    try {
      const { filePath: _filePath, specification: _spec, ...bound } = f.request;
      const control = createLocalWorkerControl({ ...f.options, ioReader: f.options.ioWriter });
      const request = { ...bound, action: 'io-read', question: 'What text is in the reference?' };
      assert.equal((await control({ ...request, stepId: 'stale-step' })).failureCode, 'host_io_stale_work_unit');
      assert.equal((await control({ ...request, maxInputBytes: 1 })).failureCode, 'host_io_input_budget_exceeded');
      assert.equal(await readFile(f.calls, 'utf8'), '');
      const result = await control(request);
      assert.equal(result.failureCode, expected, JSON.stringify(result));
      assert.equal(Object.hasOwn(result, 'evidence'), false);
      assert.equal(assertTestRecord(result.usage).inputTokens, 30);
    } finally { await f.cp.close(); await rm(f.root, { recursive: true, force: true }); }
  }
});

test('local JSON-lines and MCP stdio both use the Host Writer without advancing or applying the candidate', async () => {
  for (const protocol of ['local', 'mcp']) {
    const f = await ioFixture();
    const stdin = new PassThrough(), stdout = new PassThrough();
    const host = protocol === 'local' ? startLocalWorkerControl({ ...f.options, stdin, stdout })
      : startMcpBridgeServer({ ...f.options, stdin, stdout });
    let candidateRoot: string | null = null;
    const call = (request: Record<string, unknown>) => new Promise<Record<string, unknown>>((resolve, reject) => {
      stdout.once('data', data => {
        try { resolve(assertTestRecord(JSON.parse(data.toString('utf8')))); } catch (error) { reject(error); }
      });
      stdin.write(JSON.stringify(request) + '\n');
    });
    try {
      const before = await f.cp.getRun(f.runId), step = f.cp.getCurrentStep(f.runId);
      const { action: _action, runId, ...ioWrite } = f.request;
      const request = protocol === 'local' ? { id: 'generate', ...f.request }
        : { jsonrpc: '2.0', id: 'generate', method: 'tools/call', params: {
          name: 'kernel_attach', arguments: { workspaceRoot: f.projectRoot, runId, ioWrite } } };
      const response = await call(request);
      assert.equal(response.id, 'generate');
      const result = protocol === 'local' ? response
        : assertTestRecord(JSON.parse(String(assertTestRecord((assertTestRecord(response.result).content as unknown[])[0]).text)));
      if (protocol === 'mcp') assert.equal(assertTestRecord(response.result).isError, false);
      assert.equal(result.status, 'generated', JSON.stringify(result));
      assert.equal(result.code, undefined);
      assert.equal(result.next, undefined);
      assert.equal(result.hostProductProof, 'NOT_RUN');
      assert.equal(result.ownerDelivery, 'HOLD_SAFE');
      assert.equal(result.kernelDone, false);
      assert.equal(assertTestRecord(result.usage).inputTokens, 30);
      const candidate = String(result.candidatePath);
      candidateRoot = path.dirname(path.dirname(candidate));
      assert.equal(await readFile(candidate, 'utf8'), 'export const generated = true;\n');
      const repeated = await call(request);
      const duplicate = protocol === 'local' ? repeated
        : assertTestRecord(JSON.parse(String(assertTestRecord((assertTestRecord(repeated.result).content as unknown[])[0]).text)));
      assert.equal(duplicate.failureCode, 'host_io_duplicate_request');
      if (protocol === 'mcp') assert.equal(assertTestRecord(repeated.result).isError, true);
      assert.equal(await readFile(f.calls, 'utf8'), 'call\n');
      assert.equal((await f.cp.getRun(f.runId))?.revision, before?.revision);
      assert.deepEqual(f.cp.getCurrentStep(f.runId), step);
      assert.equal(f.cp.getHostRoutingSnapshot(f.runId).stepAttempts.length, 0);
      await assert.rejects(access(path.join(f.projectRoot, f.request.filePath)));
    } finally {
      host.close(); stdin.destroy(); stdout.destroy();
      await f.cp.close();
      if (candidateRoot) await rm(candidateRoot, { recursive: true, force: true });
      await rm(f.root, { recursive: true, force: true });
    }
  }
});

test('MCP Host opt-in rejects mixed lifecycle, request overrides and conflicting Run bindings before dispatch', async () => {
  const f = await ioFixture();
  const decode = (response: unknown) => {
    const result = assertTestRecord(assertTestRecord(response).result);
    return assertTestRecord(JSON.parse(String(assertTestRecord((result.content as unknown[])[0]).text)));
  };
  try {
    const { action: _action, runId, ...ioWrite } = f.request;
    const handler = createMcpBridgeHandler(f.options);
    const args = { workspaceRoot: f.projectRoot, runId, ioWrite };
    const request = (name: string, arguments_: Record<string, unknown>) => ({ jsonrpc: '2.0', id: 1,
      method: 'tools/call', params: { name, arguments: arguments_ } });
    const before = await f.cp.getRun(f.runId), step = f.cp.getCurrentStep(f.runId);
    const disabled = createMcpBridgeHandler({ ...f.options, ioWriter: undefined });
    assert.equal(decode(await disabled(request('kernel_attach', args))).code, 'host_io_not_enabled');
    for (const [name, changes] of [
      ['kernel_next', {}], ['kernel_report', {}], ['kernel_status', {}],
      ['kernel_attach', { contractJson: { objective: 'smuggled successor' } }],
      ['kernel_attach', { worker: { action: 'interrupt', attemptId: 'other' } }],
      ['kernel_attach', { report: {} }], ['kernel_attach', { runId: '' }],
      ['kernel_attach', { ioWrite: null }], ['kernel_attach', { ioWrite: [] }],
      ['kernel_attach', { ioWrite: {} }],
      ['kernel_attach', { ioWrite: { ...ioWrite, runId: 'other' } }],
      ['kernel_attach', { ioWrite: { ...ioWrite, transportOptions: {} } }],
    ] as const) {
      assert.equal(decode(await handler(request(name, { ...args, ...changes }))).code, 'host_io_request_invalid');
    }
    const bound = createMcpBridgeHandler({ ...f.options, env: { MOON_RELAY_KERNEL_RUN_ID: 'other-run' } });
    assert.equal(decode(await bound(request('kernel_attach', args))).failureCode, 'run_binding_conflict');
    assert.equal(await readFile(f.calls, 'utf8'), '');
    assert.equal((await f.cp.getRun(f.runId))?.revision, before?.revision);
    assert.deepEqual(f.cp.getCurrentStep(f.runId), step);
    assert.equal(f.cp.getHostRoutingSnapshot(f.runId).stepAttempts.length, 0);
  } finally { await f.cp.close(); await rm(f.root, { recursive: true, force: true }); }
});

test('Host opt-in generates one isolated candidate, accounts early total usage, and keeps all Owner authority unchanged', async () => {
  const f = await ioFixture();
  let candidateRoot: string | null = null;
  try {
    const disabled = createLocalWorkerControl({ ...f.options, ioWriter: undefined });
    assert.equal((await disabled(f.request)).failureCode, 'host_io_not_enabled');
    const before = await f.cp.getRun(f.runId);
    const step = f.cp.getCurrentStep(f.runId);
    const result = await f.control(f.request);
    assert.equal(result.status, 'generated', JSON.stringify(result));
    assert.equal(result.requestedModel, CODEX_MODELS.luna);
    assert.equal(result.requestedEffort, 'medium');
    assert.equal(result.observedModel, null); // Thread config is not provider enforcement.
    assert.deepEqual(result.usage, { inputTokens: 30, cachedInputTokens: 0, cacheWriteInputTokens: null,
      outputTokens: 8, reasoningOutputTokens: null });
    assert.equal(result.ownerDelivery, 'HOLD_SAFE');
    assert.equal(result.hostProductProof, 'NOT_RUN');
    assert.equal(result.kernelDone, false);
    assert.equal(result.code, undefined); // Main sees metadata, not repeated generated bytes.
    const candidate = String(result.candidatePath);
    candidateRoot = path.dirname(path.dirname(candidate));
    assert.equal(await readFile(candidate, 'utf8'), 'export const generated = true;\n');
    assert.deepEqual(await readdir(candidateRoot), ['generated']);
    await assert.rejects(access(path.join(f.projectRoot, f.request.filePath)));
    assert.equal((await f.control(f.request)).failureCode, 'host_io_duplicate_request');
    assert.equal(await readFile(f.calls, 'utf8'), 'call\n');
    assert.equal((await f.cp.getRun(f.runId))?.mutationRevision, before?.mutationRevision);
    assert.deepEqual(f.cp.getCurrentStep(f.runId), step);
    assert.equal(f.cp.getHostRoutingSnapshot(f.runId).stepAttempts.length, 0);
  } finally {
    await f.cp.close();
    if (candidateRoot) await rm(candidateRoot, { recursive: true, force: true });
    await rm(f.root, { recursive: true, force: true });
  }
});

test('Writer supports separate new destinations but rejects aliases and concurrent duplicate calls', async () => {
  const f = await ioFixture();
  const roots: string[] = [];
  try {
    const before = await f.cp.getRun(f.runId);
    const results = await Promise.all([f.control(f.request),
      f.control({ ...f.request, filePath: 'generated/second.test.mjs' })]);
    for (const result of results) {
      assert.equal(result.status, 'generated', JSON.stringify(result));
      roots.push(path.dirname(path.dirname(String(result.candidatePath))));
    }
    for (const filePath of ['generated\\candidate.test.mjs', 'generated/CANDIDATE.TEST.MJS']) {
      assert.equal((await f.control({ ...f.request, filePath })).failureCode, 'host_io_duplicate_request');
    }
    const concurrent = await Promise.all([f.control({ ...f.request, filePath: 'generated/third.test.mjs' }),
      f.control({ ...f.request, filePath: 'generated/third.test.mjs' })]);
    assert.equal(concurrent.filter(row => row.status === 'generated').length, 1);
    assert.equal(concurrent.filter(row => row.failureCode === 'host_io_duplicate_request').length, 1);
    const accepted = concurrent.find(row => row.status === 'generated')!;
    roots.push(path.dirname(path.dirname(String(accepted.candidatePath))));
    assert.equal(await readFile(f.calls, 'utf8'), 'call\ncall\ncall\n');
    assert.equal((await f.cp.getRun(f.runId))?.revision, before?.revision);
    assert.equal(f.cp.getHostRoutingSnapshot(f.runId).stepAttempts.length, 0);
  } finally {
    await f.cp.close();
    for (const root of roots) await rm(root, { recursive: true, force: true });
    await rm(f.root, { recursive: true, force: true });
  }
});

test('Writer rejects unexpected tools even when the server returns valid generated JSON and completion', async () => {
  for (const mode of ['tool-started', 'tool-completed', 'tool-delta', 'tool-unknown', 'tool-completed-after']) {
    const f = await ioFixture(mode);
    try {
      const result = await f.control(f.request);
      assert.equal(result.status, 'failed', mode);
      assert.equal(result.failureCode, 'codex_app_server_tool_event_forbidden', mode);
      assert.equal(assertTestRecord(result.usage).inputTokens, 30);
      assert.equal(result.candidatePath, undefined);
      assert.equal(result.ownerDelivery, 'HOLD_SAFE');
      assert.equal((await f.control(f.request)).failureCode, 'host_io_duplicate_request');
      assert.equal(await readFile(f.calls, 'utf8'), 'call\n');
      await assert.rejects(access(path.join(f.projectRoot, f.request.filePath)));
    } finally { await f.cp.close(); await rm(f.root, { recursive: true, force: true }); }
  }
});

test('Host I/O rejects unbounded, existing, stale, oversized and linked paths before a model call', async () => {
  const f = await ioFixture();
  try {
    const cases = [
      [{ filePath: '../escape' }, 'host_io_path_invalid'],
      [{ filePath: 'generated/../../escape' }, 'host_io_path_invalid'],
      [{ filePath: 'C:/escape' }, 'host_io_path_invalid'],
      [{ filePath: 'generated/NUL.js' }, 'host_io_path_invalid'],
      [{ filePath: 'outside/file.mjs' }, 'host_io_scope_rejected'],
      [{ stepId: 'old-step' }, 'host_io_stale_work_unit'],
      [{ expectedWorkspaceIdentity: 'old' }, 'host_io_stale_snapshot'],
      [{ maxInputBytes: 1 }, 'host_io_input_budget_exceeded'],
      [{ maxOutputBytes: 0 }, 'host_io_budget_required'],
      [{ references: [{ path: 'README.md', sha256: 'stale' }] }, 'host_io_stale_reference'],
    ] as const;
    for (const [patch, expected] of cases) {
      assert.equal((await f.control({ ...f.request, ...patch })).failureCode, expected);
    }
    await mkdir(path.join(f.projectRoot, 'generated'));
    await writeFile(path.join(f.projectRoot, f.request.filePath), 'existing');
    const existing = { ...f.request, expectedWorkspaceIdentity: observeWorkspaceIdentity({ projectRoot: f.projectRoot }).identity };
    assert.equal((await f.control(existing)).failureCode, 'host_io_existing_file');
    assert.equal(await readFile(path.join(f.projectRoot, f.request.filePath), 'utf8'), 'existing');
    await symlink(f.root, path.join(f.projectRoot, 'generated', 'linked'), 'junction');
    assert.equal((await f.control({ ...f.request, filePath: 'generated/linked/escape.mjs',
      expectedWorkspaceIdentity: observeWorkspaceIdentity({ projectRoot: f.projectRoot }).identity })).failureCode, 'host_io_symlink_rejected');
    assert.equal(await readFile(f.calls, 'utf8'), '');
  } finally { await f.cp.close(); await rm(f.root, { recursive: true, force: true }); }
});

test('failed I/O preserves usage and refuses response defects, source drift, model mismatch and model-created files without retry', async () => {
  for (const [mode, code] of [['path', 'host_io_response_invalid'], ['extra', 'host_io_response_invalid'],
    ['empty', 'host_io_response_invalid'], ['size', 'host_io_response_invalid'], ['json', 'host_io_response_invalid'],
    ['missing', 'host_io_response_invalid'], ['failed', 'host_io_turn_incomplete'], ['model', 'host_io_model_mismatch'],
    ['source-change', 'host_io_stale_snapshot'], ['tamper', 'host_io_candidate_tampered']]) {
    const f = await ioFixture(mode);
    try {
      const result = await f.control(f.request);
      assert.equal(result.status, 'failed');
      assert.equal(result.failureCode, code, mode + ': ' + JSON.stringify(result));
      assert.equal(assertTestRecord(result.usage).inputTokens, 30);
      assert.equal(result.ownerDelivery, 'HOLD_SAFE');
      await assert.rejects(access(path.join(f.projectRoot, f.request.filePath)));
      if (mode !== 'source-change') assert.equal((await f.control(f.request)).failureCode, 'host_io_duplicate_request');
      assert.equal(await readFile(f.calls, 'utf8'), 'call\n');
      assert.equal((await f.cp.getRun(f.runId))?.mutationRevision, 0);
    } finally { await f.cp.close(); await rm(f.root, { recursive: true, force: true }); }
  }
});

test('ignored reference changes invalidate a candidate even when the Git workspace identity stays unchanged', async () => {
  const f = await ioFixture('ignored-change');
  try {
    const result = await f.control(f.request);
    assert.equal(observeWorkspaceIdentity({ projectRoot: f.projectRoot }).identity, f.request.expectedWorkspaceIdentity);
    assert.equal(result.status, 'failed');
    assert.equal(result.failureCode, 'host_io_stale_reference');
    assert.equal(assertTestRecord(result.usage).inputTokens, 30);
    assert.equal(await readFile(f.calls, 'utf8'), 'call\n');
    await assert.rejects(access(path.join(f.projectRoot, f.request.filePath)));
  } finally { await f.cp.close(); await rm(f.root, { recursive: true, force: true }); }
});

test('local Main replacement reuses the owning Host Attempt and cancels only its original Turn', async () => {
  const f = await fixture();
  const server = path.join(f.root, 'server.cjs');
  await writeFile(server, String.raw`
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') send({ id: m.id, result: { userAgent: 'fixture' } });
  if (m.method === 'thread/start') send({ id: m.id, result: { thread: { id: 'local-thread' } } });
  if (m.method === 'turn/start') send({ id: m.id, result: { turn: { id: 'local-turn', status: 'inProgress' } } });
  if (m.method === 'turn/interrupt') {
    send({ id: m.id, result: {} });
    send({ method: 'turn/completed', params: { threadId: m.params.threadId,
      turn: { id: m.params.turnId, status: 'interrupted' } } });
  }
});
`);
  // This lifecycle fixture never authorizes Owner delivery. It is interrupted
  // before producing a result; the configured Host boundary always denies.
  const sessions = createHostWorkerSessions({ env: {},
    transportOptions: { executable: process.execPath, args: [server], requestTimeoutMs: 1500 },
    withWriterExcluded: async () => { throw new Error('fixture has no delivery authority'); },
  });
  const options = { projectRoot: f.projectRoot, runtimeHome: f.runtimeHome, env: {}, hostWorkerSessions: sessions };
  const connect = () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const host = startLocalWorkerControl({ ...options, stdin, stdout });
    return {
      call: (request: Record<string, unknown>) => new Promise<Record<string, unknown>>((resolve, reject) => {
        stdout.once('data', data => {
          try { resolve(assertTestRecord(JSON.parse(data.toString('utf8')))); } catch (error) { reject(error); }
        });
        stdin.write(JSON.stringify({ id: 1, runId: f.runId, ...request }) + '\n');
      }),
      close() { host.close(); stdin.destroy(); stdout.destroy(); },
    };
  };
  let attemptId: string | null = null;
  const first = connect();
  let second: ReturnType<typeof connect> | null = null;
  try {
    const started = await first.call({ action: 'start', model: 'fixture', effort: 'high' });
    assert.equal(started.status, 'host-worker-attached');
    attemptId = String(assertTestRecord(started.hostWorker).attemptId);
    first.close();
    second = connect();
    const attached = await second.call({ action: 'attach' });
    assert.equal(assertTestRecord(attached.liveWorker).attemptId, attemptId);
    const retried = await second.call({ action: 'resume', model: 'fixture', effort: 'high' });
    assert.equal(assertTestRecord(retried.hostWorker).attemptId, attemptId);
    assert.equal(retried.next, undefined);
    assert.equal(f.cp.getHostRoutingSnapshot(f.runId).stepAttempts.length, 1);
    const wrong = await second.call({ action: 'interrupt', attemptId: 'other-attempt' });
    assert.equal(assertTestRecord(wrong.hostWorkerSignal).status, 'not-attached');
    const conflicting = createLocalWorkerControl({ ...options, env: { MOON_RELAY_KERNEL_RUN_ID: 'other-run' } });
    assert.equal((await conflicting({ action: 'attach', runId: f.runId })).failureCode, 'run_binding_conflict');
    const canceled = await second.call({ action: 'interrupt', attemptId });
    assert.ok(['queued', 'requested'].includes(String(assertTestRecord(canceled.hostWorkerSignal).status)));
    let live = await sessions.status(f.projectRoot, f.runtimeHome, f.runId);
    for (let n = 0; n < 100 && live?.turnStatus === 'pending'; n++) {
      await sleep(20);
      live = await sessions.status(f.projectRoot, f.runtimeHome, f.runId);
    }
    assert.equal(live?.completedTurn?.threadId, 'local-thread');
    assert.equal(live?.completedTurn?.turnId, 'local-turn');
    assert.equal(live?.turnStatus, 'interrupted');
    assert.equal(live?.deliveryAuthorized, false);
    assert.equal((await f.cp.getRun(f.runId))?.mutationRevision, 0);
  } finally {
    first.close(); second?.close();
    if (attemptId) await sessions.interrupt(f.projectRoot, f.runtimeHome, f.runId, attemptId);
    await f.cp.close(); await rm(f.root, { recursive: true, force: true });
  }
});
