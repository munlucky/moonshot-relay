// Generated from src/shared/redaction.ts. Edit the source and run npm run build.
export const redactText = (value) => String(value || '')
    .replace(/\b(?:sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{16,}|AKIA[0-9A-Z]{16})\b/g, '[REDACTED]')
    .replace(/((?:api.?key|token|secret|password|credential|authorization)\s*[:=]\s*)(?:Bearer\s+)?([^\s,;]+)/ig, '$1[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/ig, 'Bearer [REDACTED]');
