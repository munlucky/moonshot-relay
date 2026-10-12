import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHostExecutionContract } from '../src/contracts/host-execution-contract.js';
import { renderOpenAIResponsesPrompt } from '../src/host/kernel/openai-prompt-renderer.js';
import { buildToolManifest } from '../src/host/kernel/tool-manifest.js';
import { COMMON_EXECUTION_PROMPT } from '../src/host/kernel/prompts/common-execution.js';

const contract = () => buildHostExecutionContract({
  decision: {
    runId: 'run-openai-renderer',
    decisionId: 'route-openai-renderer-0001',
    actionKind: 'implement',
    role: 'implementer',
    permissions: 'workspace_write',
    executionClass: 'standard',
    workProfile: { executionClass: 'standard', parallelizable: false },
  },
  assignment: {
    executionMode: 'owner-direct',
    freshSessionRequired: false,
    delegation: { mode: 'optional', requested: false },
  },
  workUnit: {
    objective: 'Render the bounded work unit.',
    allowedPaths: ['src/host/kernel/**'],
    forbiddenPaths: ['src/kernel/**'],
    expectedOutputs: ['OpenAI Responses prompt'],
  },
});

const tools = () => buildToolManifest([
  { name: 'edit_file', description: 'Edit one file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
  { name: 'read_file', description: 'Read one file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
]);

const context = (knowledge = { recordId: 'K-1', summary: 'Provider rendering stays Host-owned.' }) => ({
  objective: 'Preserve common semantics in an OpenAI representation.',
  acceptance: [{ id: 'AC-1', statement: 'All semantic fields survive serialization.' }],
  constraints: ['Do not create an API client.'],
  currentWork: {
    objective: 'Render the bounded work unit.',
    allowedPaths: ['src/host/kernel/**'],
    forbiddenPaths: ['src/kernel/**'],
    expectedOutputs: ['OpenAI Responses prompt'],
  },
  relevantProjectKnowledge: [knowledge],
  requiredEvidence: [{ obligationId: 'focused-test', evidenceClass: 'hard' }],
});

test('OpenAI Responses serialization is deterministic and keeps high-authority instructions separate', () => {
  const first = renderOpenAIResponsesPrompt({
    hostExecutionContract: contract(),
    modelContext: context({ summary: 'Provider rendering stays Host-owned.', recordId: 'K-1' }),
    toolManifest: tools(),
  });
  const second = renderOpenAIResponsesPrompt({
    hostExecutionContract: contract(),
    modelContext: context({ recordId: 'K-1', summary: 'Provider rendering stays Host-owned.' }),
    toolManifest: tools(),
  });

  assert.equal(first.status, 'supported');
  assert.deepEqual(first, second);
  if (first.status !== 'supported') assert.fail('OpenAI renderer must be supported');
  assert.equal(first.instructions, COMMON_EXECUTION_PROMPT);
  assert.equal(first.input[0].role, 'user');
  assert.equal(first.input[0].content[0].type, 'input_text');
  assert.ok(!first.instructions.includes('Preserve common semantics in an OpenAI representation.'));
});

test('OpenAI Responses serialization renders WHAT BOUNDARY EVIDENCE DONE without semantic loss', () => {
  const rendered = renderOpenAIResponsesPrompt({
    hostExecutionContract: contract(),
    modelContext: context(),
    toolManifest: tools(),
  });
  assert.equal(rendered.status, 'supported');
  if (rendered.status !== 'supported') assert.fail('OpenAI renderer must be supported');

  const text = rendered.input[0].content[0].text;
  const ordered = ['WHAT\n', 'BOUNDARY\n', 'EVIDENCE\n', 'DONE\n'].map((label) => text.indexOf(label));
  assert.ok(ordered.every((index) => index >= 0));
  assert.deepEqual([...ordered].sort((a, b) => a - b), ordered);

  for (const expected of [
    'Preserve common semantics in an OpenAI representation.',
    'All semantic fields survive serialization.',
    'Render the bounded work unit.',
    'src/host/kernel/**',
    'src/kernel/**',
    'Provider rendering stays Host-owned.',
    'focused-test',
    'edit_file',
    'read_file',
    'workspace_write',
    'kernel',
  ]) {
    assert.ok(text.includes(expected), `missing semantic value: ${expected}`);
  }
});

test('Codex and unknown surfaces stay explicitly outside the generic OpenAI renderer', () => {
  for (const provider of ['codex', 'mystery']) {
    assert.deepEqual(
      renderOpenAIResponsesPrompt({
        provider,
        hostExecutionContract: null,
        modelContext: null,
        toolManifest: tools(),
      }),
      {
        status: 'unsupported',
        provider,
        reason: 'provider-unsupported',
        serialization: null,
      },
    );
  }
});
