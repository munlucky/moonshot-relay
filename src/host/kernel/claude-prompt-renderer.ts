// Claude Messages prompt serialization. This pure Host-side renderer keeps
// provider expression separate from the provider-neutral prompt meaning.

import { canonicalJson } from '../../shared/canonical-digest.js';
import { buildCommonPromptRequest } from './prompt-envelope.js';
import { COMMON_EXECUTION_PROMPT } from './prompts/common-execution.js';
import { CLAUDE_PROVIDER_PROMPT } from './prompts/claude-opus-5.js';
import type { ToolManifest } from './tool-manifest.js';

export const CLAUDE_XML_SERIALIZATION = 'claude-xml' as const;
export const CLAUDE_PROMPT_RENDERER_REVISION = 'kernel-claude-xml.v1';

const escapeXmlText = (value: unknown): string => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&apos;');

const xmlJson = (value: unknown): string => escapeXmlText(canonicalJson(value));

export const renderClaudeXmlPrompt = ({
  provider = 'claude',
  hostExecutionContract,
  modelContext,
  toolManifest,
}: {
  provider?: string;
  hostExecutionContract: unknown;
  modelContext: unknown;
  toolManifest: ToolManifest;
}) => {
  if (provider !== 'claude') {
    return Object.freeze({
      status: 'unsupported' as const,
      provider,
      reason: 'provider-unsupported' as const,
      serialization: null,
    });
  }

  const request = buildCommonPromptRequest({
    hostExecutionContract,
    modelContext,
    toolManifest,
  });

  // Long project data comes first inside the user payload. Stable Host/provider
  // instructions remain separate system blocks, preserving instruction priority
  // and the existing tools -> system -> messages cache-prefix boundary.
  const inputText = [
    '<kernel_request>',
    '  <project_context>',
    `    <relevant_project_knowledge>${xmlJson(request.context.relevantProjectKnowledge)}</relevant_project_knowledge>`,
    `    <available_tools>${xmlJson(request.context.availableTools)}</available_tools>`,
    '  </project_context>',
    `  <objective>${escapeXmlText(request.goal.objective)}</objective>`,
    '  <constraints>',
    `    <task_constraints>${xmlJson(request.constraints.task)}</task_constraints>`,
    `    <mutation_authority>${escapeXmlText(request.constraints.mutationAuthority)}</mutation_authority>`,
    '  </constraints>',
    '  <work_unit>',
    `    <objective>${escapeXmlText(request.context.workUnit.objective)}</objective>`,
    `    <allowed_paths>${xmlJson(request.context.workUnit.allowedPaths)}</allowed_paths>`,
    `    <forbidden_paths>${xmlJson(request.context.workUnit.forbiddenPaths)}</forbidden_paths>`,
    `    <expected_outputs>${xmlJson(request.context.workUnit.expectedOutputs)}</expected_outputs>`,
    '  </work_unit>',
    '  <verification>',
    `    <acceptance>${xmlJson(request.doneWhen.acceptance)}</acceptance>`,
    `    <required_verification>${xmlJson(request.doneWhen.requiredVerification)}</required_verification>`,
    `    <completion_condition>${xmlJson(request.doneWhen.completionCondition)}</completion_condition>`,
    '  </verification>',
    '</kernel_request>',
  ].join('\n');

  return Object.freeze({
    status: 'supported' as const,
    provider,
    serialization: CLAUDE_XML_SERIALIZATION,
    revision: CLAUDE_PROMPT_RENDERER_REVISION,
    system: Object.freeze([
      Object.freeze({ type: 'text' as const, text: COMMON_EXECUTION_PROMPT }),
      Object.freeze({ type: 'text' as const, text: CLAUDE_PROVIDER_PROMPT }),
    ]),
    messages: Object.freeze([
      Object.freeze({
        role: 'user' as const,
        content: Object.freeze([
          Object.freeze({ type: 'text' as const, text: inputText }),
        ]),
      }),
    ]),
  });
};
