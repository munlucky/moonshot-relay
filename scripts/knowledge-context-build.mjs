#!/usr/bin/env node
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseAndValidateJsonl, parseJsonl } from './knowledge-records.mjs';
import { resolveProjectIdentity } from './project-identity.mjs';

const VALID_STAGES = new Set([
  'intake',
  'init',
  'requirements',
  'design',
  'plan',
  'validate-plan',
  'prepare',
  'execute',
  'review',
  'verify',
  'score',
  'replan',
  'close',
  'finish',
]);
const DEFAULT_MAX_PROMPT_TOKENS = 900;
const DEFAULT_STALE_AFTER_DAYS = 30;
const CONTEXT_PACK_SCHEMA_VERSION = 1;

const LEGACY_KNOWLEDGE_FILES = Object.freeze([
  { type: 'policy_anchor', path: ['policy', 'policy-anchors.jsonl'] },
  { type: 'semantic_fact', path: ['semantic', 'verified-facts.jsonl'] },
  { type: 'kg_relation', path: ['graph', 'kg-relations.jsonl'] },
  { type: 'ontology_constraint', path: ['ontology', 'constraints.jsonl'] },
]);

const CANONICAL_KNOWLEDGE_FILES = Object.freeze([
  { type: 'policy_anchor', path: ['policy', 'anchors.jsonl'] },
  { type: 'semantic_fact', path: ['semantic', 'facts.jsonl'] },
  { type: 'kg_relation', path: ['graph', 'relations.jsonl'] },
  { type: 'ontology_constraint', path: ['ontology', 'constraints.jsonl'] },
]);

const STAGE_RULES = Object.freeze({
  intake: {
    allowedTypes: ['policy_anchor', 'kg_relation', 'ontology_constraint'],
    limits: { policyAnchors: 3, semanticFacts: 2, graphSynopsis: 1, ontologyConstraints: 1 },
    weights: { policy_anchor: 70, semantic_fact: 45, kg_relation: 15, ontology_constraint: 20 },
  },
  init: {
    allowedTypes: ['policy_anchor', 'kg_relation', 'ontology_constraint'],
    limits: { policyAnchors: 3, semanticFacts: 2, graphSynopsis: 1, ontologyConstraints: 1 },
    weights: { policy_anchor: 70, semantic_fact: 45, kg_relation: 15, ontology_constraint: 20 },
  },
  requirements: {
    allowedTypes: ['policy_anchor', 'semantic_fact', 'ontology_constraint'],
    limits: { policyAnchors: 3, semanticFacts: 3, graphSynopsis: 1, ontologyConstraints: 2 },
    weights: { policy_anchor: 65, semantic_fact: 60, kg_relation: 20, ontology_constraint: 50 },
  },
  design: {
    allowedTypes: ['policy_anchor', 'semantic_fact', 'kg_relation', 'ontology_constraint'],
    limits: { policyAnchors: 2, semanticFacts: 4, graphSynopsis: 3, ontologyConstraints: 3 },
    weights: { policy_anchor: 45, semantic_fact: 65, kg_relation: 65, ontology_constraint: 55 },
  },
  plan: {
    allowedTypes: ['policy_anchor', 'semantic_fact', 'kg_relation', 'ontology_constraint'],
    limits: { policyAnchors: 2, semanticFacts: 4, graphSynopsis: 2, ontologyConstraints: 2 },
    weights: { policy_anchor: 45, semantic_fact: 70, kg_relation: 35, ontology_constraint: 45 },
  },
  'validate-plan': {
    allowedTypes: ['policy_anchor', 'ontology_constraint'],
    limits: { policyAnchors: 2, semanticFacts: 2, graphSynopsis: 2, ontologyConstraints: 5 },
    weights: { policy_anchor: 45, semantic_fact: 45, kg_relation: 45, ontology_constraint: 90 },
  },
  prepare: {
    allowedTypes: ['policy_anchor', 'semantic_fact', 'kg_relation', 'ontology_constraint'],
    limits: { policyAnchors: 3, semanticFacts: 3, graphSynopsis: 2, ontologyConstraints: 3 },
    weights: { policy_anchor: 65, semantic_fact: 50, kg_relation: 45, ontology_constraint: 60 },
  },
  execute: {
    allowedTypes: ['policy_anchor', 'semantic_fact', 'kg_relation', 'ontology_constraint'],
    limits: { policyAnchors: 2, semanticFacts: 3, graphSynopsis: 3, ontologyConstraints: 3 },
    weights: { policy_anchor: 35, semantic_fact: 50, kg_relation: 70, ontology_constraint: 65 },
  },
  review: {
    allowedTypes: ['policy_anchor', 'semantic_fact', 'kg_relation', 'ontology_constraint'],
    limits: { policyAnchors: 3, semanticFacts: 2, graphSynopsis: 3, ontologyConstraints: 4 },
    weights: { policy_anchor: 70, semantic_fact: 40, kg_relation: 55, ontology_constraint: 75 },
  },
  verify: {
    allowedTypes: ['policy_anchor', 'semantic_fact', 'ontology_constraint'],
    limits: { policyAnchors: 2, semanticFacts: 2, graphSynopsis: 2, ontologyConstraints: 4 },
    weights: { policy_anchor: 40, semantic_fact: 45, kg_relation: 45, ontology_constraint: 80 },
  },
  score: {
    allowedTypes: ['policy_anchor', 'ontology_constraint'],
    limits: { policyAnchors: 2, semanticFacts: 2, graphSynopsis: 1, ontologyConstraints: 4 },
    weights: { policy_anchor: 45, semantic_fact: 40, kg_relation: 30, ontology_constraint: 80 },
  },
  replan: {
    allowedTypes: ['policy_anchor', 'semantic_fact', 'kg_relation', 'ontology_constraint'],
    limits: { policyAnchors: 2, semanticFacts: 3, graphSynopsis: 4, ontologyConstraints: 3 },
    weights: { policy_anchor: 45, semantic_fact: 55, kg_relation: 80, ontology_constraint: 60 },
  },
  close: {
    allowedTypes: ['policy_anchor', 'semantic_fact', 'ontology_constraint'],
    limits: { policyAnchors: 2, semanticFacts: 3, graphSynopsis: 1, ontologyConstraints: 3 },
    weights: { policy_anchor: 55, semantic_fact: 60, kg_relation: 25, ontology_constraint: 65 },
  },
  finish: {
    allowedTypes: ['policy_anchor', 'semantic_fact', 'ontology_constraint'],
    limits: { policyAnchors: 2, semanticFacts: 3, graphSynopsis: 1, ontologyConstraints: 3 },
    weights: { policy_anchor: 55, semantic_fact: 60, kg_relation: 25, ontology_constraint: 65 },
  },
});

