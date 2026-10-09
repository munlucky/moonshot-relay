import { loadAllProjectRecords } from './store.mjs';
import { matchPathScope } from './path-scope.mjs';

export async function evaluateOntologyConstraints({ projectId, paths = [], changes = [], statements = [], riskTier = 'T0', env = process.env } = {}) {
  const records = await loadAllProjectRecords(projectId, { env });
  const constraints = records.ontologyConstraints || [];

  const applicable = [];
  const violations = [];
  const approvalRequired = [];
  const verificationsRequired = [];

  const candidateTexts = [...(Array.isArray(changes) ? changes : []), ...(Array.isArray(statements) ? statements : [])];

  for (const constraint of constraints) {
    if (constraint.status === 'superseded' || constraint.status === 'rejected') continue;
    const isPathApplies = !paths.length || paths.some((p) => matchPathScope(p, constraint.scope || []));
    if (isPathApplies) {
      applicable.push(constraint);
      // Check if statement/content explicitly matches a violation pattern or if severity is never with matching content
      const statementMatchesPattern = candidateTexts.some((text) => {
        if (!text || typeof text !== 'string') return false;
        if (constraint.pattern) {
          return new RegExp(constraint.pattern, 'i').test(text);
        }
        return false;
      });

      if (constraint.severity === 'never') {
        if (statementMatchesPattern) {
          violations.push(constraint);
        } else if (!constraint.pattern) {
          approvalRequired.push(constraint);
        }
      } else if (constraint.severity === 'ask_first') {
        approvalRequired.push(constraint);
      } else if (constraint.severity === 'always' || constraint.severity === 'invariant') {
        verificationsRequired.push(constraint);
      }
    }
  }

  const passed = violations.length === 0;

  return {
    passed,
    applicable,
    violations,
    approvalRequired,
    verificationsRequired,
  };
}
