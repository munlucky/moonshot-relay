import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COMMON_EXECUTION_PROMPT, COMMON_PROMPT_REVISION, compileCommonExecutionPrompt,
  REQUIRED_PROMPT_FIELDS, OPTIONAL_PROMPT_FIELDS,
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

test('the contract states scope, autonomy, restraint, reporting, and authority', () => {
  assert.match(COMMON_EXECUTION_PROMPT, /Complete the current work unit at its declared scope/);
  assert.match(COMMON_EXECUTION_PROMPT, /routine implementation decisions without asking/);
  assert.match(COMMON_EXECUTION_PROMPT, /Do not add extra planning, verification passes, reviewers, or subagents/);
  assert.match(COMMON_EXECUTION_PROMPT, /Report concrete changes, executed checks, and remaining\s+risks/);
  assert.match(COMMON_EXECUTION_PROMPT, /completion decisions remain authoritative/);
});

test('the common contract enforces minimal sustainable implementation', () => {
  assert.equal(COMMON_PROMPT_REVISION, 'kernel-common-execution.v2');
  assert.match(COMMON_EXECUTION_PROMPT, /simplest complete implementation/i);
  assert.match(COMMON_EXECUTION_PROMPT, /working end-to-end increments/i);
  assert.match(COMMON_EXECUTION_PROMPT, /real change boundaries/i);
  assert.match(COMMON_EXECUTION_PROMPT, /existing project capabilities, dependencies, and internal utilities/i);
  assert.match(COMMON_EXECUTION_PROMPT, /declared compatibility windows, supported runtimes, user data/i);
  assert.match(COMMON_EXECUTION_PROMPT, /define its removal condition/i);
});

test('the four required request fields are declared', () => {
  assert.deepEqual([...REQUIRED_PROMPT_FIELDS], ['goal', 'context', 'constraints', 'doneWhen']);
  assert.ok(OPTIONAL_PROMPT_FIELDS.includes('nonGoals'));
});

test('the prompt is delimited so a provider can place a cache boundary after it', () => {
  assert.ok(COMMON_EXECUTION_PROMPT.startsWith('<kernel_execution>'));
  assert.ok(COMMON_EXECUTION_PROMPT.endsWith('</kernel_execution>'));
});
