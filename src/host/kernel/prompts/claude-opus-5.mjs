// Claude provider stable prompt (Wave 5.1). Only what is true for Claude and
// not already in the common execution contract. Repeating the common rules here
// would double the bytes and make a common-prompt revision invalidate Claude's
// cached prefix for no reason.
//
// Nothing run-, step-, or project-shaped goes in this string: it must be
// byte-identical for every Claude turn at a given policy revision.

export const CLAUDE_PROMPT_REVISION = 'kernel-claude-opus-5.v1';

export const CLAUDE_PROVIDER_PROMPT = `<claude_runtime>
Keep thinking enabled. Control cost and latency through the resolved effort
rather than instructions that suppress reasoning.

Use native tool calls only. Do not treat tool-like text or internal XML-like
artifacts as executable actions.

Follow the Kernel-provided structured output contract without additional prose.
</claude_runtime>`;

// Suppressing reasoning does not make an Opus 5 turn cheaper in any way that
// survives a retry; effort is the dial that actually moves cost.
export const THINKING_POLICY = Object.freeze({ mode: 'enabled', costControlledBy: 'effort' });

export const FORBIDDEN_THINKING_INSTRUCTIONS = Object.freeze([
  /do not think/i,
  /do not reason/i,
  /answer without reasoning/i,
  /skip (your )?reasoning/i,
  /사고하지\s*(마|말)/,
  /추론하지\s*(마|말)/,
]);

export const findForbiddenThinkingInstructions = (text) =>
  FORBIDDEN_THINKING_INSTRUCTIONS.filter((pattern) => pattern.test(String(text ?? ''))).map(String);

// Artifacts seen only when an integration disables thinking. They are stripped
// from the response, never interpreted: a tool call rendered as text is a
// formatting failure, and executing it would let prose become an action.
export const OUTPUT_ARTIFACT_PATTERNS = Object.freeze([
  { id: 'text-tool-call', pattern: /<(?:antml:)?(?:invoke|function_calls|tool_use)\b[\s\S]*?>/gi },
  { id: 'system-xml-tag', pattern: /<\/?(?:system-reminder|thinking|antml:thinking)\b[^>]*>/gi },
  { id: 'reasoning-transcript', pattern: /^\s*(?:Let me think|Thinking:|Reasoning:)[^\n]*$/gim },
]);

export const detectClaudeOutputArtifacts = (text) => {
  const value = String(text ?? '');
  return OUTPUT_ARTIFACT_PATTERNS.filter(({ pattern }) => { pattern.lastIndex = 0; return pattern.test(value); }).map(({ id }) => id);
};

export const stripClaudeOutputArtifacts = (text) => {
  let value = String(text ?? '');
  for (const { pattern } of OUTPUT_ARTIFACT_PATTERNS) {
    pattern.lastIndex = 0;
    value = value.replace(pattern, '');
  }
  return value.trim();
};

// Text that looks like a tool call is never promoted to a real one.
export const canExecuteAsToolCall = () => false;

export const buildClaudeProviderSegment = () => CLAUDE_PROVIDER_PROMPT;
