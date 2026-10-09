const SENSITIVE_KEY = /(?:api.?key|access.?token|refresh.?token|id.?token|secret|password|credential|authorization|private.?key|cookie|session.?token)/i;
const FORBIDDEN_KEY = /^(?:system|developer)_?prompt$|^(?:transcript|messages?|tool.?output|raw.?output)$/i;

export const redactText = (value) => String(value || '')
  .replace(/\b(?:sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{16,}|AKIA[0-9A-Z]{16})\b/g, '[REDACTED]')
  .replace(/((?:api.?key|token|secret|password|credential|authorization)\s*[:=]\s*)([^\s,;]+)/ig, '$1[REDACTED]')
  .replace(/Bearer\s+[A-Za-z0-9._~-]+/ig, 'Bearer [REDACTED]');

export function redactObject(value, { dropForbidden = true } = {}) {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map((item) => redactObject(item, { dropForbidden }));
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, nested] of Object.entries(value)) {
    if (dropForbidden && (FORBIDDEN_KEY.test(key) || SENSITIVE_KEY.test(key))) continue;
    result[key] = redactObject(nested, { dropForbidden });
  }
  return result;
}

export function redactSessionSnapshot(session = {}) {
  const safe = redactObject(session);
  delete safe.transcript;
  delete safe.messages;
  delete safe.toolOutput;
  delete safe.systemPrompt;
  delete safe.developerPrompt;
  return safe;
}
