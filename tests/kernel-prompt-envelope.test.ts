import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCommonPromptRequest,
  buildPromptEnvelope,
  renderCacheablePrompt,
  renderFullPrompt,
  measurePromptEnvelope,
  findControlLeaks,
  SEGMENT_KINDS,
} from '../src/host/kernel/prompt-envelope.js';
import { buildToolManifest } from '../src/host/kernel/tool-manifest.js';
import { buildKernelContextSegments } from '../src/host/kernel/context-segments.js';
import { buildHostExecutionContract } from '../src/contracts/host-execution-contract.js';

const manifest = () => buildToolManifest([
  { name: 'read_file', description: 'Read a file', inputSchema: { type: 'object' } },
  { name: 'edit_file', description: 'Edit a file', inputSchema: { type: 'object' } },
]);

const context = () => buildKernelContextSegments({
  projectStable: { policyAnchors: [{ id: 'pa1', type: 'policy_anchor', revision: 'r1', statement: 'Core stays provider-neutral.' }] },
  runStable: { objective: 'Stabilize the prefix.', acceptance: ['Deterministic segments.'] },
  volatile: { step: { stepId: 'step-1', objective: 'Add segments.' } },
}).segments;

const build = (overrides = {}) => buildPromptEnvelope({
  provider: 'claude',
  surface: 'claude',
  role: 'implementer',
  toolManifest: manifest(),
  contextSegments: context(),
  modelPolicy: { modelClass: 'value_coding', resolvedModel: 'model-a', resolvedEffort: 'high' },
  capabilities: { supportsPromptCache: true, supportsExplicitCacheBreakpoints: true },
  control: { runId: 'run-alpha-01', stepId: 'step-alpha-01', capsuleId: 'capsule-alpha-01', routeDecisionId: 'route-abc12345', admissionId: 'adm-alpha-01', mutationRevision: 7 },
  ...overrides,
});

const semanticContract = () => buildHostExecutionContract({
  decision: {
    runId: 'run-semantic-prompt',
    decisionId: 'route-semantic-prompt-0001',
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
    objective: 'Add the bounded prompt mapping.',
    allowedPaths: ['src/host/kernel/**'],
    forbiddenPaths: ['src/kernel/**'],
    expectedOutputs: ['provider-neutral semantic request'],
  },
});

const semanticContext = () => ({
  objective: 'Preserve one prompt meaning across provider renderers.',
  acceptance: [
    { id: 'AC-1', statement: 'All nine semantic fields are preserved.' },
  ],
  constraints: ['Do not add provider-specific model names.'],
  currentWork: {
    objective: 'Add the bounded prompt mapping.',
    allowedPaths: ['src/host/kernel/**'],
    forbiddenPaths: ['src/kernel/**'],
    expectedOutputs: ['provider-neutral semantic request'],
  },
  relevantProjectKnowledge: [
    { recordId: 'knowledge-1', summary: 'Host owns provider expression.' },
  ],
  requiredEvidence: [
    { obligationId: 'unit-test', evidenceClass: 'hard' },
  ],
});

test('an envelope emits every segment kind in cache order', () => {
  const envelope = build();
  assert.equal(envelope.schemaVersion, 2);
  assert.deepEqual(envelope.segments.map((s) => s.kind), SEGMENT_KINDS);
  assert.deepEqual(envelope.segments.map((s) => s.cacheable), [true, true, true, true, true, false]);
});

test('prompt measurement records rendered bytes, token estimates, load state, and provider-message inclusion', () => {
  const envelope = build();
  const providerMessage = `provider-prefix\n${envelope.segments[1]?.content || ''}\nprovider-tail`;
  const measurement = measurePromptEnvelope(envelope, { providerMessage });

  assert.equal(measurement.segments.length, SEGMENT_KINDS.length);
  for (const [index, segment] of envelope.segments.entries()) {
    const observed = measurement.segments[index];
    assert.ok(observed);
    assert.equal(observed.kind, segment.kind);
    assert.equal(observed.digest, segment.digest);
    assert.equal(observed.cacheable, segment.cacheable);
    assert.equal(observed.renderedBytes, Buffer.byteLength(segment.content, 'utf8'));
    assert.equal(observed.tokenEstimate, segment.tokenEstimate);
    assert.equal(observed.loaded, segment.content.length > 0);
  }
  assert.equal(measurement.segments[1]?.includedVerbatimInProviderMessage, true);
  assert.equal(measurement.segments[0]?.includedVerbatimInProviderMessage, false);
  assert.equal(measurement.renderedPromptBytes, Buffer.byteLength(renderFullPrompt(envelope), 'utf8'));
  assert.equal(measurement.cacheablePromptBytes, Buffer.byteLength(renderCacheablePrompt(envelope), 'utf8'));
  assert.equal(measurement.providerMessageBytes, Buffer.byteLength(providerMessage, 'utf8'));
  assert.ok(measurement.providerMessageTokenEstimate && measurement.providerMessageTokenEstimate > 0);
});

