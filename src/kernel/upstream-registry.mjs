import { createHash } from 'node:crypto';
export const proposeUpstreamUpdate=({source,currentRef,observedRef,changes=[]})=>{
  const payload={schemaVersion:1,source,currentRef,observedRef,changes,autoApply:false,status:currentRef===observedRef?'up-to-date':'proposal-required'};
  return {...payload,proposalDigest:createHash('sha256').update(JSON.stringify(payload)).digest('hex')};
};
export const assertNoAutoApply=(registry)=>{ if(registry.autoApply!==false) throw new Error('Kernel upstream auto-apply is forbidden'); return true; };
