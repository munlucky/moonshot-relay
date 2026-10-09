// Common stable execution prompt (Wave 4). One short contract, defined once,
// shared by every provider. It is deliberately byte-stable: it must not vary
// with provider, model, effort, run, step, project, risk tier, knowledge
// revision, or timestamp, because every varying byte in front of the volatile
// tail is a cache prefix a provider cannot reuse.
//
// Provider-specific execution policy (thinking, effort, reasoning, cache
// breakpoints) lives in the provider profiles, never here.

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

// Every work request states these four. Abstract exhortations ("be thorough",
// "double-check") are replaced by concrete done conditions and allowed scope.
export const REQUIRED_PROMPT_FIELDS = Object.freeze(['goal', 'context', 'constraints', 'doneWhen']);
export const OPTIONAL_PROMPT_FIELDS = Object.freeze(['approvalBoundaries', 'nonGoals', 'expectedArtifacts']);

const VAGUE_INSTRUCTION_PATTERNS = Object.freeze([
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

// Used by the prompt-size tests and by the audit: a stable prompt that has
// picked up one of these has drifted back toward the legacy shape.
export const findVagueInstructions = (text) =>
  VAGUE_INSTRUCTION_PATTERNS.filter((pattern) => pattern.test(String(text ?? ''))).map(String);

export const buildCommonExecutionSegment = () => COMMON_EXECUTION_PROMPT;

// A provider that needs different syntax compiles the same meaning; it does not
// get to add rules. `sections` stays identical across providers so a diff
// between two compiled forms is syntax only.
export const compileCommonExecutionPrompt = ({ provider = 'generic' } = {}) => ({
  provider,
  revision: COMMON_PROMPT_REVISION,
  content: COMMON_EXECUTION_PROMPT,
});
