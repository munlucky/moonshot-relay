import { redactText } from '../../shared/redaction.js';

type UnknownRecord = Record<string, unknown>;

const SENSITIVE_KEY = /(?:api.?key|access.?token|refresh.?token|id.?token|secret|password|credential|authorization|private.?key|cookie|session.?token)/i;
const FORBIDDEN_KEY = /^(?:system|developer)_?prompt$|^(?:transcript|messages?|tool.?output|raw.?output)$/i;

export { redactText };

export interface RedactObjectOptions {
  dropForbidden?: boolean;
}

export function redactObject(
  value: unknown,
  { dropForbidden = true }: RedactObjectOptions = {},
): unknown {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) {
    return value.map((item) => redactObject(item, { dropForbidden }));
  }
  if (!value || typeof value !== 'object') return value;

  const result: UnknownRecord = {};
  for (const [key, nested] of Object.entries(value as UnknownRecord)) {
    if (dropForbidden && (FORBIDDEN_KEY.test(key) || SENSITIVE_KEY.test(key))) {
      continue;
    }
    result[key] = redactObject(nested, { dropForbidden });
  }
  return result;
}

export function redactSessionSnapshot(
  session: UnknownRecord = {},
): UnknownRecord {
  const redacted = redactObject(session);
  const safe: UnknownRecord = redacted && typeof redacted === 'object' && !Array.isArray(redacted)
    ? redacted as UnknownRecord
    : {};
  delete safe.transcript;
  delete safe.messages;
  delete safe.toolOutput;
  delete safe.systemPrompt;
  delete safe.developerPrompt;
  return safe;
}
