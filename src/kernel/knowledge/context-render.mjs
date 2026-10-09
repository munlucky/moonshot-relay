import crypto from 'node:crypto';

export function redactSecrets(text) {
  if (!text || typeof text !== 'string') return text;
  let str = text;
  // Redact API keys, tokens, passwords, headers
  str = str.replace(/(api[_-]?key|secret|token|password|auth_header)\s*[:=]\s*["']?([a-zA-Z0-9_\-\.]{16,})["']?/gi, '$1: "[REDACTED]"');
  str = str.replace(/\b(sk-[a-zA-Z0-9]{20,})\b/g, '[REDACTED_KEY]');
  str = str.replace(/\b(ghp_[a-zA-Z0-9]{20,})\b/g, '[REDACTED_TOKEN]');
  // Redact Bearer tokens, private keys, JWTs, and connection strings
  str = str.replace(/\bBearer\s+[a-zA-Z0-9_\-\.=]{16,}\b/gi, 'Bearer [REDACTED_TOKEN]');
  str = str.replace(/-----BEGIN (?:RSA|EC|PGP|OPENSSH) PRIVATE KEY-----[\s\S]*?-----END (?:RSA|EC|PGP|OPENSSH) PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]');
  str = str.replace(/\beyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/g, '[REDACTED_JWT]');
  str = str.replace(/\b(mongodb|postgres|mysql|redis):\/\/[^\s"']+/gi, '$1://[REDACTED_CONNECTION_STRING]');
  return str;
}

export function deepRedact(obj) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') return redactSecrets(obj);
  if (Array.isArray(obj)) return obj.map((item) => deepRedact(item));
  if (typeof obj === 'object') {
    const res = {};
    for (const [key, val] of Object.entries(obj)) {
      if (typeof val === 'string') {
        res[key] = redactSecrets(val);
      } else if (typeof val === 'object' && val !== null) {
        res[key] = deepRedact(val);
      } else {
        res[key] = val;
      }
    }
    return res;
  }
  return obj;
}

export function renderPromptBlock({ stage, policyAnchors = [], semanticFacts = [], graphSynopsis = [], ontologyConstraints = [] }) {
  const lines = [`[Project Knowledge Context - Stage: ${stage}]`];

  if (policyAnchors.length > 0) {
    lines.push('\n### Policy Anchors:');
    for (const anchor of policyAnchors) {
      lines.push(`- ${redactSecrets(anchor.statement || anchor.title || JSON.stringify(anchor))}`);
    }
  }

  if (semanticFacts.length > 0) {
    lines.push('\n### Verified Facts:');
    for (const fact of semanticFacts) {
      lines.push(`- ${redactSecrets(fact.statement || JSON.stringify(fact))}`);
    }
  }

  if (ontologyConstraints.length > 0) {
    lines.push('\n### Ontology Constraints:');
    for (const constraint of ontologyConstraints) {
      lines.push(`- [${constraint.severity || 'invariant'}] ${redactSecrets(constraint.statement || JSON.stringify(constraint))}`);
    }
  }

  if (graphSynopsis.length > 0) {
    lines.push('\n### Architectural Relations:');
    for (const rel of graphSynopsis) {
      lines.push(`- ${redactSecrets(rel.statement || `${rel.from} -> ${rel.relation} -> ${rel.to}`)}`);
    }
  }

  return lines.join('\n');
}

export function computeContextDigest(contextPayload) {
  const normalized = JSON.stringify({
    projectId: contextPayload.projectId,
    knowledgeRevision: contextPayload.knowledgeRevision,
    stage: contextPayload.stage,
    strictness: contextPayload.strictness,
    promptBlock: contextPayload.promptBlock,
  });
  return crypto.createHash('sha256').update(normalized).digest('hex');
}
