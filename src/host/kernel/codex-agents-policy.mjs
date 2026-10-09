// AGENTS.md policy (Wave 6.4). AGENTS.md is durable repository guidance that
// Codex loads on every session, which makes it a permanent prefix cost. It
// carries the repository's execution contract and nothing else — a model id or
// a reasoning effort written here is both a cache liability and a duplicate of
// the Host's own routing decision, which is the real authority.

export const AGENTS_ALLOWED_SECTIONS = Object.freeze([
  'repository-structure', 'commands', 'engineering-constraints', 'do-not-rules', 'done-and-verification',
]);

// Each rule states why it is forbidden, so a reviewer can tell a policy
// violation from a stylistic preference.
export const AGENTS_FORBIDDEN_CONTENT = Object.freeze([
  { id: 'current-task', pattern: /^\s*##?\s*current task\b/im, reason: 'task state belongs in the task prompt, not durable guidance' },
  { id: 'model-id', pattern: /\bgpt-5\.6(?:-(?:sol|terra|luna))?\b|\bclaude-(?:opus|sonnet|haiku)\b/i, reason: 'model selection is a Host routing decision' },
  { id: 'reasoning-effort', pattern: /\bmodel_reasoning_effort\b|\breasoning[_\s]effort\s*[:=]/i, reason: 'reasoning effort is a Host execution setting' },
  { id: 'fast-mode', pattern: /\bfast[_\s]?mode\b/i, reason: 'fast mode is an execution setting, not repository guidance' },
  { id: 'provider-cache-config', pattern: /\bprompt_cache_(?:key|options)\b|\bcache_control\b/i, reason: 'cache configuration is Host-side' },
]);

export const MAX_AGENTS_MD_BYTES = 8192;

export const auditAgentsMarkdown = (text, { maxBytes = MAX_AGENTS_MD_BYTES } = {}) => {
  const value = String(text ?? '');
  const violations = AGENTS_FORBIDDEN_CONTENT
    .filter(({ pattern }) => pattern.test(value))
    .map(({ id, reason }) => ({ id, reason }));
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes > maxBytes) {
    violations.push({ id: 'oversized', reason: `AGENTS.md is ${bytes} bytes; move detailed procedure into a Skill or a separate document` });
  }
  return Object.freeze({ ok: violations.length === 0, bytes, violations: Object.freeze(violations) });
};

// Directory-local AGENTS.md files override the root for the paths beneath them,
// so the nearest file to the work wins.
export const resolveAgentsPrecedence = (files = [], targetPath = '') => {
  const target = String(targetPath).replaceAll('\\', '/');
  return files
    .map((file) => ({ file, dir: String(file).replaceAll('\\', '/').replace(/\/?AGENTS\.md$/i, '') }))
    .filter(({ dir }) => dir === '' || target.startsWith(dir ? `${dir}/` : ''))
    .sort((a, b) => b.dir.length - a.dir.length)
    .map(({ file }) => file);
};
