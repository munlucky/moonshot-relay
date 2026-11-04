// Opt-in real macOS Native Host crash test: an app-server RPC remains in
// flight after the Host process is SIGKILLed. The Kernel durable Attempt and
// Host external one-shot Writer reservation must suppress duplicate launch.
// Only test-owned, finite OS processes and Git Worktrees are ever retired.
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import { createKernelControlPlane } from '../src/host/kernel/control-plane-runtime.js';
import { prepareHostWriterAttemptWorktree } from '../src/host/kernel/workspace/physical-worktree.js';
import { reserveHostWorkspaceWriter } from '../src/host/kernel/workspace-writer-reservation.js';
import { runHostOwnedWritableAttempt } from '../src/host/kernel/host-owned-writable-attempt.js';
import { runNativeHostCommand } from './helpers/native-host-disconnect-runner.js';

const enabled = process.platform === 'darwin'
  && process.env.W0_NATIVE_HOST_DISCONNECT_CONFORMANCE === '1'
  && Boolean(process.env.CODEX_HOME);
const git = (cwd: string, args: string[]): string => {
  const res = spawnSync('git', args, { cwd, encoding:'utf8', timeout:10_000 });
  assert.equal(res.status,0,String(res.stderr || res.error || 'git failed'));
  return res.stdout.trim();
};
const processRow = (pid: number): string => {
  const res=spawnSync('/bin/ps',['-o','pid=,ppid=,pgid=,stat=,command=','-p',String(pid)],{
    encoding:'utf8',timeout:4000,
  });
  return res.status===0?res.stdout.trim():'';
};
const waitUntil = async (check:()=>Promise<boolean>, label:string, timeoutMs=16_000) => {
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){
    if(await check())return;
    await delay(75);
  }
  throw new Error('native_test_wait_timeout:'+label);
};
const countLines = async (filename:string):Promise<number> => {
  try {
    const s=(await readFile(filename,'utf8')).trim();
    return s?s.split('\n').length:0;
  }catch(error){
    if((error as NodeJS.ErrnoException).code==='ENOENT')return 0;
    throw error;
  }
};

