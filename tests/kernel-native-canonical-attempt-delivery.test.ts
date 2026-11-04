// Opt-in macOS Native conformance. Real Kernel Attempt A remains physically
// writable while Attempt B runs in another Worktree and Owner CAS accepts only B.
// No model call. No product Dispatcher/Report mutation. No automatic retirement.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import { createKernelControlPlane } from '../src/host/kernel/control-plane-runtime.js';
import { dispatchKernelParallel } from '../src/host/kernel/parallel-dispatcher.js';
import { prepareHostWriterAttemptWorktree } from '../src/host/kernel/workspace/physical-worktree.js';
import { reserveHostWorkspaceWriter } from '../src/host/kernel/workspace-writer-reservation.js';
import { observeWorkspaceIdentity } from '../src/host/kernel/workspace/workspace-identity.js';

const enabled = process.platform === 'darwin'
  && process.env.W0_NATIVE_CANONICAL_AB_CONFORMANCE === '1'
  && Boolean(process.env.CODEX_HOME);

type RpcPending = {
  resolve: (result: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
const git = (root: string, args: string[], input?: string): string => {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', input, timeout: 10_000 });
  assert.equal(result.status, 0, String(result.stderr || result.error || 'git failed'));
  return String(result.stdout || '').trimEnd();
};
const writerRow = (pid: number): string => {
  const result = spawnSync('/bin/ps', ['-o', 'pid=,ppid=,pgid=,stat=', '-p', String(pid)], {
    encoding: 'utf8', timeout: 5000,
  });
  return result.status === 0 ? result.stdout.trim() : '';
};
class NativeTestServer {
  private child: ChildProcessWithoutNullStreams;
  private requestId = 0;
  private pending = new Map<number, RpcPending>();
  private text = '';
  constructor(cwd: string) {
    this.child = spawn(process.env.W0_CODEX_EXECUTABLE || 'codex', ['app-server'], {
      cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
    });
    this.child.stderr.resume();
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      this.text += chunk;
      for (;;) {
        const pos = this.text.indexOf('\n');
        if (pos < 0) break;
        const line = this.text.slice(0, pos);
        this.text = this.text.slice(pos + 1);
        let message: Record<string, unknown>;
        try { message = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
        if (typeof message.id !== 'number') continue;
        const request = this.pending.get(message.id);
        if (!request) continue;
        this.pending.delete(message.id);
        clearTimeout(request.timer);
        if (message.error) request.reject(new Error('native_rpc_error'));
        else request.resolve(message.result as Record<string, unknown>);
      }
    });
    this.child.once('exit', () => {
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error('native_app_server_exited'));
      }
      this.pending.clear();
    });
  }
  request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const id = ++this.requestId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('native_rpc_timeout:' + method));
      }, 10_000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  async initialize() {
    await this.request('initialize', {
      clientInfo: { name: 'moonrelay-w0-t29', title: 'W0 Canonical A/B Native conformance', version: '0.0.1' },
    });
    this.child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
  }
  async exec(argv: string[], cwd: string) {
    return this.request('command/exec', {
      command: argv, cwd, timeoutMs: 12_000,
      sandboxPolicy: {
        type: 'workspaceWrite', writableRoots: [cwd],
        networkAccess: false, excludeSlashTmp: true, excludeTmpdirEnvVar: true,
      },
    });
  }
  async close() {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const ended = once(this.child, 'exit');
    this.child.kill('SIGTERM');
    await Promise.race([ended, delay(1500)]);
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill('SIGKILL');
      await Promise.race([ended, delay(750)]);
    }
  }
}

