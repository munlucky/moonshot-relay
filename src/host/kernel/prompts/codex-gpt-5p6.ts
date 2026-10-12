// Codex provider stable prompt. Keep this provider-specific and byte-stable.
export const CODEX_PROMPT_REVISION = 'kernel-codex-gpt-5p6.v1';

export const CODEX_PROVIDER_PROMPT = `<codex_runtime>
Use the configured model, reasoning effort, sandbox, and approval policy as the
execution authority. Do not restate or override them in the prompt.

Keep AGENTS.md for durable repository guidance. Use task prompts for the current
goal, context, constraints, and done conditions.

Preserve the current implementer session for the same work unit. Use a fresh
session for independent review or a changed model-policy lineage.
</codex_runtime>`;

export const buildCodexProviderSegment = (): string => CODEX_PROVIDER_PROMPT;
