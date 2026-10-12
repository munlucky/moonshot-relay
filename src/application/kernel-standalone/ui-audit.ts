#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveStandaloneProject } from '../../kernel/standalone/common.js';
import {
  assertSourceUnchanged,
  digestJson,
  ensureArtifactParent,
  listFilesRecursive,
  workspaceSnapshot,
  writeArtifactText,
  type WorkspaceIdentityObserver,
} from '../../kernel/standalone/artifact-utils.js';

type UiSeverity = 'P1' | 'P2' | 'P3';
type UiDimension =
  | 'accessibility'
  | 'performance'
  | 'responsive'
  | 'design'
  | 'theming';

interface UiFinding {
  severity: UiSeverity;
  dimension: UiDimension;
  code: string;
  message: string;
  file: string | null;
}

interface UiAuditInput {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  target?: string | null;
  output?: string | null;
  observeWorkspaceIdentity?: WorkspaceIdentityObserver | null;
}

const UI_EXTENSIONS = new Set([
  '.html',
  '.htm',
  '.css',
  '.scss',
  '.tsx',
  '.jsx',
  '.vue',
  '.svelte',
]);

const finding = (
  severity: UiSeverity,
  dimension: UiDimension,
  code: string,
  message: string,
  file: string | null = null,
): UiFinding => ({ severity, dimension, code, message, file });

export async function runUiAudit({
  cwd = process.cwd(),
  env = process.env,
  target = null,
  output = null,
  observeWorkspaceIdentity = null,
}: UiAuditInput = {}) {
  const project = resolveStandaloneProject({ cwd, env });
  const before = workspaceSnapshot(
    project.projectRoot,
    observeWorkspaceIdentity,
  );
  const targetRoot = target
    ? path.resolve(project.projectRoot, target)
    : project.projectRoot;
  const files = (await listFilesRecursive(targetRoot))
    .filter((rel) => UI_EXTENSIONS.has(path.extname(rel).toLowerCase()));
  const findings: UiFinding[] = [];
  for (const relative of files) {
    const absolute = path.join(targetRoot, relative);
    const text = await readFile(absolute, 'utf8');
    const projectRelative = path.relative(project.projectRoot, absolute);
    if (/\<img\b(?![^>]*\balt\s*=)/i.test(text)) {
      findings.push(finding('P1', 'accessibility', 'image-alt-missing', 'Image element has no alt attribute.', projectRelative));
    }
    if (/\<button\b[^>]*\bdisabled\b/i.test(text) && !/aria-disabled/i.test(text)) {
      findings.push(finding('P2', 'accessibility', 'disabled-state-semantic', 'Disabled controls should expose an explicit accessible state.', projectRelative));
    }
    if (/(onclick|onkeydown|onkeyup)=/i.test(text) && !/aria-label|role=/i.test(text)) {
      findings.push(finding('P2', 'accessibility', 'interaction-name-missing', 'Interactive markup may lack an accessible name or role.', projectRelative));
    }
    if (/!important\b/.test(text)) {
      findings.push(finding('P2', 'design', 'important-overrides', 'Avoid repeated !important overrides; prefer design tokens and component ownership.', projectRelative));
    }
    if (/font-size\s*:\s*\d+px/i.test(text)) {
      findings.push(finding('P3', 'responsive', 'fixed-font-size', 'Review fixed font sizes for responsive and user scaling behavior.', projectRelative));
    }
    if (/fetch\(|axios\.|XMLHttpRequest/i.test(text) && /useEffect\s*\(/.test(text)) {
      findings.push(finding('P2', 'performance', 'effect-fetch-review', 'Review request cancellation and loading/error states for effect-driven fetching.', projectRelative));
    }
  }
  const dimensions: Record<UiDimension, UiFinding[]> = {
    accessibility: findings.filter((item) => item.dimension === 'accessibility'),
    performance: findings.filter((item) => item.dimension === 'performance'),
    responsive: findings.filter((item) => item.dimension === 'responsive'),
    design: findings.filter((item) => item.dimension === 'design'),
    theming: [],
  };
  const report = {
    schemaVersion: 1,
    utility: 'ui-audit',
    authority: 'informational',
    projectId: project.projectId,
    target: path.relative(project.projectRoot, targetRoot).replaceAll('\\', '/') || '.',
    sourceIdentity: before.identity,
    status: findings.length === 0 ? 'PASS' : 'FINDINGS',
    scores: Object.fromEntries(
      Object.entries(dimensions).map(([key, items]) => [
        key,
        Math.max(0, 4 - items.length),
      ]),
    ),
    findings,
    recommendations: findings.length
      ? ['Route source changes through Kernel and re-run the audit after implementation.']
      : ['Keep the current UI evidence as informational context only.'],
    reviewReceipt: null,
    completionDecision: null,
    satisfiesProtectedReview: false,
    satisfiesCompletion: false,
  };
  const outputPath = output
    ? path.resolve(output)
    : path.join(
      project.projectRuntimeRoot,
      'artifacts',
      'ui-audit',
      `ui-audit-${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}.json`,
    );
  await ensureArtifactParent(outputPath);
  await writeArtifactText(
    outputPath,
    `${JSON.stringify({ ...report, reportDigest: digestJson(report) }, null, 2)}\n`,
  );
  const after = workspaceSnapshot(
    project.projectRoot,
    observeWorkspaceIdentity,
  );
  assertSourceUnchanged(before, after);
  return {
    ...report,
    reportPath: outputPath,
    sourceMutation: false,
    reportDigest: digestJson(report),
  };
}