test('T29 Mac Native Canonical A Writer alive while B writes and only B Owner CAS applies', {
  skip: !enabled && 'macOS with explicit isolated CODEX_HOME and W0_NATIVE_CANONICAL_AB_CONFORMANCE=1 required',
  timeout: 38_000,
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'w0-native-canonical-ab-'));
  const owner = path.join(root, 'owner');
  const runtimeHome = path.join(root, 'runtime');
  const reservationRoot = path.join(root, 'host-reservations');
  const ownerMarker = path.join(owner, 'shared.txt');
  const hostMarker = path.join(reservationRoot, 'host-sentinel.txt');
  const runId = 'w0-native-canonical-ab';
  const servers: NativeTestServer[] = [];
  const worktrees: string[] = [];
  let cp: Awaited<ReturnType<typeof createKernelControlPlane>> | null = null;
  let writerPid: number | null = null;
  let safeToRemove = false;
  try {
    await mkdir(owner); await mkdir(reservationRoot);
    git(owner, ['init', '-b', 'main']);
    git(owner, ['config', 'user.name', 'Canonical A/B W0 Fixture']);
    git(owner, ['config', 'user.email', 'w0-canonical-ab@example.invalid']);
    await writeFile(path.join(owner, 'package.json'), '{"name":"w0-canonical-ab"}\n');
    await writeFile(ownerMarker, 'base\n');
    git(owner, ['add', '--all']);
    git(owner, ['commit', '-m', 'baseline']);
    const baseCommit = git(owner, ['rev-parse', 'HEAD']);
    await writeFile(hostMarker, 'HOST_ONLY\n');

    cp = await createKernelControlPlane({ runtimeHome, projectRoot: owner });
    await cp.startRun({ runId, objective: 'Verify independent canonical Native A/B writes and Owner CAS' });
    const run = await cp.getRun(runId);
    const a = cp.beginAttempt(runId);
    assert.ok(run?.projectId && a?.stepId && a.attemptId);
    const coords = { repoRoot: owner, runtimeHome, projectId: run.projectId, baseCommit, runId, stepId: a.stepId };
    const register = async (attempt: typeof a) => {
      assert.ok(attempt?.attemptId);
      const prepared = await prepareHostWriterAttemptWorktree({ ...coords, attemptId: attempt.attemptId });
      worktrees.push(prepared.workspaceRoot);
      const registered = cp!.registerExecutionWorkspace(runId, prepared.workspaceRoot);
      const attached = await cp!.updateStepAttempt(String(attempt.id), {
        workspaceId: registered.workspaceId,
        baseWorkspaceIdentity: prepared.baseWorkspaceIdentity,
      });
      assert.equal(attached?.attemptId, attempt.attemptId);
      assert.equal(cp!.getAttemptById(runId, attempt.attemptId)?.workspaceId, registered.workspaceId);
      await reserveHostWorkspaceWriter({
        workspaceRoot: prepared.workspaceRoot, reservationRoot, runId,
        attemptId: attempt.attemptId, workspaceId: registered.workspaceId,
      });
      return { ...prepared, workspaceId: registered.workspaceId };
    };
    const aWorkspace = await register(a);
    const aScript = path.join(aWorkspace.workspaceRoot, 'write-a.cjs');
    await writeFile(aScript, [
      "const fs=require('node:fs');",
      "const path=require('node:path');",
      "const root=__dirname;fs.writeFileSync(path.join(root,'writer.pid'),String(process.pid));",
      "let n=0,deniedB=0,deniedOwner=0,deniedHost=0,allowedB=0,allowedOwner=0,allowedHost=0;",
      "const timer=setInterval(()=>{",
      " const fd=fs.openSync(path.join(root,'heartbeat.log'),'a');try{fs.writeSync(fd,String(++n)+'\\n');fs.fsyncSync(fd)}finally{fs.closeSync(fd)}",
      " let targets=null;try{targets=JSON.parse(fs.readFileSync(path.join(root,'targets.json'),'utf8'))}catch{}",
      " if(targets){",
      "  try{fs.writeFileSync(targets.b,'A_CORRUPTED_B');allowedB++}catch{deniedB++}",
      "  try{fs.writeFileSync(targets.owner,'A_CORRUPTED_OWNER');allowedOwner++}catch{deniedOwner++}",
      "  try{fs.writeFileSync(targets.host,'A_CORRUPTED_HOST');allowedHost++}catch{deniedHost++}",
      " }",
      " fs.writeFileSync(path.join(root,'writer-state.json'),JSON.stringify({n,deniedB,deniedOwner,deniedHost,allowedB,allowedOwner,allowedHost}));",
      " if(n>=300){clearInterval(timer);process.exit(0)}",
      "},40);",
    ].join('\n') + '\n');
    const aLauncher = path.join(aWorkspace.workspaceRoot, 'launch-a.cjs');
    await writeFile(aLauncher, [
      "const {spawn}=require('node:child_process');",
      "const path=require('node:path');",
      "const child=spawn(process.execPath,[path.join(__dirname,'write-a.cjs')],{detached:true,stdio:'ignore'});",
      "child.unref();process.stdout.write('WRITER_A='+child.pid+'\\n');",
    ].join('\n') + '\n');
    const serverA = new NativeTestServer(aWorkspace.workspaceRoot);
    servers.push(serverA);
    await serverA.initialize();
    const startedA = await serverA.exec([process.execPath, aLauncher], aWorkspace.workspaceRoot);
    assert.equal(startedA.exitCode, 0);
    for(let i=0;i<70 && !writerPid;i++){
      try { writerPid=Number((await readFile(path.join(aWorkspace.workspaceRoot,'writer.pid'),'utf8')).trim()); }
      catch { await delay(35); }
    }
    assert.ok(writerPid && writerRow(writerPid), 'real OS Writer A must be running');
    await serverA.close();
    const aHeartbeat = path.join(aWorkspace.workspaceRoot, 'heartbeat.log');
    const count = async () => {
      try {
        const str=(await readFile(aHeartbeat,'utf8')).trim();
        return str ? str.split('\n').length : 0;
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return 0;
        throw error;
      }
    };
    const beforeB=await count();await delay(130);
    assert.ok(await count()>beforeB,'Writer A must survive its App Server');

    // Kernel failure is intentionally NOT an OS termination receipt. B receives
    // a fresh canonical Attempt identity and physically separate Git Worktree.
    cp.failStepAttempt(runId,a.stepId,{code:'old_writer_exit_unknown'});
    assert.equal(cp.getAttemptById(runId,a.attemptId)?.status,'failed');
    const b=cp.beginAttempt(runId,{stepId:a.stepId,retryReason:'old_writer_exit_unknown'});
    assert.ok(b?.attemptId && b.attemptId!==a.attemptId);
    const bWorkspace=await register(b);
    assert.notEqual(aWorkspace.workspaceRoot,bWorkspace.workspaceRoot);
    assert.notEqual(aWorkspace.workspaceId,bWorkspace.workspaceId);
    await writeFile(path.join(aWorkspace.workspaceRoot,'targets.json'),
      JSON.stringify({b:path.join(bWorkspace.workspaceRoot,'shared.txt'),owner:ownerMarker,host:hostMarker}));
    await delay(250);
    const currentState=JSON.parse(await readFile(path.join(aWorkspace.workspaceRoot,'writer-state.json'),'utf8')) as {
      n:number;deniedB:number;deniedOwner:number;deniedHost:number;
      allowedB:number;allowedOwner:number;allowedHost:number;
    };
    assert.ok(currentState.deniedB>0 && currentState.deniedOwner>0 && currentState.deniedHost>0);
    assert.equal(currentState.allowedB+currentState.allowedOwner+currentState.allowedHost,0);
    assert.ok(writerRow(writerPid),'A must still be alive when B starts');

    const bScript=path.join(bWorkspace.workspaceRoot,'write-b.cjs');
    const aMarker=path.join(aWorkspace.workspaceRoot,'a-only.txt');
    await writeFile(aMarker,'A_ONLY\n');
    await writeFile(bScript,[
      "const fs=require('node:fs');",
      "let deniedA=0,deniedHost=0,allowedA=0,allowedHost=0;",
      "try{fs.writeFileSync(process.argv[2],'B_CORRUPTED_A');allowedA++}catch{deniedA++}",
      "try{fs.writeFileSync(process.argv[3],'B_CORRUPTED_HOST');allowedHost++}catch{deniedHost++}",
      "fs.writeFileSync('shared.txt','B:only\\n');",
      "fs.writeFileSync('b-write-result.json',JSON.stringify({deniedA,deniedHost,allowedA,allowedHost}));",
    ].join('\n')+'\n');
    const serverB=new NativeTestServer(bWorkspace.workspaceRoot);
    servers.push(serverB);
    await serverB.initialize();
    const finishedB=await serverB.exec([process.execPath,bScript,aMarker,hostMarker],bWorkspace.workspaceRoot);
    assert.equal(finishedB.exitCode,0);
    await serverB.close();
    const bReport=JSON.parse(await readFile(path.join(bWorkspace.workspaceRoot,'b-write-result.json'),'utf8')) as {
      deniedA:number;deniedHost:number;allowedA:number;allowedHost:number;
    };
    assert.deepEqual(bReport,{deniedA:1,deniedHost:1,allowedA:0,allowedHost:0});
    assert.equal(await readFile(aMarker,'utf8'),'A_ONLY\n');
    assert.equal(await readFile(hostMarker,'utf8'),'HOST_ONLY\n');
    assert.equal(await readFile(path.join(bWorkspace.workspaceRoot,'shared.txt'),'utf8'),'B:only\n');
    assert.equal(await readFile(ownerMarker,'utf8'),'base\n');
    assert.ok(writerRow(writerPid),'A must remain alive before Owner CAS Delivery');

    // Only the existing OWNER can materialize a validated B patch. No model
    // response, old A attempt or Worker writes directly to the Owner.
    const runBefore = await cp.getRun(runId);
    assert.ok(runBefore?.currentWorkspaceIdentity && runBefore.projectId);
    const snapshot={
      expectedMutationRevision:runBefore.mutationRevision,
      expectedWorkspaceIdentity:runBefore.currentWorkspaceIdentity,
      expectedHeadCommitSha:baseCommit,
      expectedProjectId:runBefore.projectId,
      expectedWorktreeId:runBefore.worktreeId,
      expectedWorkspaceId:runBefore.workspaceId,
    };
    const patchResult=spawnSync('git',['diff','--binary','--','shared.txt'],{
      cwd:bWorkspace.workspaceRoot,encoding:'utf8',timeout:10_000,
    });
    assert.equal(patchResult.status,0,patchResult.stderr);
    const patch=patchResult.stdout;
    assert.ok(patch.includes('B:only'), 'B must produce a patch from its isolated Git Worktree');
    const patchDigest='sha256:'+createHash('sha256').update(patch).digest('hex');
    const fence=cp.acquireOwnerWorkspaceMutationFence(runId,snapshot);
    assert.ok(fence.lock?.fencingToken,'existing Kernel Owner fence is required');
    assert.equal(git(owner,['status','--porcelain']),'','Owner must start clean');
    const precheck=spawnSync('git',['apply','--check','--binary','-'],{
      cwd:owner,input:patch,encoding:'utf8',timeout:10_000,
    });
    assert.equal(precheck.status,0,precheck.stderr);
    cp.assertOwnerWorkspaceMutationReady(runId,{
      ...snapshot,fencingToken:fence.lock.fencingToken,sessionToken:fence.lock.sessionToken,
      integrationWorkspaceIdentity:observeWorkspaceIdentity({projectRoot:bWorkspace.workspaceRoot}).identity,
      changedPaths:['shared.txt'],patchDigest,
    });
    const apply=spawnSync('git',['apply','--binary','-'],{
      cwd:owner,input:patch,encoding:'utf8',timeout:10_000,
    });
    assert.equal(apply.status,0,apply.stderr);
    const deliveredIdentity=observeWorkspaceIdentity({projectRoot:owner}).identity;
    const mutation=cp.recordOwnerWorkspaceMutation(runId,{
      ...snapshot,fencingToken:fence.lock.fencingToken,sessionToken:fence.lock.sessionToken,
      integrationWorkspaceIdentity:deliveredIdentity,changedPaths:['shared.txt'],patchDigest,
    });
    assert.equal(mutation.status,'applied');
    assert.equal(Number(mutation.mutationRevision),Number(snapshot.expectedMutationRevision)+1);
    assert.equal(await readFile(ownerMarker,'utf8'),'B:only\n');
    assert.throws(()=>cp!.recordOwnerWorkspaceMutation(runId,{
      ...snapshot,fencingToken:fence.lock.fencingToken,sessionToken:fence.lock.sessionToken,
      integrationWorkspaceIdentity:deliveredIdentity,changedPaths:['shared.txt'],patchDigest,
    }),(error:unknown)=>(error as {code?:string})?.code==='delivery_mutation_revision_stale');
    cp.releaseOwnerWorkspaceMutationFence(runId,{
      workspaceId:fence.lock.workspaceId,
      fencingToken:fence.lock.fencingToken,sessionToken:fence.lock.sessionToken,
    });
    assert.equal(cp.getAttemptById(runId,a.attemptId)?.status,'failed');
    assert.equal(cp.getAttemptById(runId,b.attemptId)?.status,'started',
      'Native command success must not create Kernel Report completion');
    const beforeDelivery=await count();await delay(180);
    assert.ok((await count())>beforeDelivery,'A must still be able to write only A after B Owner CAS');
    assert.equal(await readFile(ownerMarker,'utf8'),'B:only\n','A cannot mutate delivered Owner output');
    const finalAState=JSON.parse(await readFile(path.join(aWorkspace.workspaceRoot,'writer-state.json'),'utf8')) as typeof currentState;
    assert.ok(finalAState.deniedB>0 && finalAState.deniedOwner>0 && finalAState.deniedHost>0);
    assert.equal(finalAState.allowedB+finalAState.allowedOwner+finalAState.allowedHost,0);
    assert.equal(await readFile(path.join(bWorkspace.workspaceRoot,'shared.txt'),'utf8'),'B:only\n');
    assert.equal(await readFile(hostMarker,'utf8'),'HOST_ONLY\n');

    // Known bounded test Writer only. Wait until it naturally exits, confirm
    // identity in a fresh native process observation, then delete TEST ONLY.
    await delay(12_400);
    assert.equal(writerRow(writerPid),'','finite test Writer PID should be gone');
    const countSettled=await count();await delay(160);
    assert.equal(countSettled,300);
    assert.equal(await count(),countSettled);
    safeToRemove=true;
    console.log(JSON.stringify({
      test:'T29 actual Canonical Kernel A/B Native sandbox + Owner CAS',
      nativeCommandAExit:startedA.exitCode,nativeCommandBExit:finishedB.exitCode,
      aAttemptId:a.attemptId,bAttemptId:b.attemptId,
      aWorkspaceId:aWorkspace.workspaceId,bWorkspaceId:bWorkspace.workspaceId,
      writerPid,writerAWasAliveDuringBOwnerDelivery:true,
      aAttemptStatus:'failed',bAttemptStatus:'started',ownerContent:'B:only',
      ownerMutationRevision:mutation.mutationRevision,staleDeliveryRejected:true,
      aDeniedB:finalAState.deniedB,aDeniedOwner:finalAState.deniedOwner,
      aDeniedHost:finalAState.deniedHost,bDeniedA:bReport.deniedA,bDeniedHost:bReport.deniedHost,
      aExternalWritesAllowed:0,reportAuthority:'none',
      arbitraryDescendantTerminationVerified:false,
      result:'PASS',
    }));
  } finally {
    for(const server of servers.reverse())await server.close();
    await cp?.close();
    if(safeToRemove){
      for(const worktree of worktrees.reverse()){
        const result=spawnSync('git',['worktree','remove','--force',worktree],{
          cwd:owner,encoding:'utf8',timeout:10_000,
        });
        assert.equal(result.status,0,result.stderr);
      }
      await rm(root,{recursive:true,force:true});
    }else{
      console.warn('T29 isolated native fixture preserved; descendant exit not proven:',root);
    }
  }
});


