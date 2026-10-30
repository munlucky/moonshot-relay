// W0 diagnostic, isolated in a temporary Git repository. Not a production execution gate.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runGit} from '../../../../../scripts/lib/git-safe.js';
import {deliveryApplyTimeoutMs} from '../../../../../scripts/host/kernel/parallel-dispatcher.js';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'w0-lease-deadline-'));
const N=3000;
try {
 const g=args=>{const r=spawnSync('git',args,{cwd:dir,encoding:'utf8',timeout:6000});assert.equal(r.status,0,String(r.stderr));};
 g(['init','-b','main']);g(['config','user.name','W0']);g(['config','user.email','w0@example.invalid']);
 await fs.writeFile(path.join(dir,'base.txt'),'base\n');g(['add','--all']);g(['commit','-m','fixture']);
 const patch=Array.from({length:N},(_,i)=>{const f=`src/files/${String(i).padStart(6,'0')}.txt`;return `diff --git a/${f} b/${f}\nnew file mode 100644\n--- /dev/null\n+++ b/${f}\n@@ -0,0 +1 @@\n+file-${i}\n`;}).join('');
 const check=runGit(dir,['apply','--check','--binary','-'],{input:patch,maxBuffer:64*1024*1024});assert.equal(check.status,0,String(check.stderr));
 const deadline=new Date(Date.now()+1250).toISOString();
 const budget=deliveryApplyTimeoutMs({expiresAt:deadline});
 assert.ok(budget>0 && budget<1000,`unexpected derived budget ${budget}`);
 const applied=runGit(dir,['apply','--binary','-'],{input:patch,maxBuffer:64*1024*1024,timeout:budget,killSignal:'SIGTERM'});
 const earlyFiles=await fs.readdir(path.join(dir,'src/files')).catch(()=>[]);
 const early=earlyFiles.length;
 await new Promise(resolve=>setTimeout(resolve,1400));
 const lateFiles=await fs.readdir(path.join(dir,'src/files')).catch(()=>[]);
 const late=lateFiles.length;
 const result={budgetMs:budget,errorCode:applied.error?.code||null,status:applied.status,signal:applied.signal,filesAtTimeout:early,filesAfterFence:late,expected:N};
 console.log('W0_LEASE_DEADLINE',JSON.stringify(result));
 assert.equal(applied.error?.code,'ETIMEDOUT');
 assert.ok(early>0 && early<N,`need partial actual writes, got ${early}`);
 assert.deepEqual(lateFiles,earlyFiles,'file list changed after git apply timeout');
 console.log('W0_LEASE_DEADLINE_PASS');
}finally{await fs.rm(dir,{recursive:true,force:true});}
