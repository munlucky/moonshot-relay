#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseCliArgs, printResult, resolveStandaloneProject } from './common.mjs';
import { assertSourceUnchanged, ensureArtifactParent, workspaceSnapshot, writeArtifactText } from './artifact-utils.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), '../../..');

export async function runCodebaseMasterGuide({ cwd = process.cwd(), env = process.env, spec = null, output = null, target = null } = {}) {
  const project = resolveStandaloneProject({ cwd, env });
  const before = workspaceSnapshot(project.projectRoot);
  const generatedAt = new Date().toISOString();
  const slug = `codebase-master-guide-${generatedAt.replace(/[^0-9]/g, '').slice(0, 14)}`;
  const outputDir = output ? path.dirname(path.resolve(output)) : path.join(project.projectRuntimeRoot, 'artifacts', 'codebase-master-guide');
  const htmlPath = output ? path.resolve(output) : path.join(outputDir, `${slug}.html`);
  const specPath = spec ? path.resolve(project.projectRoot, spec) : path.join(outputDir, `${slug}.json`);

  let specData = null;
  try {
    const raw = await readFile(specPath, 'utf8');
    specData = JSON.parse(raw);
  } catch {
    const projectName = path.basename(target ? path.resolve(project.projectRoot, target) : project.projectRoot);
    specData = {
      projectTitle: `${projectName} 마스터 개발자 가이드`,
      slug: projectName.toLowerCase(),
      slides: [
        {
          ch: 'CH.00',
          chTitle: '온보딩 & 아키텍처',
          title: '[인프라 토폴로지] 핵심 아키텍처 개요',
          sub: `${projectName} 시스템 구성 및 데이터 흐름`,
          type: 'card',
          contentHtml: `<div class="p-6"><h2>${projectName} 온보딩 가이드</h2><p>본 가이드는 ${projectName}의 전수 코드 분석 및 아키텍처 해설을 제공합니다.</p></div>`,
        },
      ],
    };
    await ensureArtifactParent(specPath);
    await writeArtifactText(specPath, `${JSON.stringify(specData, null, 2)}\n`);
  }

  const templatePath = path.resolve(repoRoot, 'skills', 'codebase-master-guide', 'templates', 'slidebook-template.html');
  const template = await readFile(templatePath, 'utf8');
  const totalSlides = specData.slides?.length || 0;
  const html = template
    .replaceAll('{{PROJECT_TITLE}}', specData.projectTitle || '코드베이스 전수 리뷰 마스터 슬라이드북')
    .replaceAll('{{TOTAL_SLIDES}}', String(totalSlides))
    .replaceAll('{{SLIDES_JSON}}', JSON.stringify(specData.slides || [], null, 2));

  await ensureArtifactParent(htmlPath);
  await writeArtifactText(htmlPath, html);

  const after = workspaceSnapshot(project.projectRoot);
  assertSourceUnchanged(before, after);

  return {
    status: 'pass',
    projectId: project.projectId,
    artifact: { specPath, htmlPath, title: specData.projectTitle, totalSlides },
    sourceMutation: false,
    authority: 'informational',
    satisfiesProof: false,
    satisfiesReview: false,
    satisfiesCompletion: false,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = parseCliArgs(process.argv.slice(2));
  try {
    const result = await runCodebaseMasterGuide({
      spec: args.spec || null,
      output: args.output || args.out || null,
      target: args.target || null,
    });
    printResult(result, { json: args.json });
  } catch (error) {
    printResult({ status: 'error', errorCode: error.code || error.message }, { json: true });
    process.exitCode = 1;
  }
}