// T30 reuses the same test-only Native RPC client. The production parallel
// Dispatcher owns real Kernel receipt persistence, trusted integration proof,
// Owner CAS, and post-Delivery Report/Proof settlement. A model Turn is never
// promoted directly to proof authority.
const proofEnabled = process.platform === 'darwin'
  && process.env.W0_NATIVE_PROOF_CONFORMANCE === '1'
  && Boolean(process.env.CODEX_HOME);

for (const invalidIntegration of [false, true]) {
  test(
    invalidIntegration
      ? 'T30 Mac Native parallel Worker fails trusted integration proof before Owner Delivery'
      : 'T30 Mac Native parallel Workers settle canonical Report/Proof after Owner CAS exactly once',
    {
      skip: !proofEnabled && 'requires macOS, isolated CODEX_HOME and W0_NATIVE_PROOF_CONFORMANCE=1',
      timeout: 60_000,
    },
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'w0-native-proof-parallel-'));
      const owner = path.join(root, 'owner');
      const runtimeHome = path.join(root, 'runtime');
      const runId = invalidIntegration ? 'w0-native-proof-rejected' : 'w0-native-proof-accepted';
      let cp: Awaited<ReturnType<typeof createKernelControlPlane>> | null = null;
      const allServers: NativeTestServer[] = [];
      let tested = false;
      try {
        await mkdir(owner);
        git(owner, ['init', '-b', 'main']);
        git(owner, ['config', 'user.name', 'Kernel Native Proof Fixture']);
        git(owner, ['config', 'user.email', 'w0-native-proof@example.invalid']);
        await mkdir(path.join(owner, 'src'), { recursive: true });
        await writeFile(path.join(owner, 'src', 'base.txt'), 'fixture\n');
        await writeFile(path.join(owner, 'verify.cjs'), [
          "const fs=require('node:fs');",
          "const get=(name)=>{try{return fs.readFileSync(name,'utf8')}catch{return null}};",
          "if(get('src/alpha/result.txt')!=='alpha\\n'||get('src/beta/result.txt')!=='beta\\n')process.exit(13);",
        ].join('\n') + '\n');
        await writeFile(path.join(owner, 'package.json'), JSON.stringify({
          name: 'w0-native-proof-parallel',
          scripts: { 'test:ok': 'node verify.cjs' },
        }) + '\n');
        git(owner, ['add', '--all']);
        git(owner, ['commit', '-m', 'native proof baseline']);
        const baseCommit = git(owner, ['rev-parse', 'HEAD']);
        const contract = {
          complex: true,
          riskTier: 'T1',
          acceptance: [
            { id: 'AC-ALPHA', acceptance: 'alpha matches expected', evidencePlan: {
              class: 'hard', method: 'unit-test', commandRefs: ['test:ok'], obligationId: 'alpha-proof',
            } },
            { id: 'AC-BETA', acceptance: 'beta matches expected', evidencePlan: {
              class: 'hard', method: 'unit-test', commandRefs: ['test:ok'], obligationId: 'beta-proof',
            } },
          ],
          requiredObligations: ['alpha-proof', 'beta-proof'],
          requiredVerifications: [
            { obligationId: 'alpha-proof', commandRefs: ['test:ok'] },
            { obligationId: 'beta-proof', commandRefs: ['test:ok'] },
          ],
          steps: [
            { objective: 'materialize alpha', allowedPaths: ['src/alpha/**'],
              acceptanceIds: ['AC-ALPHA'], obligationIds: ['alpha-proof'], dependsOn: [] },
            { objective: 'materialize beta', allowedPaths: ['src/beta/**'],
              acceptanceIds: ['AC-BETA'], obligationIds: ['beta-proof'], dependsOn: [] },
          ],
        };
        cp = await createKernelControlPlane({ runtimeHome, projectRoot: owner });
        await cp.startRun({ runId, objective: 'verify Native proof delivery authority', taskContract: contract });
        assert.equal(cp.getExecutableSteps(runId).mode, 'parallel');

        const launches: Array<{ name: string; workspaceId: string; commandExit: unknown }> = [];
        const result = await dispatchKernelParallel({
          controlPlane: cp, runId,
          adapter: { capabilities: {
            surface: 'codex', supportsConcurrentSessions: true,
            supportsIsolatedWorkingDirectory: true, supportsPerSessionEnvironment: true,
          } },
          projectRoot: owner,
          runtimeHome,
          parentSessionId: 'w0-native-proof-fixture-parent',
          actionContext: { integrationVerification: { commandRef: 'test:ok' } },
          dispatchStep: async ({ step, workspace }) => {
            const name = String(step.objective).endsWith('alpha') ? 'alpha' : 'beta';
            const relativePath = 'src/' + name + '/result.txt';
            const intended = (invalidIntegration && name === 'alpha') ? 'invalid-alpha' : name;
            const server = new NativeTestServer(workspace.workspaceRoot);
            allServers.push(server);
            await server.initialize();
            try {
              const native = await server.exec([
                process.execPath, '-e',
                "const fs=require('node:fs');const p=require('node:path');fs.mkdirSync(p.dirname(process.argv[1]),{recursive:true});fs.writeFileSync(process.argv[1],process.argv[2]+'\\n')",
                relativePath, intended,
              ], workspace.workspaceRoot);
              assert.equal(native.exitCode, 0, 'real native Worker command failed');
              launches.push({ name, workspaceId: String(workspace.workspaceId), commandExit: native.exitCode });
              assert.equal(await readFile(path.join(workspace.workspaceRoot,relativePath),'utf8'),intended+'\n');
              return {
                status: 'passed', resultStatus: 'passed',
                report: {
                  summary: 'Native ' + name + ' command executed',
                  changedPaths: [relativePath],
                  verifications: [
                    { obligationId: name + '-proof', commandRef: 'test:ok',
                      acceptanceCoverage: ['AC-' + name.toUpperCase()] },
                    ...(name === 'beta'
                      ? [{ obligationId: 'unit-test', commandRef: 'test:ok', acceptanceCoverage: [] }]
                      : []),
                  ],
                },
              };
            } finally {
              await server.close();
            }
          },
        });
        assert.equal(launches.length,2,'both Native Codex commands actually executed');
        assert.notEqual(launches[0]?.workspaceId,launches[1]?.workspaceId);
        assert.ok(launches.every(x=>x.commandExit===0));
        const typed = result as Record<string, unknown>;
        const integration = typed.integration as Record<string, unknown>;
        const mutation = (typed.deliveryMutation || null) as Record<string, unknown> | null;
        const currentRun = await cp.getRun(runId);
        assert.ok(currentRun);
        if (invalidIntegration) {
          assert.equal(typed.status,'failed',JSON.stringify(typed).slice(0,2800));
          assert.equal(integration.status,'failed');
          assert.equal(integration.failureCode,'integration_verification_failed');
          assert.equal(mutation,null);
          assert.equal(currentRun.mutationRevision,0);
          assert.equal(await readFile(path.join(owner,'src','base.txt'),'utf8'),'fixture\n');
          await assert.rejects(readFile(path.join(owner,'src','alpha','result.txt')), { code:'ENOENT' });
          await assert.rejects(readFile(path.join(owner,'src','beta','result.txt')), { code:'ENOENT' });
          assert.equal((typed.executionResults as unknown[]).length,0);
          assert.notEqual(typed.status,'passed');
        } else {
          assert.equal(typed.status,'passed',JSON.stringify({
            status:typed.status,
            integration:{status:integration.status,failureCode:integration.failureCode},
            failed:typed.settlementFailures,
            steps:cp.getRunSteps(runId).map(s=>({state:s.state,stepId:s.stepId})),
            proofs:cp.stateStore.getVerifications(runId).map(v=>({obligationId:v.obligationId,status:v.status})),
          },null,2));
          assert.equal(integration.status,'integrated');
          assert.ok(mutation);
          assert.equal(mutation.mutationRevision,1);
          assert.equal(currentRun.mutationRevision,1);
          assert.equal(await readFile(path.join(owner,'src','alpha','result.txt'),'utf8'),'alpha\n');
          assert.equal(await readFile(path.join(owner,'src','beta','result.txt'),'utf8'),'beta\n');
          const workerSettlements = typed.executionResults as Array<{reportResult: {step?:{state?:string};executed?:unknown[]}}>;
          assert.equal(workerSettlements.length,2);
          assert.ok(workerSettlements.every(x=>x.reportResult.step?.state==='passed'),
            'all step reports must pass the real Kernel Report gate');
          assert.ok(cp.getRunSteps(runId).every(x=>x.state==='passed'));
          const attempts = cp.stateStore.getStepAttempts(runId);
          assert.equal(attempts.length,2);
          assert.ok(attempts.every(x=>x.resultCommitSha && x.workerReport && x.patchDigest),
            'canonical Native execution receipts must be durable before Delivery');
          const proofs = cp.stateStore.getVerifications(runId);
          assert.ok(proofs.some(x=>x.status==='passed' && x.obligationId==='alpha-proof'));
          assert.ok(proofs.some(x=>x.status==='passed' && x.obligationId==='beta-proof'));
          assert.ok(proofs.every(x=>x.evidenceRef), 'Kernel must record trusted proof evidence');
          assert.deepEqual(cp.stateStore.getMutationProvenance(runId)?.changedPaths,
            ['src/alpha/result.txt','src/beta/result.txt']);
          const staleSnapshot = {
            ...((mutation.snapshot || {}) as Record<string, unknown>),
            expectedMutationRevision:0,
          };
          assert.equal(staleSnapshot.expectedMutationRevision,0);
          // Already settled parallel attempts cannot be settled a second time.
          const attempt = attempts[0]!;
          const replay = await cp.settleParallelResult(runId, {
            ...(attempt.workerReport as Record<string, unknown>),
            stepId: attempt.stepId, attemptId: attempt.attemptId,
            workspaceId: attempt.workspaceId,
          }, { deliveryMutation: mutation, result: {
            attemptId:attempt.attemptId, executionWorkspaceId:attempt.workspaceId,
            workerWorkspaceIdentity:attempt.baseWorkspaceIdentity,
            resultWorkspaceIdentity:attempt.resultWorkspaceIdentity,
            resultCommitSha:attempt.resultCommitSha, changedPaths:attempt.changedPaths,
            patchDigest:attempt.patchDigest, workerReport:attempt.workerReport,
          } });
          assert.notEqual((replay as {step?:{state?:string}}).step?.state,'passed',
            'duplicate report must not obtain a second Step passed settlement');
          assert.equal((await cp.getRun(runId))?.mutationRevision,1);
        }
        tested=true;
        console.log(JSON.stringify({
          case:invalidIntegration?'T30-native-proof-denied':'T30-native-proof-accepted',
          nativeWorkerCommands:launches.length,
          runId,resultStatus:typed.status,integrationStatus:integration.status,
          nativeWorkspaceIds:launches.map(x=>x.workspaceId),
          ownerMutationRevision:currentRun.mutationRevision,
          workerReportSettlements:(typed.executionResults as unknown[]).length,
          nativeModelCalled:false, result:'PASS',
        }));
      } finally {
        for(const server of allServers.reverse())await server.close();
        await cp?.close();
        if(tested) await rm(root,{recursive:true,force:true});
        else console.warn('T30 isolated native fixture retained after failed assertion:',root);
      }
    },
  );
}