test('T31 actual Native Host death keeps canonical Attempt/reservation, denies duplicate spawn and permits isolated successor', {
  skip: !enabled && 'requires macOS, isolated CODEX_HOME and W0_NATIVE_HOST_DISCONNECT_CONFORMANCE=1',
  timeout: 70_000,
},async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'w0-native-host-recovery-'));
  const owner=path.join(root,'owner');
  const runtimeHome=path.join(root,'runtime');
  const reservationRoot=path.join(root,'host-only-reservations');
  const runId='w0-host-crash-native';
  let cp:Awaited<ReturnType<typeof createKernelControlPlane>>|null=null;
  let host:ChildProcessWithoutNullStreams|null=null;
  let serverPid:number|null=null;
  let writerPid:number|null=null;
  let launcherPid:number|null=null;
  const testWorktrees:string[]=[];
  let safeToRemove=false;
  try{
    await mkdir(owner);await mkdir(reservationRoot);
    git(owner,['init','-b','main']);
    git(owner,['config','user.name','W0 Native Host Recovery Fixture']);
    git(owner,['config','user.email','w0-host-recovery@example.invalid']);
    await writeFile(path.join(owner,'shared.txt'),'OWNER_BASE\n');
    git(owner,['add','--all']);git(owner,['commit','-m','native Host recovery base']);
    const baseCommit=git(owner,['rev-parse','HEAD']);

    cp=await createKernelControlPlane({runtimeHome,projectRoot:owner});
    await cp.startRun({runId,objective:'requery canonical Attempt after real Native Host disconnect'});
    const run=await cp.getRun(runId);
    const a=cp.beginAttempt(runId);
    assert.ok(run?.projectId && a?.attemptId && a?.stepId);
    const register=async(attempt:typeof a)=>{
      assert.ok(attempt?.attemptId);
      const workspace=await prepareHostWriterAttemptWorktree({
        repoRoot:owner,runtimeHome,baseCommit,
        projectId:run.projectId || undefined,runId,stepId:attempt.stepId,attemptId:attempt.attemptId,
      });
      testWorktrees.push(workspace.workspaceRoot);
      const registration=cp!.registerExecutionWorkspace(runId,workspace.workspaceRoot);
      const updated=await cp!.updateStepAttempt(String(attempt.id),{
        workspaceId:registration.workspaceId,
        baseWorkspaceIdentity:workspace.baseWorkspaceIdentity,
      });
      assert.equal(updated?.workspaceId,registration.workspaceId);
      assert.equal(cp!.getAttemptById(runId,attempt.attemptId)?.workspaceId,registration.workspaceId);
      return {...workspace,workspaceId:registration.workspaceId};
    };
    const aWorkspace=await register(a);
    const script=path.join(aWorkspace.workspaceRoot,'write-detached.cjs');
    await writeFile(script,[
      "const fs=require('node:fs');const path=require('node:path');",
      "const base=__dirname;fs.writeFileSync(path.join(base,'writer.pid'),String(process.pid));",
      "let n=0;const timer=setInterval(()=>{",
      " const fd=fs.openSync(path.join(base,'heartbeat.log'),'a');",
      " try{fs.writeSync(fd,String(++n)+'\\n');fs.fsyncSync(fd)}finally{fs.closeSync(fd)}",
      " if(n>=240){clearInterval(timer);process.exit(0)}",
      "},75);",
    ].join('\n')+'\n');
    const launcher=path.join(aWorkspace.workspaceRoot,'launch-detached.cjs');
    await writeFile(launcher,[
      "const fs=require('node:fs');const {spawn}=require('node:child_process');",
      "const path=require('node:path');",
      "fs.appendFileSync(path.join(__dirname,'launch-count.log'),'1\\n');",
      "fs.writeFileSync(path.join(__dirname,'launcher.pid'),String(process.pid));",
      "const child=spawn(process.execPath,[path.join(__dirname,'write-detached.cjs')],",
      " {detached:true,stdio:'ignore'});child.unref();",
      "setTimeout(()=>process.exit(0),22000);",
    ].join('\n')+'\n');
    await cp.close();cp=null;

    // Separate OS Host process. Its production reservation is made BEFORE
    // command/exec. Killing this process removes its in-memory RPC outcome.
    const runnerUrl=new URL('./helpers/native-host-disconnect-runner.mjs',import.meta.url).href;
    const hostInput={
      runId,attemptId:a.attemptId,workspaceId:aWorkspace.workspaceId,
      workspaceRoot:aWorkspace.workspaceRoot,reservationRoot,
      executable:process.env.W0_CODEX_EXECUTABLE||'codex',
      argv:[process.execPath,launcher],timeoutMs:35_000,
    };
    host=spawn(process.execPath,['--input-type=module','-e',
      "import(process.env.W0_HOST_RUNNER_URL).then(m=>m.runNativeHostCommand(JSON.parse(process.env.W0_HOST_RUNNER_INPUT)))"],{
      cwd:owner,
      env:{...process.env,W0_HOST_RUNNER_URL:runnerUrl,W0_HOST_RUNNER_INPUT:JSON.stringify(hostInput)},
      stdio:['pipe','pipe','pipe'],shell:false,
    });
    host.stdout.resume();host.stderr.resume();
    assert.ok(host.pid);
    const heartbeat=path.join(aWorkspace.workspaceRoot,'heartbeat.log');
    const serverPidFile=path.join(reservationRoot,'test-server-'+a.attemptId+'.pid');
    await waitUntil(async()=>Boolean((await countLines(heartbeat))>=2
      && (await countLines(path.join(aWorkspace.workspaceRoot,'launch-count.log')))===1
      && (await readdir(reservationRoot)).some(x=>x.startsWith('writer-'))),
      'live_native_command_and_durable_reservation');
    serverPid=Number((await readFile(serverPidFile,'utf8')).trim());
    writerPid=Number((await readFile(path.join(aWorkspace.workspaceRoot,'writer.pid'),'utf8')).trim());
    launcherPid=Number((await readFile(path.join(aWorkspace.workspaceRoot,'launcher.pid'),'utf8')).trim());
    assert.ok(serverPid && writerPid && launcherPid);
    assert.ok(processRow(host.pid) && processRow(writerPid) && processRow(launcherPid));
    assert.equal(host.exitCode,null,'Host must die while command/exec still pending');
    const beforeCrash=await countLines(heartbeat);
    assert.equal(host.kill('SIGKILL'),true);
    await once(host,'exit');
    host=null;
    const afterHostCrash=await countLines(heartbeat);
    await delay(250);
    assert.ok((await countLines(heartbeat))>afterHostCrash,
      'physical Writer must keep writing after the Host is killed');

    // Terminate only the known test App Server PID. This is not a proof that
    // its independent command/exec descendants have stopped.
    const appRow=processRow(serverPid);
    if(appRow){
      assert.match(appRow,/app-server/u);
      process.kill(serverPid,'SIGTERM');
      await waitUntil(async()=>!processRow(serverPid!), 'test_app_server_exit', 5000);
    }
    const afterServerDeath=await countLines(heartbeat);
    await delay(220);
    assert.ok((await countLines(heartbeat))>afterServerDeath,
      'Native Writer must survive the App Server connection loss too');

    // A fresh Kernel instance is the recovery authority, never the lost
    // in-memory RPC handle or a new model Turn.
    cp=await createKernelControlPlane({runtimeHome,projectRoot:owner});
    const recoveredRun=await cp.getRun(runId);
    const recoveredA=cp.getAttemptById(runId,a.attemptId);
    assert.equal(recoveredRun?.mutationRevision,0);
    assert.equal(recoveredA?.status,'started');
    assert.equal(recoveredA?.workspaceId,aWorkspace.workspaceId);
    assert.equal(recoveredA?.baseWorkspaceIdentity,aWorkspace.baseWorkspaceIdentity);
    const markers=(await readdir(reservationRoot)).filter(x=>x.startsWith('writer-'));
    assert.equal(markers.length,1);
    const marker=JSON.parse(await readFile(path.join(reservationRoot,markers[0]!),'utf8')) as {
      runId:string;attemptId:string;workspaceId:string;reservationId:string;
    };
    assert.equal(marker.runId,runId);
    assert.equal(marker.attemptId,a.attemptId);
    assert.equal(marker.workspaceId,aWorkspace.workspaceId);
    assert.ok(marker.reservationId);

    await assert.rejects(reserveHostWorkspaceWriter({
      workspaceRoot:aWorkspace.workspaceRoot,reservationRoot,runId,
      attemptId:a.attemptId,workspaceId:aWorkspace.workspaceId,
    }),{code:'host_writer_workspace_already_reserved'});
    // A new Host must never send a second model Turn even when it sees only
    // a live/stale Attempt; use a test executable sentinel for any accidental
    // provider spawn. Existing Worktree admission also fails if still dirty.
    const fakeExecutable=path.join(root,'never-start-codex.sh');
    const respawnMarker=path.join(root,'unwanted-respawn.txt');
    await writeFile(fakeExecutable,'#!/bin/sh\nprintf spawned > "'+respawnMarker+'"\nexit 17\n');
    await chmod(fakeExecutable,0o700);
    await assert.rejects(runHostOwnedWritableAttempt({
      controlPlane:cp,repoRoot:owner,runtimeHome,reservationRoot,baseCommit,
      runId,stepId:a.stepId,attemptId:a.attemptId,
      prompt:'must not reexecute unknown Native command',
      model:'test-only',effort:'low',
      transportOptions:{executable:fakeExecutable},
    }));
    await assert.rejects(readFile(respawnMarker,'utf8'),{code:'ENOENT'});
    assert.equal(await countLines(path.join(aWorkspace.workspaceRoot,'launch-count.log')),1);
    assert.equal((await readdir(reservationRoot)).filter(x=>x.startsWith('writer-')).length,1);

    // The kernel can create a distinct successor; only this other physical
    // Workspace may obtain a NEW Host reservation.
    cp.failStepAttempt(runId,a.stepId,{code:'host_native_command_outcome_unknown'});
    assert.equal(cp.getAttemptById(runId,a.attemptId)?.status,'failed');
    const b=cp.beginAttempt(runId,{stepId:a.stepId,retryReason:'host_native_command_outcome_unknown'});
    assert.ok(b?.attemptId && b.attemptId!==a.attemptId);
    const bWorkspace=await register(b);
    assert.notEqual(bWorkspace.workspaceId,aWorkspace.workspaceId);
    assert.notEqual(bWorkspace.workspaceRoot,aWorkspace.workspaceRoot);
    assert.ok(processRow(writerPid),'old A physical Writer must still be alive at successor admission');
    const bResult=await runNativeHostCommand({
      runId,attemptId:b.attemptId,workspaceId:bWorkspace.workspaceId,
      workspaceRoot:bWorkspace.workspaceRoot,reservationRoot,
      executable:process.env.W0_CODEX_EXECUTABLE||'codex',
      argv:[process.execPath,'-e',
        "require('node:fs').writeFileSync('successor.txt','B_ONLY\\n')"],
      timeoutMs:13_000,
    });
    assert.equal(bResult.exitCode,0);
    assert.equal(await readFile(path.join(bWorkspace.workspaceRoot,'successor.txt'),'utf8'),'B_ONLY\n');
    assert.equal(await readFile(path.join(owner,'shared.txt'),'utf8'),'OWNER_BASE\n');
    assert.ok(processRow(writerPid),'A Writer should remain alive while isolated B succeeds');
    assert.equal((await readdir(reservationRoot)).filter(x=>x.startsWith('writer-')).length,2);
    assert.equal((await cp.getRun(runId))?.mutationRevision,0,'no Provider outcome becomes Owner CAS/Report');
    assert.equal(cp.getAttemptById(runId,b.attemptId)?.status,'started');

    // Only this intentionally bounded test Writer is retired. All real W0
    // evidence/unknown ownership elsewhere is untouched.
    await waitUntil(async()=>!processRow(writerPid!), 'bounded_writer_A_exited', 35_000);
    await waitUntil(async()=>!processRow(launcherPid!), 'bounded_launcher_A_exited', 35_000);
    const settled=await countLines(heartbeat);
    await delay(280);
    assert.equal(settled,240);
    assert.equal(await countLines(heartbeat),settled);
    assert.equal(await countLines(path.join(aWorkspace.workspaceRoot,'launch-count.log')),1);
    safeToRemove=true;
    console.log(JSON.stringify({
      case:'T31 Native in-flight Host SIGKILL and canonical Attempt recovery',
      hostKilledWhileCommandPending:true,
      appServerExited:true,
      detachedWriterSurvivedHostAndAppServer:true,
      originalAttemptId:a.attemptId,successorAttemptId:b.attemptId,
      originalWorkspaceId:aWorkspace.workspaceId,successorWorkspaceId:bWorkspace.workspaceId,
      sameWorkspaceReservationRejected:true,providerRespawnCount:0,
      originalNativeLauncherCount:1,successorNativeExit:bResult.exitCode,
      successorWorkspaceOnly:true,ownerRevision:0,reportAuthority:'none',
      writerExitVerifiedForArbitraryNativeCommand:false,
      testBoundedWriterSettledLines:settled,result:'PASS',
    }));
  }finally{
    if(host && host.exitCode===null){
      host.kill('SIGKILL');
      await Promise.race([once(host,'exit'),delay(1700)]);
    }
    if(serverPid && processRow(serverPid)){
      const row=processRow(serverPid);
      if(/app-server/u.test(row))process.kill(serverPid,'SIGTERM');
    }
    await cp?.close();
    if(safeToRemove){
      for(const wt of testWorktrees.reverse()){
        const r=spawnSync('git',['worktree','remove','--force',wt],{
          cwd:owner,encoding:'utf8',timeout:10_000,
        });
        assert.equal(r.status,0,r.stderr);
      }
      await rm(root,{recursive:true,force:true});
    }else console.warn('T31 Native test fixture retained: unknown writer lifetime',root);
  }
});
