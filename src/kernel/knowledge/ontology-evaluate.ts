import { matchPathScope } from './path-scope.js';

export interface OntologyConstraint {
  id?: string;
  type?: string;
  recordType?: string;
  status?: string;
  scope?: string[];
  pattern?: string | null;
  severity?: string | null;
  statement?: string | null;
  [key: string]: unknown;
}

interface KnowledgeRecordReader {
  listKnowledgeRecords(input?: {
    projectId?: string | null;
    statuses?: string[];
  }): OntologyConstraint[];
}

export interface EvaluateOntologyConstraintsInput {
  projectId?: string | null;
  paths?: string[];
  changes?: string[];
  statements?: string[];
  riskTier?: string;
  stateStore?: KnowledgeRecordReader | null;
  constraints?: OntologyConstraint[] | null;
}

export interface OntologyEvaluationResult {
  passed: boolean;
  applicable: OntologyConstraint[];
  violations: OntologyConstraint[];
  approvalRequired: OntologyConstraint[];
  verificationsRequired: OntologyConstraint[];
}

export async function evaluateOntologyConstraints({
  projectId = null,
  paths = [],
  changes = [],
  statements = [],
  riskTier = 'T0',
  stateStore = null,
  constraints = null,
}: EvaluateOntologyConstraintsInput = {}): Promise<OntologyEvaluationResult> {
  void riskTier;
  const sourceConstraints = stateStore
    ? stateStore
        .listKnowledgeRecords({
          projectId,
          statuses: ['verified', 'committed', 'superseded', 'rejected'],
        })
        .filter((record) => (
          String(record.type || record.recordType || '') === 'ontology_constraint'
        ))
    : Array.isArray(constraints)
      ? constraints
      : null;

  if (!sourceConstraints) {
    throw Object.assign(
      new Error('SQLite Knowledge authority or explicit ontology constraints are required'),
      { code: 'KNOWLEDGE_AUTHORITY_REQUIRED' },
    );
  }

  const applicable: OntologyConstraint[] = [];
  const violations: OntologyConstraint[] = [];
  const approvalRequired: OntologyConstraint[] = [];
  const verificationsRequired: OntologyConstraint[] = [];

  const candidateTexts = [...changes, ...statements];

  for (const constraint of sourceConstraints) {
    if (constraint.status === 'superseded' || constraint.status === 'rejected') continue;
    const scope = Array.isArray(constraint.scope) ? constraint.scope : [];
    const pathApplies = paths.length === 0
      || paths.some((candidatePath) => matchPathScope(candidatePath, scope));
    if (!pathApplies) continue;

    applicable.push(constraint);
    const pattern = constraint.pattern ? String(constraint.pattern) : null;
    const statementMatchesPattern = candidateTexts.some((text) => (
      Boolean(pattern) && new RegExp(pattern as string, 'i').test(text)
    ));

    if (constraint.severity === 'never') {
      if (statementMatchesPattern) {
        violations.push(constraint);
      } else if (!pattern) {
        approvalRequired.push(constraint);
      }
    } else if (constraint.severity === 'ask_first') {
      approvalRequired.push(constraint);
    } else if (
      constraint.severity === 'always'
      || constraint.severity === 'invariant'
    ) {
      verificationsRequired.push(constraint);
    }
  }

  return {
    passed: violations.length === 0,
    applicable,
    violations,
    approvalRequired,
    verificationsRequired,
  };
}
