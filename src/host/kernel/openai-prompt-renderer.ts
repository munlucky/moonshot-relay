// OpenAI Responses prompt serialization. This is a pure Host-side renderer:
// it does not create a client, dispatch work, or change Kernel authority.

import { canonicalJson } from '../../shared/canonical-digest.js';
import { COMMON_EXECUTION_PROMPT } from './prompts/common-execution.js';
import { buildCommonPromptRequest } from './prompt-envelope.js';
import {
  OPENAI_RESPONSES_SERIALIZATION,
  resolveProviderPromptSerialization,
} from './provider-prompt-policy.js';
import type { ToolManifest } from './tool-manifest.js';

export const OPENAI_PROMPT_RENDERER_REVISION = 'kernel-openai-responses.v1';

const section = (name: string, value: unknown): string => (
  `${name}\n${canonicalJson(value)}`
);

export const renderOpenAIResponsesPrompt = ({
  provider = 'openai',
  hostExecutionContract,
  modelContext,
  toolManifest,
}: {
  provider?: string;
  hostExecutionContract: unknown;
  modelContext: unknown;
  toolManifest: ToolManifest;
}) => {
  const serialization = resolveProviderPromptSerialization(provider);
  if (serialization !== OPENAI_RESPONSES_SERIALIZATION) {
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

  const inputText = [
    section('WHAT', {
      objective: request.goal.objective,
      acceptance: request.doneWhen.acceptance,
      currentWorkUnit: request.context.workUnit,
    }),
    section('BOUNDARY', {
      constraints: request.constraints.task,
      scope: request.constraints.scope,
      mutationAuthority: request.constraints.mutationAuthority,
    }),
    section('EVIDENCE', {
      relevantProjectKnowledge: request.context.relevantProjectKnowledge,
      requiredVerification: request.doneWhen.requiredVerification,
      availableTools: request.context.availableTools,
    }),
    section('DONE', {
      completionCondition: request.doneWhen.completionCondition,
    }),
  ].join('\n\n');

  return Object.freeze({
    status: 'supported' as const,
    provider,
    serialization,
    revision: OPENAI_PROMPT_RENDERER_REVISION,
    instructions: COMMON_EXECUTION_PROMPT,
    input: Object.freeze([
      Object.freeze({
        role: 'user' as const,
        content: Object.freeze([
          Object.freeze({
            type: 'input_text' as const,
            text: inputText,
          }),
        ]),
      }),
    ]),
  });
};