test('the common request maps all nine meanings from existing Host and model context fields', () => {
  const request = buildCommonPromptRequest({
    hostExecutionContract: semanticContract(),
    modelContext: semanticContext(),
    toolManifest: manifest(),
  });

  assert.deepEqual(request.goal, {
    objective: 'Preserve one prompt meaning across provider renderers.',
  });
  assert.deepEqual(request.context.workUnit, {
    objective: 'Add the bounded prompt mapping.',
    allowedPaths: ['src/host/kernel/**'],
    forbiddenPaths: ['src/kernel/**'],
    expectedOutputs: ['provider-neutral semantic request'],
  });
  assert.deepEqual(request.constraints, {
    task: ['Do not add provider-specific model names.'],
    scope: {
      allowedPaths: ['src/host/kernel/**'],
      forbiddenPaths: ['src/kernel/**'],
    },
    mutationAuthority: 'workspace_write',
  });
  assert.equal(request.context.availableTools.length, 2);
  assert.deepEqual(
    request.context.availableTools.map((tool) => tool.name),
    ['edit_file', 'read_file'],
  );
  assert.deepEqual(request.context.relevantProjectKnowledge, [
    { recordId: 'knowledge-1', summary: 'Host owns provider expression.' },
  ]);
  assert.deepEqual(request.doneWhen.acceptance, [
    { id: 'AC-1', statement: 'All nine semantic fields are preserved.' },
  ]);
  assert.deepEqual(request.doneWhen.requiredVerification, [
    { obligationId: 'unit-test', evidenceClass: 'hard' },
  ]);
  assert.deepEqual(request.doneWhen.completionCondition, {
    authority: 'kernel',
    acceptanceRequired: true,
    verificationRequired: true,
  });
  assert.doesNotMatch(JSON.stringify(request), /claude|codex|gpt-|opus|resolvedModel|reasoningEffort/i);
});

test('the common request fails closed on missing or wrongly typed semantic fields', () => {
  assert.throws(
    () => buildCommonPromptRequest({
      hostExecutionContract: semanticContract(),
      modelContext: { ...semanticContext(), acceptance: 'AC-1' },
      toolManifest: manifest(),
    }),
    /prompt_semantic_field_invalid:doneWhen\.acceptance/,
  );
  const withoutKnowledge = { ...semanticContext() };
  delete (withoutKnowledge as Partial<ReturnType<typeof semanticContext>>).relevantProjectKnowledge;
  assert.throws(
    () => buildCommonPromptRequest({
      hostExecutionContract: semanticContract(),
      modelContext: withoutKnowledge,
      toolManifest: manifest(),
    }),
    /prompt_semantic_field_missing:context\.relevantProjectKnowledge/,
  );
});

test('the common request rejects split-brain work-unit scope instead of choosing one source', () => {
  assert.throws(
    () => buildCommonPromptRequest({
      hostExecutionContract: semanticContract(),
      modelContext: {
        ...semanticContext(),
        currentWork: {
          ...semanticContext().currentWork,
          allowedPaths: ['src/kernel/**'],
        },
      },
      toolManifest: manifest(),
    }),
    /prompt_semantic_field_source_mismatch:context\.currentWorkUnit\.allowedPaths/,
  );
});

test('control metadata never reaches the prompt', () => {
  const envelope = build();
  assert.deepEqual(findControlLeaks(envelope), []);
  const prompt = renderFullPrompt(envelope);
  for (const value of ['run-alpha-01', 'step-alpha-01', 'capsule-alpha-01', 'route-abc12345', 'adm-alpha-01']) {
    assert.ok(!prompt.includes(value), `control value leaked into the prompt: ${value}`);
  }
  assert.equal(envelope.control.runId, 'run-alpha-01');
});

test('the resolved model and effort are cache identity but not prompt content', () => {
  const envelope = build();
  const prompt = renderFullPrompt(envelope);
  assert.ok(!prompt.includes('model-a'));
  assert.ok(!/\bhigh\b/.test(prompt.split('Run Stable')[0] ?? ''));
  assert.equal(envelope.cacheIdentity.resolvedModel, 'model-a');
  assert.equal(envelope.cacheIdentity.resolvedEffort, 'high');
});

test('the cacheable prompt excludes the volatile tail', () => {
  const envelope = build();
  const cacheable = renderCacheablePrompt(envelope);
  assert.ok(!cacheable.includes('step-1'));
  assert.ok(renderFullPrompt(envelope).includes('step-1'));
});

test('a capability the Host did not declare yields no explicit cache mode', () => {
  const envelope = build({ capabilities: {} });
  assert.equal(envelope.cachePolicy.providerMode, 'none');
  assert.equal(envelope.cachePolicy.unsupportedReason, 'provider-unsupported');
});

test('a Host with implicit-only caching does not get explicit breakpoints', () => {
  const envelope = build({ capabilities: { supportsPromptCache: true } });
  assert.equal(envelope.cachePolicy.providerMode, 'implicit');
});
