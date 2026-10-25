// Common stable execution prompt. This string must stay provider- and
// run-independent so providers can reuse the stable prefix.
export const COMMON_PROMPT_REVISION = 'kernel-common-execution.v3';

export const COMMON_EXECUTION_PROMPT = `<kernel_execution>
Execute the current work unit within its declared scope and acceptance.
Use the provided constraints, project context, relevant knowledge, and required evidence.
Make routine decisions autonomously; ask only when acceptance, irreversible behavior, or safety remains materially ambiguous.
Reuse the existing project structure and avoid unrequested abstractions, compatibility paths, or workflow.
Kernel evidence, review receipts, and completion decisions remain authoritative.
</kernel_execution>`;

export const REQUIRED_PROMPT_FIELDS = Object.freeze([
  'goal',
  'context',
  'constraints',
  'doneWhen',
] as const);

export const OPTIONAL_PROMPT_FIELDS = Object.freeze([
  'approvalBoundaries',
  'nonGoals',
  'expectedArtifacts',
] as const);

// One provider-neutral mapping over the four established request fields. This
// is a derived view, not another authority or wire contract.
export const PROMPT_SEMANTIC_FIELD_MAP = Object.freeze({
  objective: 'goal.objective',
  acceptance: 'doneWhen.acceptance',
  currentWorkUnit: 'context.workUnit',
  scope: 'constraints.scope',
  relevantProjectKnowledge: 'context.relevantProjectKnowledge',
  requiredVerification: 'doneWhen.requiredVerification',
  availableTools: 'context.availableTools',
  mutationAuthority: 'constraints.mutationAuthority',
  completionCondition: 'doneWhen.completionCondition',
} as const);

export type PromptSemanticKey = keyof typeof PROMPT_SEMANTIC_FIELD_MAP;
export const PROMPT_SEMANTIC_KEYS = Object.freeze(
  Object.keys(PROMPT_SEMANTIC_FIELD_MAP) as PromptSemanticKey[],
);

const VAGUE_INSTRUCTION_PATTERNS: readonly RegExp[] = Object.freeze([
  /\bdouble[-\s]?check\b/i,
  /\bre-?check before responding\b/i,
  /\breview your own (answer|response|work)\b/i,
  /\balways (plan|verify|delegate)\b/i,
  /\brun the full (suite|test suite) after every change\b/i,
  /잘\s*해줘/,
  /깊게\s*생각해/,
  /꼼꼼히\s*해/,
  /반드시\s*다시\s*확인/,
]);

export const findVagueInstructions = (text: unknown): string[] => (
  VAGUE_INSTRUCTION_PATTERNS
    .filter((pattern) => pattern.test(String(text ?? '')))
    .map(String)
);

export const buildCommonExecutionSegment = (): string => COMMON_EXECUTION_PROMPT;

export const compileCommonExecutionPrompt = ({
  provider = 'generic',
}: {
  provider?: string;
} = {}) => ({
  provider,
  revision: COMMON_PROMPT_REVISION,
  content: COMMON_EXECUTION_PROMPT,
});