const PROMPT_UNSAFE_PATTERNS = Object.freeze([
  { name: 'openai_api_key', pattern: /sk-[A-Za-z0-9_-]{6,}/g },
  { name: 'github_token', pattern: /ghp_[A-Za-z0-9_]{6,}/g },
  { name: 'private_key', pattern: /-----BEGIN PRIVATE KEY-----[\s\S]*?-----END PRIVATE KEY-----|BEGIN PRIVATE KEY/g },
  { name: 'password_assignment', pattern: /password\s*=\s*[^,\s;]+/gi },
  { name: 'api_key_assignment', pattern: /apiKey\s*=\s*[^,\s;]+/g },
  { name: 'raw_memorygraph_json', pattern: /"?nodes"?\s*:\s*\[[\s\S]*"?relationships"?\s*:\s*\[/i },
  { name: 'raw_kg_dump', pattern: /"?edges"?\s*:\s*\[[\s\S]*"?relation(ship)?s?"?\s*:/i },
  { name: 'raw_ontology_dump', pattern: /(@prefix|owl:|rdf:|rdfs:|sh:NodeShape|sh:property)/gi },
  { name: 'runtime_log', pattern: /\b(stdout|stderr|runtime log|browser scrape|transcript|prompt archive)\b/gi },
]);

function findUp(startDir, relativePath) {
  let current = path.resolve(startDir);
  while (true) {
    const candidate = path.join(current, relativePath);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return '';
    current = parent;
  }
}

function gitRootOrCwd(cwd) {
  const gitMarker = findUp(cwd, '.git');
  return gitMarker ? path.dirname(gitMarker) : path.resolve(cwd);
}

function repoRelative(repoRoot, filePath) {
  return path.relative(repoRoot, filePath).replace(/\\/g, '/') || path.basename(filePath);
}

function parseYamlScalar(value) {
  const trimmed = String(value || '').trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  if (trimmed === '[]') return [];
  return trimmed;
}

function parseSimpleYaml(text) {
  const result = {};
  let activeArray = '';
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const noComment = rawLine.replace(/\s+#.*$/, '');
    if (!noComment.trim()) continue;
    const indent = noComment.match(/^\s*/)?.[0].length ?? 0;
    const line = noComment.trim();
    if (indent === 0) activeArray = '';
    if (indent === 0 && line.endsWith(':')) {
      const key = line.slice(0, -1);
      result[key] = [];
      activeArray = key;
      continue;
    }
    if (activeArray && line.startsWith('- ')) {
      result[activeArray].push(parseYamlScalar(line.slice(2)));
      continue;
    }
    if (indent === 0) {
      const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (match) result[match[1]] = parseYamlScalar(match[2]);
    }
  }
  return result;
}

function loadKnowledgeContract(repoRoot) {
  const contractPath = path.join(repoRoot, '.claude', 'knowledge.contract.yaml');
  if (!fs.existsSync(contractPath)) return { contract: {}, contractPath: '' };
  return {
    contract: parseSimpleYaml(fs.readFileSync(contractPath, 'utf8')),
    contractPath,
  };
}

function detectUnsafeText(text) {
  const matched = [];
  const input = String(text || '');
  for (const { name, pattern } of PROMPT_UNSAFE_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(input)) matched.push(name);
  }
  return matched;
}

function redactPromptText(text) {
  let output = String(text || '').replace(/\s+/g, ' ').trim();
  const omitted = [];

  for (const { name, pattern } of PROMPT_UNSAFE_PATTERNS) {
    pattern.lastIndex = 0;
    if (!pattern.test(output)) continue;
    omitted.push(name);
    output = output.replace(pattern, `[redacted:${name}]`);
  }

  output = output.replace(/[{}[\]"`]{2,}/g, '').replace(/\s+/g, ' ').trim();
  if (output.length > 220) output = `${output.slice(0, 217).trimEnd()}...`;
  if (!output) output = '[redacted prompt-unsafe content]';

  return { text: output, omitted };
}

function recordOmissions(omittedByPolicy, sourceRef, reasons) {
  for (const reason of reasons) {
    omittedByPolicy.push({ sourceRef, reason });
  }
}

function hasDuplicatePolicyBody(text) {
  return /<INSTRUCTIONS>|system\/developer|developer message|\.claude\/rules|project-doc|AGENTS\.md instructions/i.test(String(text || ''));
}

function isDuplicatePolicyBoilerplateLine(text) {
  return /^(Persona|Identity|Core Attributes|Universal Engineering Instructions|Mindset & Strategy|Problem Solving & Logic|Code Quality & Standards|Communication Protocol|Behavioral guidelines|Tradeoff)\b/i.test(String(text || '').trim());
}

function summarizePolicyPrompt(text, sourceRef) {
  if (hasDuplicatePolicyBody(text)) {
    return {
      text: `Project prompt ${sourceRef}: duplicated instruction body was omitted.`,
      omitted: [],
    };
  }

  let insideDuplicateBlock = false;
  const lines = [];

  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (/^<INSTRUCTIONS>/i.test(trimmed)) {
      insideDuplicateBlock = true;
      continue;
    }
    if (hasDuplicatePolicyBody(trimmed)) {
      insideDuplicateBlock = true;
      continue;
    }
    if (/^<\/INSTRUCTIONS>/i.test(trimmed)) {
      insideDuplicateBlock = false;
      continue;
    }
    if (insideDuplicateBlock) continue;

    const line = {
      text: trimmed.replace(/^#+\s*/, '').trim(),
      heading: /^#+\s+/.test(trimmed),
    };
    if (!line.text) continue;
    if (/^[-*>`{}<]/.test(line.text)) continue;
    if (hasDuplicatePolicyBody(line.text)) continue;
    if (isDuplicatePolicyBoilerplateLine(line.text)) continue;
    lines.push(line);
  }

  const first = lines.find((line) => !line.heading && line.text.length >= 8 && line.text.length <= 160)?.text
    || lines.find((line) => line.text.length >= 8 && line.text.length <= 160)?.text
    || `Repository policy source ${sourceRef} is available, but duplicated instruction body was omitted.`;
  const sanitized = redactPromptText(first);
  return {
    text: `Project prompt ${sourceRef}: ${sanitized.text}`,
    omitted: sanitized.omitted,
  };
}

function loadProjectPromptAnchors(repoRoot, projectId, omittedByPolicy) {
  const promptPaths = [
    path.join(repoRoot, 'AGENTS.md'),
    path.join(repoRoot, '.claude', 'CLAUDE.md'),
    path.join(repoRoot, '.claude', 'PROJECT.md'),
  ];
  const anchors = [];

  for (const filePath of promptPaths) {
    if (!fs.existsSync(filePath)) continue;
    const sourceRef = repoRelative(repoRoot, filePath);
    const text = fs.readFileSync(filePath, 'utf8');
    if (hasDuplicatePolicyBody(text)) {
      omittedByPolicy.push({ sourceRef, reason: 'duplicated_system_developer_or_rules_body' });
    }
    const summary = summarizePolicyPrompt(text, sourceRef);
    recordOmissions(omittedByPolicy, sourceRef, summary.omitted);
    anchors.push({
      type: 'policy_anchor',
      id: `prompt:${sourceRef}`,
      projectId,
      status: 'verified',
      text: summary.text,
      sourceRef,
      trustTier: 'authoritative',
      provenanceRef: '',
      verifiedAt: '',
      supersedes: [],
      promptSource: true,
    });
  }

  return anchors;
}

function readRevision(knowledgeRoot, staleAfterDays, now) {
  const revisionPath = path.join(knowledgeRoot, 'revision.json');
  if (!fs.existsSync(revisionPath)) return { revision: '', stale: false, sourceRef: '' };
  try {
    const revision = JSON.parse(fs.readFileSync(revisionPath, 'utf8'));
    const updatedAt = revision.updatedAt || revision.createdAt || '';
    const stale = updatedAt ? (now.getTime() - Date.parse(updatedAt)) > staleAfterDays * 24 * 60 * 60 * 1000 : false;
    return {
      revision: String(revision.revision || revision.knowledgeRevision || ''),
      stale,
      sourceRef: revisionPath,
      updatedAt,
      layout: (
        revision.schemaVersion === 1
        && Object.prototype.hasOwnProperty.call(revision, 'knowledgeRevision')
        && Number.isInteger(revision.recordCount)
      )
        ? 'canonical'
        : 'legacy',
    };
  } catch (error) {
    return {
      revision: '',
      stale: false,
      sourceRef: revisionPath,
      error: `invalid revision metadata: ${error.message}`,
    };
  }
}

function validateCanonicalProjectionRecord(record, expectedType, sourceName, lineNumber) {
  const location = `${sourceName}:${lineNumber}`;
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return { ok: false, error: `${location}: canonical projection record must be an object` };
  }
  if (!record.id || !record.projectId || typeof record.statement !== 'string') {
    return { ok: false, error: `${location}: canonical projection record is missing id/projectId/statement` };
  }
  if (record.type !== expectedType) {
    return { ok: false, error: `${location}: expected ${expectedType} but found ${String(record.type)}` };
  }
  if (!['committed', 'verified'].includes(record.status)) {
    return { ok: false, error: `${location}: canonical projection status is not durable: ${String(record.status)}` };
  }
  if (!['authoritative', 'verified', 'derived'].includes(record.trustTier)) {
    return { ok: false, error: `${location}: canonical projection trust tier is not prompt-readable: ${String(record.trustTier)}` };
  }
  return { ok: true };
}

function loadKnowledgeRecords(knowledgeRoot, omittedByPolicy, revision) {
  const records = [];
  const readErrors = [];
  let existingFiles = 0;
  let validRecords = 0;
  const canonicalLayout = revision.layout === 'canonical';
  const files = canonicalLayout ? CANONICAL_KNOWLEDGE_FILES : LEGACY_KNOWLEDGE_FILES;

  for (const entry of files) {
    const filePath = path.join(knowledgeRoot, ...entry.path);
    if (!fs.existsSync(filePath)) continue;
    existingFiles += 1;
    const text = fs.readFileSync(filePath, 'utf8');
    const unsafe = detectUnsafeText(text);
    if (unsafe.length > 0) recordOmissions(omittedByPolicy, filePath, [...new Set(unsafe)]);

    if (canonicalLayout) {
      const parsed = parseJsonl(text, { sourceName: filePath });
      if (!parsed.ok) {
        readErrors.push(...parsed.errors);
        continue;
      }
      parsed.records.forEach((record, index) => {
        const validation = validateCanonicalProjectionRecord(
          record,
          entry.type,
          filePath,
          parsed.lineNumbers[index],
        );
        if (!validation.ok) {
          readErrors.push(validation.error);
          return;
        }
        records.push({ ...record, __canonicalProjection: true });
        validRecords += 1;
      });
      continue;
    }

    const validation = parseAndValidateJsonl(text, { sourceName: filePath });
    if (!validation.ok) {
      readErrors.push(...validation.errors);
      continue;
    }
    const typedRecords = validation.records.filter((record) => record.type === entry.type);
    validRecords += typedRecords.length;
    records.push(...typedRecords);
  }

  return { records, readErrors, existingFiles, validRecords };
}

function severityFor(record) {
  if (record.severity === 'blocking' || record.severity === 'critical') return 'error';
  if (record.severity === 'warning') return 'warn';
  if (['error', 'warn', 'info'].includes(record.severity)) return record.severity;
  return 'info';
}

function isPromptVisibleRecord(record) {
  if (record.__canonicalProjection === true) {
    return ['committed', 'verified'].includes(record.status)
      && ['verified', 'authoritative', 'derived'].includes(record.trustTier);
  }
  if (record.type === 'policy_anchor') return ['verified'].includes(record.status);
  if (record.type === 'semantic_fact') return record.status === 'verified' && ['verified', 'derived', 'authoritative'].includes(record.trustTier);
  if (record.type === 'kg_relation') return ['derived', 'verified'].includes(record.status) && ['verified', 'derived'].includes(record.trustTier);
  if (record.type === 'ontology_constraint') return ['staged', 'verified'].includes(record.status);
  return false;
}

function itemText(record) {
  if (record.type === 'policy_anchor') return record.text || record.statement;
  if (record.type === 'semantic_fact') return record.statement;
  if (record.type === 'kg_relation') {
    if (record.summary) return record.summary;
    if (record.statement) return record.statement;
    return `${record.from} ${record.relation} ${record.to}`;
  }
  if (record.type === 'ontology_constraint') {
    if (record.text) return record.text;
    if (record.statement) return record.statement;
    const appliesTo = Array.isArray(record.appliesTo) ? record.appliesTo.join(', ') : String(record.appliesTo || 'project artifact');
    return `${record.scope} constraint applies to ${appliesTo}; enforced by ${record.enforcedBy}.`;
  }
  return '';
}

function stageScore(record, stage) {
  const rule = STAGE_RULES[stage];
  const stages = Array.isArray(record.stages) ? record.stages : [];
  const stageBoost = stages.includes(stage) ? 100 : 0;
  const trustBoost = record.trustTier === 'authoritative' ? 20 : record.trustTier === 'verified' ? 15 : record.trustTier === 'derived' ? 5 : 0;
  const statusBoost = ['verified', 'committed'].includes(record.status) ? 10 : record.status === 'derived' ? 5 : 0;
  const updatedAt = Date.parse(record.updatedAt || record.verifiedAt || record.createdAt || '') || 0;
  return {
    primary: stageBoost + (rule.weights[record.type] || 0) + trustBoost + statusBoost,
    updatedAt,
    id: String(record.id || ''),
  };
}

function sortForStage(records, stage) {
  return [...records].sort((a, b) => {
    const left = stageScore(a, stage);
    const right = stageScore(b, stage);
    if (left.primary !== right.primary) return right.primary - left.primary;
    if (left.updatedAt !== right.updatedAt) return right.updatedAt - left.updatedAt;
    return left.id.localeCompare(right.id);
  });
}

function toPromptItem(record, omittedByPolicy) {
  const sourceRef = record.sourceRef
    || (Array.isArray(record.sourceRefs) ? record.sourceRefs[0] : '')
    || (Array.isArray(record.scope) ? record.scope[0] : '')
    || record.id;
  const sanitized = redactPromptText(itemText(record));
  recordOmissions(omittedByPolicy, sourceRef, sanitized.omitted);

  if (record.type === 'policy_anchor') {
    return {
      id: `policy:${record.id}`,
      text: sanitized.text,
      trustTier: record.trustTier,
      sourceRef,
      provenanceRef: record.provenanceRef || '',
    };
  }
  if (record.type === 'semantic_fact') {
    return {
      id: `fact:${record.id}`,
      text: sanitized.text,
      trustTier: record.trustTier,
      sourceRef,
      provenanceRef: record.provenanceRef || '',
      stale: false,
    };
  }
  if (record.type === 'kg_relation') {
    return {
      id: `kg:${record.id}`,
      text: sanitized.text,
      trustTier: record.trustTier,
      sourceRef,
      provenanceRef: record.provenanceRef || '',
    };
  }
  return {
    id: `ontology:${record.id}`,
    text: sanitized.text,
    severity: severityFor(record),
    enforcedBy: record.enforcedBy || 'ontologyConstraints',
    sourceRef,
  };
}

function selectItems(records, stage, projectId, omittedByPolicy) {
  const rule = STAGE_RULES[stage];
  const allowedTypes = new Set(rule.allowedTypes || []);
  const visible = records
    .filter((record) => record.projectId === projectId)
    .filter(isPromptVisibleRecord)
    .filter((record) => {
      if (allowedTypes.has(record.type)) return true;
      omittedByPolicy.push({
        sourceRef: record.sourceRef || record.provenanceRef || record.id || record.type,
        reason: `stage_${stage}_forbids_${record.type}`,
      });
      return false;
    });

  const byType = {
    policyAnchors: visible.filter((record) => record.type === 'policy_anchor'),
    semanticFacts: visible.filter((record) => record.type === 'semantic_fact'),
    graphSynopsis: visible.filter((record) => record.type === 'kg_relation'),
    ontologyConstraints: visible.filter((record) => record.type === 'ontology_constraint'),
  };

  const selected = {};
  for (const [bucket, bucketRecords] of Object.entries(byType)) {
    selected[bucket] = sortForStage(bucketRecords, stage)
      .slice(0, rule.limits[bucket])
      .map((record) => toPromptItem(record, omittedByPolicy));
  }
  return selected;
}

function approximateTokens(text) {
  return Math.ceil(String(text || '').length / 4);
}

function stableHash(value) {
  return crypto
    .createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex');
}

function buildContextPack(context, options = {}) {
  const staleWarnings = context.staleOrUnavailable
    .filter((item) => item.blocking || context.status === 'stale')
    .map((item) => ({
      reason: item.reason,
      sourceRef: item.sourceRef,
      blocking: item.blocking === true,
    }));
  const statusBlocking = context.staleOrUnavailable.some((item) => item.blocking === true);
  const runtimeAuthorityRef = options.runId || options.goalId
    ? {
        runId: options.runId || '',
        goalId: options.goalId || '',
      }
    : null;
  const lineageInput = [
    context.projectId,
    context.namespace,
    context.knowledgeRevision || '',
    context.stage,
    context.status,
    context.strictness,
    stableHash({
      policyAnchors: context.policyAnchors,
      semanticFacts: context.semanticFacts,
      graphSynopsis: context.graphSynopsis,
      ontologyConstraints: context.ontologyConstraints,
      staleOrUnavailable: context.staleOrUnavailable,
      omittedByPolicy: context.omittedByPolicy,
      runtimeAuthorityRef,
    }),
  ].join('|');
  const contextPackRef = `ctxpack:${stableHash(lineageInput).slice(0, 16)}`;

  return {
    schemaVersion: CONTEXT_PACK_SCHEMA_VERSION,
    packId: contextPackRef,
    contextPackRef,
    projectId: context.projectId,
    namespace: context.namespace,
    knowledgeRevision: context.knowledgeRevision || '',
    stage: context.stage,
    strictness: context.strictness,
    status: context.status,
    blocking: statusBlocking,
    runtimeAuthorityRef,
    tokenEstimate: approximateTokens(context.promptBlock),
    promptFacingAuthority: 'projectKnowledgeContext.promptBlock',
    compatibility: {
      additiveOnly: true,
      preservedTopLevelFields: [
        'schemaVersion',
        'projectId',
        'namespace',
        'knowledgeRevision',
        'status',
        'strictness',
        'stage',
        'policyAnchors',
        'semanticFacts',
        'graphSynopsis',
        'ontologyConstraints',
        'staleOrUnavailable',
        'omittedByPolicy',
        'promptBlock',
      ],
      statusVocabulary: ['ready', 'stale', 'degraded_read', 'degraded_write', 'not_configured'],
      servingMode: context.strictness,
    },
    harnessSlice: {
      policyAnchors: context.policyAnchors,
      omittedByPolicy: context.omittedByPolicy,
    },
    projectSlice: {
      semanticFacts: context.semanticFacts,
      graphSynopsis: context.graphSynopsis,
      ontologyConstraints: context.ontologyConstraints,
    },
    candidateMemory: [],
    staleWarnings,
    provenance: {
      generatedBy: 'scripts/knowledge-context-build.mjs',
      source: 'account-root/project-knowledge',
    },
  };
}

function renderPromptBlock(context, maxPromptTokens) {
  const sections = [
    '## Project Knowledge Context',
    `- projectId: ${context.projectId}`,
    `- namespace: ${context.namespace}`,
    `- knowledgeRevision: ${context.knowledgeRevision || ''}`,
    `- status: ${context.status}`,
    `- strictness: ${context.strictness}`,
    `- stage: ${context.stage}`,
  ];

  const appendItems = (title, items, format) => {
    if (items.length === 0) return;
    sections.push(`- ${title}:`);
    for (const item of items) {
      sections.push(`  - ${format(item)}`);
    }
  };

  appendItems('policy anchors', context.policyAnchors, (item) => `[${item.id}|${item.trustTier}] ${item.text}`);
  appendItems('semantic facts', context.semanticFacts, (item) => `[${item.id}|${item.trustTier}|${item.provenanceRef || 'prov:none'}] ${item.text}`);
  appendItems('graph synopsis', context.graphSynopsis, (item) => `[${item.id}|${item.trustTier}] ${item.text}`);
  appendItems('ontology constraints', context.ontologyConstraints, (item) => `[${item.id}|${item.severity}|enforced_by:${item.enforcedBy}] ${item.text}`);
  appendItems('stale or unavailable', context.staleOrUnavailable, (item) => `${item.reason}${item.blocking ? ' [blocking]' : ''}`);
  appendItems('omitted by policy', context.omittedByPolicy, (item) => `${safeOmissionLabel(item.reason)} from ${item.sourceRef}`);

  const accepted = [];
  for (const line of sections) {
    const candidate = [...accepted, line].join('\n');
    if (approximateTokens(candidate) > maxPromptTokens) {
      accepted.push('- omitted by budget: additional knowledge context truncated');
      break;
    }
    accepted.push(line);
  }

  return accepted.join('\n');
}

function safeOmissionLabel(reason) {
  const labels = {
    openai_api_key: 'secret_like_string',
    github_token: 'secret_like_string',
    private_key: 'secret_like_string',
    password_assignment: 'secret_like_string',
    api_key_assignment: 'secret_like_string',
    raw_memorygraph_json: 'raw_graph_payload',
    raw_kg_dump: 'raw_graph_payload',
    raw_ontology_dump: 'raw_ontology_payload',
    runtime_log: 'external_payload_body',
    duplicated_system_developer_or_rules_body: 'duplicated_policy_body',
  };
  return labels[reason] || 'prompt_unsafe_payload';
}

function statusFromSources({ knowledgeRoot, contractPath, existingFiles, validRecords, readErrors, revision, requireWritable, strictness }) {
  const staleOrUnavailable = [];
  let status = 'ready';

  if (!fs.existsSync(knowledgeRoot)) {
    status = 'not_configured';
    staleOrUnavailable.push({
      reason: 'account-root knowledge namespace is not configured',
      sourceRef: knowledgeRoot,
      blocking: strictness === 'required',
    });
  } else if (readErrors.length > 0 || revision.error) {
    status = 'degraded_read';
    for (const error of [...readErrors, revision.error].filter(Boolean)) {
      staleOrUnavailable.push({
        reason: error,
        sourceRef: knowledgeRoot,
        blocking: strictness === 'required',
      });
    }
  } else if (existingFiles === 0 || validRecords === 0) {
    status = 'not_configured';
    staleOrUnavailable.push({
      reason: contractPath
        ? 'knowledge contract exists but no account-root records were found'
        : 'account-root knowledge namespace contains no configured records',
      sourceRef: knowledgeRoot,
      blocking: strictness === 'required',
    });
  } else if (revision.stale) {
    status = 'stale';
    staleOrUnavailable.push({
      reason: `knowledge revision is stale since ${revision.updatedAt}`,
      sourceRef: revision.sourceRef,
      blocking: strictness === 'required',
    });
  }

  if (status === 'ready' && requireWritable) {
    try {
      fs.accessSync(knowledgeRoot, fs.constants.W_OK);
    } catch {
      status = 'degraded_write';
      staleOrUnavailable.push({
        reason: 'account-root knowledge namespace is not writable',
        sourceRef: knowledgeRoot,
        blocking: strictness === 'required',
      });
    }
  }

  return { status, staleOrUnavailable };
}

export function buildProjectKnowledgeContext(options = {}) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const stage = options.stage || 'plan';
  if (!VALID_STAGES.has(stage)) {
    throw new Error(`invalid stage: ${stage}`);
  }

  const env = options.env || process.env;
  const now = options.now || new Date();
  const resolved = resolveProjectIdentity({ cwd, env, runId: options.runId });
  const projectId = resolved.identity.projectId;
  const repoRoot = gitRootOrCwd(cwd);
  const { contract, contractPath } = loadKnowledgeContract(repoRoot);
  const strictness = options.strictness || contract.strictness || (contract.strictMemory === true ? 'required' : 'advisory');
  const maxPromptTokens = Number(options.maxPromptTokens || contract.maxPromptTokens || DEFAULT_MAX_PROMPT_TOKENS);
  const staleAfterDays = Number(options.staleAfterDays || contract.staleAfterDays || DEFAULT_STALE_AFTER_DAYS);
  const omittedByPolicy = [];

  const promptAnchors = loadProjectPromptAnchors(repoRoot, projectId, omittedByPolicy);
  const knowledgeRoot = resolved.namespaces.knowledgeRoot;
  const revision = readRevision(knowledgeRoot, staleAfterDays, now);
  const loaded = fs.existsSync(knowledgeRoot)
    ? loadKnowledgeRecords(knowledgeRoot, omittedByPolicy, revision)
    : { records: [], readErrors: [], existingFiles: 0 };
  const records = [...promptAnchors, ...loaded.records];
  const selected = selectItems(records, stage, projectId, omittedByPolicy);
  const sourceStatus = statusFromSources({
    knowledgeRoot,
    contractPath,
    existingFiles: loaded.existingFiles,
    validRecords: loaded.validRecords,
    readErrors: loaded.readErrors,
    revision,
    requireWritable: contract.requireWritable === true,
    strictness,
  });

  const context = {
    schemaVersion: 1,
    projectId,
    namespace: 'account-root/project-knowledge',
    knowledgeRevision: revision.revision,
    status: sourceStatus.status,
    strictness,
    stage,
    policyAnchors: selected.policyAnchors,
    semanticFacts: selected.semanticFacts,
    graphSynopsis: selected.graphSynopsis,
    ontologyConstraints: selected.ontologyConstraints,
    staleOrUnavailable: sourceStatus.staleOrUnavailable,
    omittedByPolicy: omittedByPolicy
      .filter((item, index, array) => array.findIndex((other) => other.sourceRef === item.sourceRef && other.reason === item.reason) === index)
      .slice(0, 12),
    promptBlock: '',
  };

  context.promptBlock = renderPromptBlock(context, maxPromptTokens);
  context.contextPack = buildContextPack(context, {
    runId: options.runId || '',
    goalId: options.goalId || '',
  });
  context.metadata = {
    contextPackRef: context.contextPack.contextPackRef,
    packId: context.contextPack.packId,
    contextPackSchemaVersion: context.contextPack.schemaVersion,
    tokenEstimate: context.contextPack.tokenEstimate,
    blocking: context.contextPack.blocking,
    unavailableCount: context.staleOrUnavailable.length,
    servingMode: context.strictness,
  };
  const leaked = detectUnsafeText(context.promptBlock);
  if (leaked.length > 0) {
    throw new Error(`prompt purity violation after render: ${leaked.join(', ')}`);
  }

  return { projectKnowledgeContext: context };
}

function parseArgs(argv) {
  const args = { cwd: process.cwd(), stage: 'plan', runId: '', goalId: '', json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--cwd') args.cwd = argv[++index] || args.cwd;
    else if (item.startsWith('--cwd=')) args.cwd = item.slice('--cwd='.length);
    else if (item === '--stage') args.stage = argv[++index] || args.stage;
    else if (item.startsWith('--stage=')) args.stage = item.slice('--stage='.length);
    else if (item === '--run-id') args.runId = argv[++index] || '';
    else if (item.startsWith('--run-id=')) args.runId = item.slice('--run-id='.length);
    else if (item === '--goal-id') args.goalId = argv[++index] || '';
    else if (item.startsWith('--goal-id=')) args.goalId = item.slice('--goal-id='.length);
    else if (item === '--strictness') args.strictness = argv[++index] || '';
    else if (item.startsWith('--strictness=')) args.strictness = item.slice('--strictness='.length);
    else if (item === '--json') args.json = true;
    else if (item === '--help' || item === '-h') args.help = true;
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node knowledge-context-build.mjs --cwd <path> --stage <intake|init|requirements|design|plan|validate-plan|prepare|execute|review|verify|score|replan|close|finish> [--run-id <id>] [--goal-id <id>] --json

Builds a deterministic, prompt-safe projectKnowledgeContext block from account-root project knowledge.`);
}

function cli() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  try {
    const result = buildProjectKnowledgeContext(args);
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(result.projectKnowledgeContext.promptBlock);
  } catch (error) {
    const payload = {
      ok: false,
      code: 'knowledge_context_build_failed',
      message: error.message,
    };
    if (args.json) console.error(JSON.stringify(payload, null, 2));
    else console.error(`${payload.code}: ${payload.message}`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) cli();
