// Claude provider stable prompt. Keep provider-specific policy out of the
// common execution prompt so the shared prefix stays byte-stable.
export const CLAUDE_PROMPT_REVISION = 'kernel-claude-opus-5.v1';

export const CLAUDE_PROVIDER_PROMPT = `<claude_runtime>
Keep thinking enabled. Control cost and latency through the resolved effort
rather than instructions that suppress reasoning.

Use native tool calls only. Do not treat tool-like text or internal XML-like
artifacts as executable actions.

Follow the Kernel-provided structured output contract without additional prose.
</claude_runtime>`;

export const THINKING_POLICY = Object.freeze({
  mode: 'enabled',
  costControlledBy: 'effort',
});

export const FORBIDDEN_THINKING_INSTRUCTIONS: readonly RegExp[] = Object.freeze([
  /do not think/i,
  /do not reason/i,
  /answer without reasoning/i,
  /skip (your )?reasoning/i,
  /사고하지\s*(마|말)/,
  /추론하지\s*(마|말)/,
]);

export const findForbiddenThinkingInstructions = (text: unknown): string[] => (
  FORBIDDEN_THINKING_INSTRUCTIONS
    .filter((pattern) => pattern.test(String(text ?? '')))
    .map(String)
);

export interface ClaudeOutputArtifactPattern {
  id: string;
  pattern: RegExp;
}

export const OUTPUT_ARTIFACT_PATTERNS: readonly ClaudeOutputArtifactPattern[] = Object.freeze([
  { id: 'text-tool-call', pattern: /<(?:antml:)?(?:invoke|function_calls|tool_use)\b[\s\S]*?>/gi },
  { id: 'system-xml-tag', pattern: /<\/?(?:system-reminder|thinking|antml:thinking)\b[^>]*>/gi },
  { id: 'reasoning-transcript', pattern: /^\s*(?:Let me think|Thinking:|Reasoning:)[^\n]*$/gim },
]);

export const detectClaudeOutputArtifacts = (text: unknown): string[] => {
  const value = String(text ?? '');
  return OUTPUT_ARTIFACT_PATTERNS
    .filter(({ pattern }) => {
      pattern.lastIndex = 0;
      return pattern.test(value);
    })
    .map(({ id }) => id);
};

export const stripClaudeOutputArtifacts = (text: unknown): string => {
  let value = String(text ?? '');
  for (const { pattern } of OUTPUT_ARTIFACT_PATTERNS) {
    pattern.lastIndex = 0;
    value = value.replace(pattern, '');
  }
  return value.trim();
};

export const canExecuteAsToolCall = (_text?: unknown): false => false;

export const buildClaudeProviderSegment = (): string => CLAUDE_PROVIDER_PROMPT;
