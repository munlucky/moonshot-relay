#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const repoRootDefault = path.dirname(path.dirname(scriptPath));

const unsafePatterns = [
  /secret/i,
  /token/i,
  /password/i,
  /credential/i,
  /runtimeLogBody/i,
  /rawMemoryGraph/i,
  /browserScrapeBody/i,
];

const parseFrontmatter = (text) => {
  if (!text.startsWith('---\n')) {
    return { frontmatter: {}, body: text };
  }
  const end = text.indexOf('\n---', 4);
  if (end === -1) {
    return { frontmatter: {}, body: text };
  }
  const raw = text.slice(4, end).trim();
  const body = text.slice(end + 4).replace(/^\r?\n/, '');
  const frontmatter = {};
  let activeKey = '';
  for (const line of raw.split(/\r?\n/)) {
    const keyValue = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (keyValue) {
      activeKey = keyValue[1];
      const value = keyValue[2].trim();
      frontmatter[activeKey] = value === '' ? [] : value.replace(/^["']|["']$/g, '');
      continue;
    }
    const item = line.match(/^\s*-\s+(.+)$/);
    if (item && activeKey) {
      if (!Array.isArray(frontmatter[activeKey])) {
        frontmatter[activeKey] = [];
      }
      frontmatter[activeKey].push(item[1].trim().replace(/^["']|["']$/g, ''));
    }
  }
  return { frontmatter, body };
};

const extractHeadings = (text) => text
  .split(/\r?\n/)
  .filter((line) => /^#{1,3}\s+/.test(line))
  .map((line) => line.replace(/^#{1,3}\s+/, '').trim());

const tokenEstimate = (text) => Math.ceil(text.split(/\s+/).filter(Boolean).length * 1.35);

const sanitizePromptBlock = (text) => {
  const removed = [];
  const lines = [];
  let unsafeBlockIndent = null;
  for (const line of text.split(/\r?\n/)) {
    const indent = line.match(/^\s*/)[0].length;
    if (unsafeBlockIndent !== null) {
      if (line.trim() === '') {
        removed.push('');
        continue;
      }
      if (indent > unsafeBlockIndent && !/^#{1,6}\s+/.test(line)) {
        removed.push(line.trim().slice(0, 80));
        continue;
      }
      unsafeBlockIndent = null;
    }
    if (unsafePatterns.some((pattern) => pattern.test(line))) {
      removed.push(line.trim().slice(0, 80));
      if (/^\s*[A-Za-z0-9_-]+\s*:\s*($|[>|])/.test(line) || /^\s*(?:-\s*)?(runtimeLogBody|rawMemoryGraph|browserScrapeBody)\s*:/i.test(line)) {
        unsafeBlockIndent = indent;
      }
      continue;
    }
    lines.push(line);
  }
  return {
    promptBlock: lines.join('\n').trim(),
    redactedLineCount: removed.length,
  };
};

const readJson = async (target) => JSON.parse(await readFile(target, 'utf8'));

const routeSchemaVersion = 'moonshot-skill-route.v1';
const referenceSchemaVersion = 'moonshot-skill-reference.v1';

const blockingFinding = (code, message) => ({ severity: 'blocking', code, message });

const isWithin = (root, target) => target === root || target.startsWith(`${root}${path.sep}`);

const normalizeDeepReference = (skillName, reference) => {
  const value = String(reference || '').trim().replaceAll('\\', '/');
  if (!value || path.posix.isAbsolute(value) || value.split('/').includes('..')) {
    return { status: 'fail', code: 'reference.path_escape', value };
  }
  const isRepoRootReference = /^(?:docs|rules|schemas)\//.test(value);
  const isNormalizedSkillReference = value.startsWith(`skills/${skillName}/`);
  const repoRelative = isRepoRootReference || isNormalizedSkillReference
    ? path.posix.normalize(value)
    : path.posix.normalize(`skills/${skillName}/${value}`);
  const allowedPrefix = isRepoRootReference ? repoRelative.split('/')[0] : `skills/${skillName}`;
  if (!repoRelative.startsWith(`${allowedPrefix}/`)) {
    return { status: 'fail', code: 'reference.path_escape', value };
  }
  return { status: 'pass', referenceId: repoRelative, allowedPrefix };
};

const listSkillDirs = async (repoRoot) => {
  const skillsRoot = path.join(repoRoot, 'skills');
  const entries = await readdir(skillsRoot, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
};

const detectTrack = async (projectRoot) => {
  try {
    const { readProjectTrack } = await import('./kernel/runtime-home.js');
    return await readProjectTrack(projectRoot || process.cwd());
  } catch {
    return 'relay';
  }
};

export const loadSkillCatalog = async (options = {}) => {
  const repoRoot = options.repoRoot || repoRootDefault;
  const projectRoot = options.projectRoot || process.cwd();
  const activeTrack = await detectTrack(projectRoot);
  const catalogRoot = options.catalogRoot || repoRoot;
  const defaultCatalog = activeTrack === 'kernel'
    ? path.join(catalogRoot, 'catalog', 'kernel-skills.json')
    : path.join(catalogRoot, 'catalog', 'moonshot-catalog.json');
  const catalogPath = options.catalogPath || defaultCatalog;
  const catalog = await readJson(catalogPath);
  const publicNames = new Set((catalog.publicEntrypoints || []).map((entry) => entry.name));
  const catalogByName = new Map((catalog.publicEntrypoints || []).map((entry) => [entry.name, entry]));
  const clusterBySkill = new Map();
  for (const cluster of catalog.internalSkillClusters || []) {
    for (const skill of cluster.skills || []) {
      clusterBySkill.set(skill, cluster);
    }
  }

  const skills = [];
  for (const name of await listSkillDirs(repoRoot)) {
    const sourcePath = path.join(repoRoot, 'skills', name, 'SKILL.md');
    let text = '';
    try {
      text = await readFile(sourcePath, 'utf8');
    } catch {
      continue;
    }
    const { frontmatter, body } = parseFrontmatter(text);
    const publicEntry = catalogByName.get(name);
    const internalCluster = clusterBySkill.get(name);
    const description = frontmatter.description || publicEntry?.purpose || '';
    const normalizedReferences = [frontmatter.deepReferences].flat().filter(Boolean)
      .map((ref) => normalizeDeepReference(name, ref));
    const deepReferences = normalizedReferences
      .filter((entry) => entry.status === 'pass')
      .map((entry) => entry.referenceId);
    skills.push({
      name,
      exposure: publicNames.has(name) ? 'public' : 'internal',
      stage: publicEntry?.stage || internalCluster?.stage || frontmatter.layer || 'unclassified',
      ownerCluster: publicEntry?.ownerCluster || internalCluster?.id || 'unclassified',
      description,
      triggers: Array.isArray(frontmatter.triggers) ? frontmatter.triggers : [],
      references: [
        `skills/${name}/SKILL.md`,
        ...deepReferences,
      ],
      headings: extractHeadings(body),
      tokenEstimate: tokenEstimate(text),
      contentHash: createHash('sha256').update(text).digest('hex').slice(0, 16),
      invalidDeepReferences: normalizedReferences.filter((entry) => entry.status === 'fail'),
      routeMetadata: publicEntry ? {
        engineRoute: publicEntry.engineRoute || '',
        invocationMode: publicEntry.invocationMode || '',
        allowedStages: Array.isArray(publicEntry.allowedStages) ? publicEntry.allowedStages : [],
        conditionalSkillGroups: publicEntry.conditionalSkillGroups || {},
      } : null,
      sourcePath,
      text,
    });
  }
  return { repoRoot, projectRoot, catalogRoot, catalogPath, activeTrack, skills, publicEntrypointNames: (catalog.publicEntrypoints || []).map((entry) => entry.name) };
};

const publicView = (skill) => ({
  name: skill.name,
  exposure: skill.exposure,
  stage: skill.stage,
  ownerCluster: skill.ownerCluster,
  description: skill.description,
  triggers: skill.triggers,
  references: skill.references,
  headings: skill.headings,
  tokenEstimate: skill.tokenEstimate,
  contentHash: skill.contentHash,
});

export const searchSkills = async (query, options = {}) => {
  const { skills } = await loadSkillCatalog(options);
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const results = skills
    .filter((skill) => !options.stage || skill.stage === options.stage)
    .map((skill) => {
      const haystack = [
        skill.name,
        skill.exposure,
        skill.stage,
        skill.ownerCluster,
        skill.description,
        ...skill.triggers,
        ...skill.headings,
      ].join(' ').toLowerCase();
      const score = terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0);
      return { skill, score };
    })
    .filter((entry) => terms.length === 0 || entry.score > 0)
    .sort((left, right) => right.score - left.score || left.skill.name.localeCompare(right.skill.name))
    .slice(0, options.limit || 12)
    .map((entry) => ({ ...publicView(entry.skill), score: entry.score }));
  return {
    schemaVersion: 'moonshot-skill-router.v1',
    status: 'pass',
    command: 'search',
    query,
    results,
  };
};

export const inspectSkill = async (name, options = {}) => {
  const { skills } = await loadSkillCatalog(options);
  const skill = skills.find((entry) => entry.name === name);
  if (!skill) {
    return { schemaVersion: 'moonshot-skill-router.v1', status: 'fail', command: 'inspect', findings: [{ severity: 'blocking', code: 'skill.not_found', message: `Unknown skill: ${name}` }] };
  }
  return {
    schemaVersion: 'moonshot-skill-router.v1',
    status: 'pass',
    command: 'inspect',
    skill: publicView(skill),
  };
};

export const resolveExplicitSkillInvocation = async (invocation, options = {}) => {
  const requested = String(invocation || '').trim().replace(/^\$/, '');
  const { skills, activeTrack } = await loadSkillCatalog(options);
  const skill = skills.find((entry) => entry.name === requested && entry.exposure === 'public');
  if (!skill) {
    const isKernelTarget = requested.includes('kernel') || requested.startsWith('kernel');
    const errCode = (activeTrack === 'relay' && isKernelTarget) ? 'wrong_harness' : 'skill.public_invocation_not_found';
    return {
      schemaVersion: 'moonshot-skill-router.v1',
      status: 'fail',
      command: 'resolve-explicit',
      evaluatorId: 'public-surface-explicit.v1',
      selected: '',
      rerouted: false,
      findings: [{
        severity: 'blocking',
        code: errCode,
        message: `Unknown public skill invocation: ${invocation}`,
      }],
    };
  }
  return { schemaVersion: 'moonshot-skill-router.v1', status: 'pass', command: 'resolve-explicit', evaluatorId: 'public-surface-explicit.v1', selected: skill.name, rerouted: false };
};

const routeView = (skill, mode, reasonCodes) => ({
  selectedEntrypoint: skill.name,
  stage: skill.stage,
  engineRoute: skill.routeMetadata.engineRoute,
  invocationMode: mode,
  requiredNow: [],
  conditionalSkillGroups: skill.routeMetadata.conditionalSkillGroups,
  referenceIds: skill.references.slice(1),
  reasonCodes,
});

const routeScore = (skill, task) => {
  const terms = String(task || '').toLowerCase().split(/\s+/).filter(Boolean);
  const fields = [skill.name, skill.description, ...skill.triggers].join(' ').toLowerCase();
  const matched = terms.filter((term) => fields.includes(term));
  return { score: matched.length, matched };
};

export const routeSkill = async (task, options = {}) => {
  const request = String(task || '').trim();
  const { repoRoot, skills, publicEntrypointNames, activeTrack } = await loadSkillCatalog(options);
  const publicSkills = skills.filter((skill) => skill.exposure === 'public');
  const invalidMetadata = publicSkills.find((skill) => (
    !skill.routeMetadata?.engineRoute
    || !['user_or_model', 'user_preferred'].includes(skill.routeMetadata?.invocationMode)
    || skill.routeMetadata.allowedStages.length === 0
  ));
  if (invalidMetadata) {
    return { schemaVersion: routeSchemaVersion, status: 'fail', command: 'route', findings: [blockingFinding('route.metadata_invalid', `Public skill routing metadata is incomplete: ${invalidMetadata.name}`)] };
  }
  if (activeTrack === 'relay') {
    try {
      const runtimeSurface = await readJson(path.join(repoRoot, 'package', 'runtime-surface.json'));
      if (JSON.stringify(publicEntrypointNames) !== JSON.stringify(runtimeSurface.publicRuntimeSkills || [])) {
        return { schemaVersion: routeSchemaVersion, status: 'fail', command: 'route', findings: [blockingFinding('route.public_surface_drift', 'Catalog public entrypoints do not match the ordered runtime surface.')] };
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  if (request.startsWith('$')) {
    const requested = request.slice(1).split(/\s+/, 1)[0];
    const skill = publicSkills.find((entry) => entry.name === requested);
    if (!skill) {
      const errCode = (activeTrack === 'relay' && (requested.includes('kernel') || requested === 'moon-relay-kernel'))
        ? 'wrong_harness'
        : 'route.explicit_public_skill_not_found';
      return { schemaVersion: routeSchemaVersion, status: 'fail', command: 'route', findings: [blockingFinding(errCode, `Unknown public skill invocation: $${requested}`)] };
    }
    return { schemaVersion: routeSchemaVersion, status: 'pass', command: 'route', route: routeView(skill, 'explicit', ['explicit_exact_match']) };
  }
  const candidates = publicSkills
    .filter((skill) => skill.routeMetadata?.invocationMode === 'user_or_model')
    .filter((skill) => !options.stage || skill.routeMetadata.allowedStages.includes(options.stage))
    .map((skill) => ({ skill, ...routeScore(skill, request) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.skill.name.localeCompare(right.skill.name));
  if (candidates.length === 0) {
    return { schemaVersion: routeSchemaVersion, status: 'fail', command: 'route', findings: [blockingFinding('route.no_match', 'No implicit public skill route matched the task metadata.')] };
  }
  const selected = candidates[0];
  return {
    schemaVersion: routeSchemaVersion,
    status: 'pass',
    command: 'route',
    route: routeView(selected.skill, 'implicit', [
      'implicit_metadata_match',
      ...selected.matched.map((term) => `term:${term}`),
    ]),
  };
};

export const loadSkillReference = async (skillName, referenceId, options = {}) => {
  const { repoRoot, skills } = await loadSkillCatalog(options);
  const skill = skills.find((entry) => entry.name === skillName);
  const fail = (code, message) => ({ schemaVersion: referenceSchemaVersion, status: 'fail', command: 'load-reference', findings: [blockingFinding(code, message)] });
  if (!skill) return fail('reference.skill_not_found', `Unknown skill: ${skillName}`);
  if (skill.invalidDeepReferences.length > 0) return fail('reference.path_escape', `Skill ${skillName} declares an unsafe deep reference.`);
  const normalized = normalizeDeepReference(skillName, referenceId);
  if (normalized.status === 'fail') return fail(normalized.code, `Unsafe reference path: ${referenceId}`);
  if (!skill.references.slice(1).includes(normalized.referenceId)) {
    return fail('reference.not_declared', `Reference is not declared by ${skillName}: ${referenceId}`);
  }
  const lexicalRoot = path.resolve(repoRoot, normalized.allowedPrefix);
  const lexicalTarget = path.resolve(repoRoot, normalized.referenceId);
  if (!isWithin(lexicalRoot, lexicalTarget)) return fail('reference.path_escape', `Reference escapes its canonical root: ${referenceId}`);
  let actualRoot;
  let actualTarget;
  let actualRepoRoot;
  try {
    [actualRepoRoot, actualRoot, actualTarget] = await Promise.all([realpath(repoRoot), realpath(lexicalRoot), realpath(lexicalTarget)]);
  } catch {
    return fail('reference.not_found', `Declared reference does not exist: ${normalized.referenceId}`);
  }
  if (!isWithin(actualRepoRoot, actualRoot) || !isWithin(actualRoot, actualTarget)) {
    return fail('reference.symlink_escape', `Reference resolves outside its canonical root: ${normalized.referenceId}`);
  }
  const text = await readFile(actualTarget, 'utf8');
  const contentHash = createHash('sha256').update(text).digest('hex').slice(0, 16);
  if (options.contentHash && options.contentHash !== contentHash) return fail('reference.hash_drift', `Reference content hash changed: ${normalized.referenceId}`);
  if (options.locale && options.locale !== 'source') return fail('reference.locale_drift', `Unsupported reference locale: ${options.locale}`);
  const sanitized = sanitizePromptBlock(text);
  return {
    schemaVersion: referenceSchemaVersion,
    status: 'pass',
    command: 'load-reference',
    skill: skillName,
    referenceId: normalized.referenceId,
    contentHash,
    promptSafety: { status: sanitized.redactedLineCount === 0 ? 'pass' : 'redacted', redactedLineCount: sanitized.redactedLineCount },
    promptBlock: sanitized.promptBlock,
  };
};

export const loadSkill = async (name, options = {}) => {
  const { skills } = await loadSkillCatalog(options);
  const skill = skills.find((entry) => entry.name === name);
  if (!skill) {
    return { schemaVersion: 'moonshot-skill-router.v1', status: 'fail', command: 'load', findings: [{ severity: 'blocking', code: 'skill.not_found', message: `Unknown skill: ${name}` }] };
  }
  const sanitized = sanitizePromptBlock(skill.text);
  return {
    schemaVersion: 'moonshot-skill-router.v1',
    status: 'pass',
    command: 'load',
    task: options.task || '',
    skill: publicView(skill),
    promptSafety: {
      status: sanitized.redactedLineCount === 0 ? 'pass' : 'redacted',
      redactedLineCount: sanitized.redactedLineCount,
    },
    promptBlock: sanitized.promptBlock,
  };
};

const parseArgs = (argv) => {
  const options = { json: false };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      options.json = true;
    } else if (arg === '--repo-root') {
      options.repoRoot = path.resolve(argv[++index]);
    } else if (arg === '--catalog') {
      options.catalogPath = path.resolve(argv[++index]);
    } else if (arg === '--track') {
      options.track = argv[++index];
    } else if (arg === '--stage') {
      options.stage = argv[++index];
    } else if (arg === '--limit') {
      options.limit = Number(argv[++index]);
    } else if (arg === '--task') {
      options.task = argv[++index];
    } else if (arg === '--skill') {
      options.skill = argv[++index];
    } else if (arg === '--content-hash') {
      options.contentHash = argv[++index];
    } else if (arg === '--locale') {
      options.locale = argv[++index];
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node scripts/skill-router.mjs <search|inspect|load|route|load-reference> <query-or-skill-or-reference> [--json] [--stage <stage>] [--task <text>] [--skill <name>] [--track <kernel|relay>]');
      process.exit(0);
    } else {
      positional.push(arg);
    }
  }
  return { command: positional[0], value: positional.slice(1).join(' '), options };
};

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const { command, value, options } = parseArgs(process.argv.slice(2));
  const run = command === 'search'
    ? searchSkills(value, options)
    : command === 'inspect'
      ? inspectSkill(value, options)
      : command === 'load'
        ? loadSkill(value, options)
        : command === 'route'
          ? routeSkill(options.task || value, options)
          : command === 'load-reference'
            ? loadSkillReference(options.skill, value, options)
            : Promise.resolve({ schemaVersion: 'moonshot-skill-router.v1', status: 'fail', command: command || '', findings: [{ severity: 'blocking', code: 'router.unknown_command', message: 'Expected search, inspect, or load.' }] });

  run.then((result) => {
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else if (result.status === 'pass') {
      console.log(`${result.command}: ${result.skill?.name || result.skill || result.route?.selectedEntrypoint || (result.results ? `${result.results.length} result(s)` : 'pass')}`);
    } else {
      console.error(result.findings.map((item) => item.message).join('\n'));
    }
    process.exit(result.status === 'pass' ? 0 : 2);
  }).catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
