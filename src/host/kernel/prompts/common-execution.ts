// Common stable execution prompt. This string must stay provider- and
// run-independent so providers can reuse the stable prefix.
export const COMMON_PROMPT_REVISION = 'kernel-common-execution.v2';

export const COMMON_EXECUTION_PROMPT = `<kernel_execution>
Complete the current work unit at its declared scope.
Use goal, context, constraints, and acceptance criteria.
Make routine implementation decisions without asking. Ask only when material
ambiguity affects acceptance, irreversible behavior, or safety.
Prefer the simplest complete implementation; avoid speculative abstractions,
config, and indirection.
Build working end-to-end increments; separate only at real change boundaries, not
for reuse.
Reuse existing project capabilities, dependencies, and internal utilities; check
APIs, docs, types, and usage first.
Preserve declared compatibility windows, supported runtimes, user data, and
required migrations; remove obsolete paths through explicit replacement or
migration path.
Make durable contract, data, and module decisions; isolate emergency workarounds
and define its removal condition.
Do not add extra planning, verification passes, reviewers, or subagents unless
the Kernel action or execution contract requires them.
Report concrete changes, executed checks, and remaining risks.
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
