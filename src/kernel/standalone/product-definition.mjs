#!/usr/bin/env node
import path from 'node:path';
import { resolveStandaloneProject, listArg } from './common.mjs';
import { assertSourceUnchanged, workspaceSnapshot } from './artifact-utils.mjs';
import { writePreworkPackage } from './prework.mjs';

const markdown = (title, objective, body) => `# ${title}\n\nObjective: ${objective}\n\n${body}\n`;

export async function runProductDefinition({ cwd = process.cwd(), env = process.env, objective = '', output = null, args = {} } = {}) {
  const project = resolveStandaloneProject({ cwd, env });
  const requestedObjective = String(objective || args.objective || '').trim();
  if (!requestedObjective) throw Object.assign(new Error('PRODUCT_OBJECTIVE_REQUIRED'), { code: 'PRODUCT_OBJECTIVE_REQUIRED' });
  const before = workspaceSnapshot(project.projectRoot);
  const packageId = `product-${Date.now()}`;
  const directory = output ? path.resolve(output) : path.join(project.projectRuntimeRoot, 'prework', 'product', packageId);
  const acceptance = listArg(args.acceptance || '').map((item) => item.replaceAll('|', ' '));
  const constraints = listArg(args.constraint || args.constraints || '');
  const nonGoals = listArg(args.nonGoal || args.nonGoals || '');
  const files = {
    'PRODUCT_INTENT.md': markdown('Product Intent', requestedObjective, 'Define the user value, primary user, and measurable outcome. This artifact is advisory and does not authorize source mutation.'),
    'PRD.md': markdown('Product Requirements', requestedObjective, acceptance.length ? `## Acceptance\n\n${acceptance.map((item, index) => `- AC-${index + 1}: ${item}`).join('\n')}` : '## Acceptance\n\n- Acceptance must be confirmed and normalized by the Kernel Host.'),
    'SOLUTION.md': markdown('Solution', requestedObjective, 'Record the smallest product-level solution and explicit alternatives without assigning implementation authority.'),
    'SPEC.md': markdown('Specification', requestedObjective, 'Describe observable behavior, edge cases, assumptions, and blockers for later Kernel normalization.'),
    'PLAN.md': markdown('Plan', requestedObjective, 'Create bounded execution candidates only. The Kernel decides the final task contract and work units.'),
    'ASSUMPTIONS.md': markdown('Assumptions', requestedObjective, constraints.length ? constraints.map((item) => `- ${item}`).join('\n') : '- No additional assumptions recorded.'),
    'BLOCKERS.md': markdown('Blockers', requestedObjective, '- None recorded by this artifact generator.'),
  };
  const packageResult = await writePreworkPackage({ directory, utility: 'product-definition', projectId: project.projectId, objective: requestedObjective, kind: 'product-definition', files, acceptance, constraints, nonGoals });
  const after = workspaceSnapshot(project.projectRoot);
  assertSourceUnchanged(before, after);
  return {
    status: 'pass',
    packageId,
    projectId: project.projectId,
    packagePath: directory,
    artifacts: packageResult.files,
    taskContractSeed: packageResult.seed,
    seedPath: packageResult.seedPath,
    authority: 'task-contract-seed-only',
    sourceMutation: false,
    completionDecision: null,
    knowledgeCommit: null,
  };
}
