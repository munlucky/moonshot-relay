// Generated from src/shared/context-sanitization.ts. Edit the source and run npm run build.
const secretKeyRegex = /^(?:api[_-]?key|token|password|secret|authorization|access[_-]?token|auth[_-]?token|private[_-]?key)$/i;
const stringSecretPatterns = [
    { regex: /(?:Authorization\s*:\s*)?Bearer\s+\S+/gi, replace: 'Authorization: Bearer [REDACTED]' },
    { regex: /-----BEGIN (?:[A-Z0-9\s]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9\s]+ )?PRIVATE KEY-----/g, replace: '[REDACTED_PEM_KEY]' },
    { regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, replace: '[REDACTED_JWT]' },
    { regex: /\b([a-z0-9+.-]+:\/\/[^:\s]+:)([^@\s]+)(@[^\s]+)/gi, replace: '$1[REDACTED]$3' },
    { regex: /("(?:api[_-]?key|token|password|secret|access[_-]?token|auth[_-]?token|private[_-]?key)"\s*:\s*)("(?:[^"\\]|\\.)*"|\S+)/gi, replace: '$1"[REDACTED]"' },
    { regex: /((?:api[_-]?key|token|password|secret|access[_-]?token|auth[_-]?token|private[_-]?key)\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi, replace: '$1[REDACTED]' },
];
export const redactSecretsInObject = (value) => {
    if (value === null || typeof value !== 'object')
        return value;
    if (Array.isArray(value))
        return value.map(redactSecretsInObject);
    const result = {};
    for (const [key, nested] of Object.entries(value)) {
        result[key] = secretKeyRegex.test(key)
            ? '[REDACTED]'
            : redactSecretsInObject(nested);
    }
    return result;
};
export const sanitizeText = (value) => {
    let text = String(value || '');
    for (const pattern of stringSecretPatterns) {
        text = text.replace(pattern.regex, pattern.replace);
    }
    return text;
};
export const wrapUntrustedDataFence = (content, label = 'untrusted_content') => {
    const sanitized = sanitizeText(content);
    return `<${label}>\n${sanitized}\n</${label}>`;
};
