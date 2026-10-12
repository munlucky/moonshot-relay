import assert from 'node:assert/strict'; import {test} from 'node:test'; import {buildEvidencePack} from '../src/kernel/evidence-pack.js';
test('small deterministic work emits E0',()=>assert.equal(buildEvidencePack({objective:'typo',proofTier:'T0',checks:[]}).tier,'E0'));
test('multi-slice or high-risk work emits E2 release evidence',()=>{const p=buildEvidencePack({objective:'migration',proofTier:'T3',sliceCount:2,completionDecision:'blocked'}); assert.equal(p.tier,'E2'); assert.equal(p.releaseEvidence.completionDecision,'blocked');});
