const SENSITIVE_KEY = /^(?:authorization|cookie|set-cookie|password|passwd|privateKey|private_key|accessToken|access_token|access-token|x-access-token|refreshToken|refresh_token|refresh-token|x-refresh-token|sessionToken|session_token|session-token|apiKey|api_key|api-key|x-api-key|secret|session-secret|session_secret)$/i;
const TOKEN_PATTERNS = [
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[opusr]_[A-Za-z0-9]{16,}\b/g,
  /\b(?:Bearer\s+)[A-Za-z0-9._~+/-]{12,}=*\b/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(authorization|x-api-key|api[_-]?key|access[_-]?token|x-refresh-token|refresh[_-]?token|password|passwd|cookie|session[-_]?secret|secret)\s*[:=]\s*(?:(?:bearer|token)\s+)?["']?([^\s"',;}{]{3,})/gi,
];

const knownValuesFromEnv = (env = process.env) => Object.entries(env)
  .filter(([key, value]) => /(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|AUTHORIZATION|COOKIE)/i.test(key) && typeof value === 'string' && value.length >= 8)
  .map(([, value]) => value);

export const containsRawSecret = (value, { knownSecretValues = knownValuesFromEnv() } = {}) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (knownSecretValues.some((secret) => secret && text.includes(secret))) return true;
  return TOKEN_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
};

export const sanitizePersistentText = (value, { knownSecretValues = knownValuesFromEnv() } = {}) => {
  let text = String(value ?? '');
  for (const secret of knownSecretValues) {
    if (secret) text = text.split(secret).join('[REDACTED]');
  }
  for (const pattern of TOKEN_PATTERNS) {
    pattern.lastIndex = 0;
    text = text.replace(pattern, (match, label) => label ? `${label}=[REDACTED]` : '[REDACTED]');
  }
  return text;
};

export const sanitizePersistentPayload = (value, options = {}) => {
  if (typeof value === 'string') return sanitizePersistentText(value, options);
  if (Array.isArray(value)) return value.map((entry) => sanitizePersistentPayload(entry, options));
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'secretRefs') {
      result[key] = Array.isArray(entry) ? entry.map(String) : [];
    } else if (SENSITIVE_KEY.test(key)) {
      result[key] = '[REDACTED]';
    } else {
      result[key] = sanitizePersistentPayload(entry, options);
    }
  }
  return result;
};

export const assertNoRawSecret = (value, options = {}) => {
  if (containsRawSecret(value, options)) {
    const error = new Error('contract_rejected: raw_secret_detected; use secretRefs instead');
    error.code = 'RAW_SECRET_DETECTED';
    throw error;
  }
  return value;
};
