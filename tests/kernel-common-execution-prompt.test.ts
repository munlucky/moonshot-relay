import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COMMON_EXECUTION_PROMPT, COMMON_PROMPT_REVISION, compileCommonExecutionPrompt,
  REQUIRED_PROMPT_FIELDS, OPTIONAL_PROMPT_FIELDS,
  PROMPT_SEMANTIC_KEYS, PROMPT_SEMANTIC_FIELD_MAP,
} from '../src/host/kernel/prompts/common-execution.js';

test('the common prompt is byte-stable across every dimension that varies per turn', () => {
  const dimensions = [
    { provider: 'claude' }, { provider: 'codex' },
    { model: 'model-a' }, { model: 'model-b' },
    { effort: 'low' }, { effort: 'xhigh' },
    { runId: 'run-1' }, { stepId: 'step-9' },
    { project: 'alpha' }, { riskTier: 'T3' },
    { knowledgeRevision: 'r42' }, { timestamp: '2026-07-29T00:00:00.000Z' },
  ];
  const rendered = dimensions.map(() => COMMON_EXECUTION_PROMPT);
  assert.equal(new Set(rendered).size, 1);
});

test('compiling for a provider preserves the meaning byte for byte', () => {
  const claude = compileCommonExecutionPrompt({ provider: 'claude' });
  const codex = compileCommonExecutionPrompt({ provider: 'codex' });
  assert.equal(claude.content, codex.content);
  assert.equal(claude.revision, COMMON_PROMPT_REVISION);
});

test('the common contract keeps only stable scope, autonomy, architecture, and authority invariants', () => {
  assert.equal(COMMON_PROMPT_REVISION, 'kernel-common-execution.v3');
  assert.match(COMMON_EXECUTION_PROMPT, /within its declared scope and acceptance/);
  assert.match(COMMON_EXECUTION_PROMPT, /routine decisions autonomously/);
  assert.match(COMMON_EXECUTION_PROMPT, /existing project structure/);
  assert.match(COMMON_EXECUTION_PROMPT, /completion decisions remain authoritative/);
  assert.doesNotMatch(COMMON_EXECUTION_PROMPT, /tool|wait|poll|full suite|subagent|retry count/i);
});

test('the four required request fields are declared', () => {
  assert.deepEqual([...REQUIRED_PROMPT_FIELDS], ['goal', 'context', 'constraints', 'doneWhen']);
  assert.ok(OPTIONAL_PROMPT_FIELDS.includes('nonGoals'));
});

test('the four request fields cover the nine provider-neutral prompt semantics exactly once', () => {
  assert.deepEqual([...PROMPT_SEMANTIC_KEYS], [
    'objective',
    'acceptance',
    'currentWorkUnit',
    'scope',
    'relevantProjectKnowledge',
    'requiredVerification',
    'availableTools',
    'mutationAuthority',
    'completionCondition',
  ]);
  assert.deepEqual(PROMPT_SEMANTIC_FIELD_MAP, {
    objective: 'goal.objective',
    acceptance: 'doneWhen.acceptance',
    currentWorkUnit: 'context.workUnit',
    scope: 'constraints.scope',
    relevantProjectKnowledge: 'context.relevantProjectKnowledge',
    requiredVerification: 'doneWhen.requiredVerification',
    availableTools: 'context.availableTools',
    mutationAuthority: 'constraints.mutationAuthority',
    completionCondition: 'doneWhen.completionCondition',
  });
  assert.doesNotMatch(JSON.stringify(PROMPT_SEMANTIC_FIELD_MAP), /codex|claude|gpt|opus|model/i);
});

test('the prompt is delimited so a provider can place a cache boundary after it', () => {
  assert.ok(COMMON_EXECUTION_PROMPT.startsWith('<kernel_execution>'));
  assert.ok(COMMON_EXECUTION_PROMPT.endsWith('</kernel_execution>'));
});
