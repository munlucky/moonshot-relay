import path from 'node:path';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
export const KERNEL_PROFILE_RUNTIMES = ['claude', 'codex', 'qwen', 'ade', 'antigravity'];
export const buildKernelProfile=async({sourceRoot=process.cwd(),runtime,targetRoot})=>{
  if(!KERNEL_PROFILE_RUNTIMES.includes(runtime)) throw new Error(`Unsupported Kernel profile runtime: ${runtime}`);
  const source=path.join(sourceRoot,'package','kernel','profiles',runtime);
  await mkdir(targetRoot,{recursive:true}); await cp(source,targetRoot,{recursive:true,force:true});
  const marker={schemaVersion:1,productId:'moon-relay-kernel',track:'kernel',runtime};
  await writeFile(path.join(targetRoot,'.moon-relay-kernel-profile.json'),JSON.stringify(marker,null,2));
  return marker;
};
export const inspectKernelProfile=async(targetRoot)=>JSON.parse(await readFile(path.join(targetRoot,'.moon-relay-kernel-profile.json'),'utf8'));
