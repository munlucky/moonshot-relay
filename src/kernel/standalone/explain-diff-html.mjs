#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { resolveStandaloneProject } from './common.mjs';
import { assertSourceUnchanged, digestText, ensureArtifactParent, workspaceSnapshot, writeArtifactText } from './artifact-utils.mjs';

const escapeHtml = (value) => String(value || '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;');

const gitOutput = (cwd, args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw Object.assign(new Error(`git_diff_failed: ${result.stderr || result.stdout}`), { code: 'GIT_DIFF_FAILED' });
  return result.stdout || '';
};

export async function runExplainDiffHtml({ cwd = process.cwd(), env = process.env, output = null, target = null, source = null } = {}) {
  const project = resolveStandaloneProject({ cwd, env });
  const before = workspaceSnapshot(project.projectRoot);
  const diffArgs = ['diff', '--no-ext-diff', '--binary'];
  if (source && String(source).includes('...')) diffArgs.push(String(source));
  if (target) diffArgs.push('--', String(target));
  const diff = gitOutput(project.projectRoot, diffArgs);
  const stat = gitOutput(project.projectRoot, ['diff', '--stat', ...(target ? ['--', String(target)] : [])]);
  const generatedAt = new Date().toISOString();
  const slug = `explain-diff-${generatedAt.replace(/[^0-9]/g, '').slice(0, 14)}`;
  const outputDir = output ? path.dirname(path.resolve(output)) : path.join(project.projectRuntimeRoot, 'artifacts', 'explain-diff');
  const htmlPath = output ? path.resolve(output) : path.join(outputDir, `${slug}.html`);
  const specPath = path.join(outputDir, `${slug}.json`);
  const spec = {
    schemaVersion: 1,
    utility: 'explain-diff-html',
    authority: 'informational',
    projectId: project.projectId,
    sourceIdentity: before.identity,
    generatedAt,
    title: `Change explanation for ${path.basename(project.projectRoot)}`,
    sections: [
      { title: 'Background', html: `<p>Generated from the current Git diff for <code>${escapeHtml(project.projectRoot)}</code>.</p>` },
      { title: 'Intuition', html: `<p>The change contains <strong>${escapeHtml(stat.trim() || 'no textual diff')}</strong>.</p>` },
      { title: 'Code', html: `<pre>${escapeHtml(diff || '(working tree has no textual diff)')}</pre>` },
      { title: 'Quiz', html: '<p>This artifact is explanatory only; it does not prove or review the change.</p>' },
    ],
    diffDigest: digestText(diff),
    proofReceipt: null,
    reviewReceipt: null,
    completionDecision: null,
  };
  await ensureArtifactParent(htmlPath);
  await ensureArtifactParent(specPath);
  await writeArtifactText(specPath, `${JSON.stringify(spec, null, 2)}\n`);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(spec.title)}</title><style>body{font:16px system-ui;max-width:1100px;margin:2rem auto;padding:0 1rem;color:#172033}pre{white-space:pre-wrap;background:#f4f6f8;padding:1rem;border-radius:8px;overflow:auto}code{font-family:ui-monospace,monospace}</style></head><body><h1>${escapeHtml(spec.title)}</h1>${spec.sections.map((section) => `<section><h2>${escapeHtml(section.title)}</h2>${section.html}</section>`).join('')}</body></html>\n`;
  await writeArtifactText(htmlPath, html);
  const after = workspaceSnapshot(project.projectRoot);
  assertSourceUnchanged(before, after);
  return {
    status: 'pass',
    projectId: project.projectId,
    artifact: { specPath, htmlPath, diffDigest: spec.diffDigest },
    sourceMutation: false,
    authority: 'informational',
    satisfiesProof: false,
    satisfiesReview: false,
    satisfiesCompletion: false,
  };
}
