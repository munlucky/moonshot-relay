// Host prompt envelope (Wave 3). Compiles one turn into ordered segments plus
// the identity a provider cache and a session lineage are keyed on.
//
// Two separations matter here:
//
//   Common vs provider   Claude's policy and Codex's policy live in different
//                        segments, so revising one does not invalidate the
//                        other's warm prefix.
//   Content vs control   runId, stepId, capsuleId and friends identify the turn
//                        but say nothing to the model. They stay in `control`,
//                        outside every cacheable segment; putting them in the
//                        prompt would change the prefix on every single turn.
//
// `resolvedModel` and `resolvedEffort` are the exception: they are excluded from
// the prompt text but included in `cacheIdentity`, because two efforts are two
// different cache lineages even when the bytes match.

import { createHash } from 'node:crypto';
import { canonicalJson } from '../../kernel/canonical-digest.mjs';
import { COMMON_EXECUTION_PROMPT, COMMON_PROMPT_REVISION } from './prompts/common-execution.mjs';
import { CLAUDE_PROVIDER_PROMPT } from './prompts/claude-opus-5.mjs';
import { CODEX_PROVIDER_PROMPT } from './prompts/codex-gpt-5p6.mjs';
import { renderToolManifestSegment } from './tool-manifest.mjs';
import { resolveProviderPromptPolicy } from './provider-prompt-policy.mjs';

export const ENVELOPE_SCHEMA_VERSION = 2;

export const SEGMENT_KINDS = Object.freeze([
  'tool-stable', 'common-host-stable', 'provider-stable', 'project-stable', 'run-stable', 'volatile',
]);

// Excluded from prefixDigest. Each one either changes every turn or identifies
// the run rather than describing the work.
export const PREFIX_EXCLUDED_FIELDS = Object.freeze([
  'runId', 'stepId', 'capsuleId', 'timestamp', 'workspaceIdentity',
  'mutationRevision', 'routeDecisionId', 'admissionId', 'evidence', 'toolResult',
]);

const digest = (text) => `sha256:${createHash('sha256').update(String(text ?? '')).digest('hex')}`;
const estimateTokens = (text) => Math.ceil(String(text ?? '').length / 4);

const PROVIDER_PROMPT = Object.freeze({ claude: CLAUDE_PROVIDER_PROMPT, codex: CODEX_PROVIDER_PROMPT });

const makeSegment = (kind, content, { cacheable, provider = null } = {}) => Object.freeze({
  kind,
  ...(provider ? { provider } : {}),
  content: String(content ?? ''),
  digest: digest(content),
  cacheable,
  tokenEstimate: estimateTokens(content),
});

export const buildPrefixDigest = ({
  provider, surface, role, resolvedModel, resolvedEffort,
  toolSchemaDigest, commonHostStableDigest, providerStableDigest,
  projectStableDigest, runStableDigest,
} = {}) => `sha256:${createHash('sha256').update(canonicalJson({
  provider: provider ?? null,
  surface: surface ?? null,
  role: role ?? null,
  resolvedModel: resolvedModel ?? null,
  resolvedEffort: resolvedEffort ?? null,
  toolSchemaDigest: toolSchemaDigest ?? null,
  commonHostStableDigest: commonHostStableDigest ?? null,
  providerStableDigest: providerStableDigest ?? null,
  projectStableDigest: projectStableDigest ?? null,
  runStableDigest: runStableDigest ?? null,
})).digest('hex')}`;

export const buildPromptEnvelope = ({
  provider = 'generic',
  surface = null,
  role = 'implementer',
  action = 'implement',
  riskTier = 'T1',
  toolManifest = { tools: [], toolSchemaDigest: null },
  contextSegments = {},
  modelPolicy = {},
  capabilities = {},
  control = {},
  env = process.env,
} = {}) => {
  const policy = resolveProviderPromptPolicy({ provider, role, riskTier, action, capabilities, env });

  const segments = [
    makeSegment('tool-stable', renderToolManifestSegment(toolManifest), { cacheable: true }),
    makeSegment('common-host-stable', COMMON_EXECUTION_PROMPT, { cacheable: true }),
    makeSegment('provider-stable', PROVIDER_PROMPT[provider] || '', { cacheable: true, provider }),
    makeSegment('project-stable', contextSegments.projectStable?.content || '', { cacheable: true }),
    makeSegment('run-stable', contextSegments.runStable?.content || '', { cacheable: true }),
    // The tail carries everything that moved this turn; it is never cached.
    makeSegment('volatile', contextSegments.volatile?.content || '', { cacheable: false }),
  ];

  const byKind = Object.fromEntries(segments.map((segment) => [segment.kind, segment]));
  const cacheIdentity = {
    provider,
    surface: surface || provider,
    role,
    resolvedModel: modelPolicy.resolvedModel ?? null,
    resolvedEffort: modelPolicy.resolvedEffort ?? null,
    toolSchemaDigest: toolManifest.toolSchemaDigest ?? null,
    commonHostStableDigest: byKind['common-host-stable'].digest,
    providerStableDigest: byKind['provider-stable'].digest,
    projectStableDigest: byKind['project-stable'].digest,
    runStableDigest: byKind['run-stable'].digest,
  };

  return Object.freeze({
    schemaVersion: ENVELOPE_SCHEMA_VERSION,
    segments: Object.freeze(segments),
    cacheIdentity: Object.freeze({ ...cacheIdentity, prefixDigest: buildPrefixDigest(cacheIdentity) }),
    modelPolicy: Object.freeze({
      executionClass: modelPolicy.executionClass ?? null,
      modelClass: modelPolicy.modelClass ?? null,
      resolvedModel: modelPolicy.resolvedModel ?? null,
      resolvedEffort: modelPolicy.resolvedEffort ?? null,
      speedMode: modelPolicy.speedMode ?? null,
      reasoningContext: policy.reasoningPolicy.persistedReasoning,
      delegationMode: policy.allowNestedDelegation ? 'bounded' : 'none',
    }),
    cachePolicy: policy.cachePolicy,
    commonPromptRevision: COMMON_PROMPT_REVISION,
    providerPromptRevision: policy.providerPromptRevision,
    // Control metadata: identifies the turn for the Kernel, never rendered into
    // a segment.
    control: Object.freeze({
      runId: control.runId ?? null,
      stepId: control.stepId ?? null,
      capsuleId: control.capsuleId ?? null,
      routeDecisionId: control.routeDecisionId ?? null,
      admissionId: control.admissionId ?? null,
      mutationRevision: control.mutationRevision ?? null,
    }),
  });
};

// The cacheable prompt is what a provider would actually receive; the test
// suite asserts no control value ever appears inside it.
export const renderCacheablePrompt = (envelope) =>
  envelope.segments.filter((segment) => segment.cacheable).map((segment) => segment.content).filter(Boolean).join('\n\n');

export const renderFullPrompt = (envelope) =>
  envelope.segments.map((segment) => segment.content).filter(Boolean).join('\n\n');

export const findControlLeaks = (envelope) => {
  const prompt = renderFullPrompt(envelope);
  return Object.entries(envelope.control)
    .filter(([, value]) => value !== null && value !== undefined && String(value).length >= 6 && prompt.includes(String(value)))
    .map(([field]) => field)
    .sort();
};
