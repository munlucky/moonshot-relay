// Trusted command catalog (§11.3, P1-4). A command is executable by the Kernel
// only when it is *declared by the project itself* — an npm script, a Makefile
// target, or the canonical task command of a detected ecosystem manifest.
//
// Every discovered command also carries a semantic class. That class is what
// binds an obligation (`unit-test`) to the commands that may satisfy it, so a
// model cannot satisfy `unit-test` by running a `noop` script (P0-2).

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const COMMAND_CLASSES = Object.freeze([
  'unit-test',
  'integration-test',
  'e2e',
  'static-analysis',
  'build',
  'runtime-reproduction',
  'runtime-observation',
  'deployment',
  'post-deployment-observation',
  'script',
]);

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

const readText = (file) => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

// Name-based classification. The name is authored by the project, not by the
// model reporting the run, so it is a trustworthy binding surface. A name that
// matches nothing is a plain `script` and can never satisfy a typed obligation.
export const classifyCommandName = (name = '', body = '') => {
  const value = `${name}`.toLowerCase();
  const script = `${body}`.toLowerCase();
  const matches = (pattern) => pattern.test(value) || pattern.test(script);

  if (/(^|[:\-_/])(post-deploy|post-deployment)([:\-_/])(observe|observation|check|verify)([:\-_/]|$)/.test(value)) return 'post-deployment-observation';
  if (/(^|[:\-_/])(runtime)([:\-_/])(reproduce|reproduction)([:\-_/]|$)/.test(value)) return 'runtime-reproduction';
  if (/(^|[:\-_/])(runtime)([:\-_/])(observe|observation)([:\-_/]|$)/.test(value)) return 'runtime-observation';
  if (/(^|[:\-_/])(deploy|deployment|release|publish)([:\-_/]|$)/.test(value)) return 'deployment';
  if (/(^|[:\-_/])(e2e|browser|playwright|cypress|selenium|webdriver)([:\-_/]|$)/.test(value)) return 'e2e';
  if (/(^|[:\-_/])(integration|api-test|contract-test|smoke)([:\-_/]|$)/.test(value)) return 'integration-test';
  if (/^(test|tests|spec|jest|vitest|mocha|pytest|unit)([:\-_/]|$)/.test(value)) return 'unit-test';
  if (/(^|[:\-_/])(unit|regression)([:\-_/]|$)/.test(value)) return 'unit-test';
  if (/^(lint|typecheck|tsc|check|static|analyze|analysis|vet|clippy|mypy|ruff|flake8|audit|format:check|fmt:check)([:\-_/]|$)/.test(value)) return 'static-analysis';
  if (/(^|[:\-_/])(lint|typecheck|static-analysis)([:\-_/]|$)/.test(value)) return 'static-analysis';
  if (/^(build|compile|bundle|package|dist)([:\-_/]|$)/.test(value)) return 'build';
  // Fall back to the script body only for the strongest signals; a body that
  // merely mentions "test" in a comment must not promote a `noop` script.
  if (matches(/\b(jest|vitest|mocha|pytest|go test|cargo test)\b/)) return 'unit-test';
  return 'script';
};

const nodeCommands = (projectRoot) => {
  const manifest = readJson(path.join(projectRoot, 'package.json'));
  if (!manifest) return [];
  const runner = existsSync(path.join(projectRoot, 'pnpm-lock.yaml'))
    ? 'pnpm'
    : existsSync(path.join(projectRoot, 'yarn.lock')) ? 'yarn' : 'npm';
  const scripts = manifest.scripts && typeof manifest.scripts === 'object' ? manifest.scripts : {};
  const commands = Object.entries(scripts)
    .filter(([, body]) => typeof body === 'string')
    .map(([name, body]) => ({
      commandRef: name,
      commandClass: classifyCommandName(name, body),
      command: runner,
      args: runner === 'yarn' ? [name] : ['run', name],
      ecosystem: 'node',
      source: 'package.json',
      declaration: body,
    }));
  const dependencySections = [
    manifest.dependencies,
    manifest.devDependencies,
    manifest.optionalDependencies,
    manifest.peerDependencies,
  ];
  const hasTypeScriptDependency = dependencySections.some((section) => (
    section && typeof section === 'object' && typeof section.typescript === 'string'
  ));
  const hasTypeScriptConfig = existsSync(path.join(projectRoot, 'tsconfig.json'));
  const hasDeclaredTypeScriptCheck = commands.some(({ commandRef }) => /^(?:typecheck|tsc)(?::|$)/i.test(commandRef));
  const localTypeScriptBinary = [
    path.join(projectRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc'),
    path.join(projectRoot, 'node_modules', '.bin', 'tsc'),
  ].find((candidate) => existsSync(candidate));
  if (hasTypeScriptDependency && hasTypeScriptConfig && !hasDeclaredTypeScriptCheck && localTypeScriptBinary) {
    const relativeBinary = path.relative(projectRoot, localTypeScriptBinary).replaceAll('\\', '/');
    commands.push({
      commandRef: 'typescript:check',
      commandClass: 'static-analysis',
      command: relativeBinary,
      args: ['--noEmit'],
      ecosystem: 'node',
      source: 'package.json+tsconfig.json+node_modules/.bin/tsc',
      declaration: `${relativeBinary} --noEmit`,
    });
  }
  return commands;
};

// Canonical ecosystem commands. These are not invented by the Kernel: each is
// the standard task entrypoint the manifest itself implies.
const CANONICAL_COMMANDS = Object.freeze([
  {
    manifest: 'go.mod',
    ecosystem: 'go',
    commands: [
      { commandRef: 'go:test', commandClass: 'unit-test', command: 'go', args: ['test', './...'] },
      { commandRef: 'go:vet', commandClass: 'static-analysis', command: 'go', args: ['vet', './...'] },
      { commandRef: 'go:build', commandClass: 'build', command: 'go', args: ['build', './...'] },
    ],
  },
  {
    manifest: 'Cargo.toml',
    ecosystem: 'rust',
    commands: [
      { commandRef: 'cargo:test', commandClass: 'unit-test', command: 'cargo', args: ['test'] },
      { commandRef: 'cargo:clippy', commandClass: 'static-analysis', command: 'cargo', args: ['clippy', '--all-targets'] },
      { commandRef: 'cargo:build', commandClass: 'build', command: 'cargo', args: ['build'] },
    ],
  },
  {
    manifest: 'pyproject.toml',
    ecosystem: 'python',
    commands: [
      { commandRef: 'pytest', commandClass: 'unit-test', command: 'pytest', args: ['-q'] },
      { commandRef: 'python:mypy', commandClass: 'static-analysis', command: 'mypy', args: ['.'] },
      { commandRef: 'python:ruff', commandClass: 'static-analysis', command: 'ruff', args: ['check', '.'] },
    ],
  },
  {
    manifest: 'setup.py',
    ecosystem: 'python',
    commands: [
      { commandRef: 'pytest', commandClass: 'unit-test', command: 'pytest', args: ['-q'] },
    ],
  },
  {
    manifest: 'pom.xml',
    ecosystem: 'java',
    commands: [
      { commandRef: 'maven:test', commandClass: 'unit-test', command: 'mvn', args: ['-q', 'test'] },
      { commandRef: 'maven:verify', commandClass: 'integration-test', command: 'mvn', args: ['-q', 'verify'] },
    ],
  },
  {
    manifest: 'build.gradle',
    ecosystem: 'java',
    commands: [
      { commandRef: 'gradle:test', commandClass: 'unit-test', command: 'gradle', args: ['test'] },
      { commandRef: 'gradle:check', commandClass: 'static-analysis', command: 'gradle', args: ['check'] },
    ],
  },
]);

const MAKE_TARGET_REGEX = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*:(?!=)/;

const makeCommands = (projectRoot) => {
  const makefile = ['Makefile', 'makefile', 'GNUmakefile']
    .map((name) => path.join(projectRoot, name))
    .find((file) => existsSync(file));
  if (!makefile) return [];
  const text = readText(makefile);
  if (!text) return [];
  const targets = new Set();
  for (const line of text.split(/\r?\n/)) {
    if (/^\s/.test(line) || line.startsWith('#') || line.startsWith('.')) continue;
    const match = line.match(MAKE_TARGET_REGEX);
    if (match) targets.add(match[1]);
  }
  return [...targets].map((target) => ({
    commandRef: `make:${target}`,
    commandClass: classifyCommandName(target),
    command: 'make',
    args: [target],
    ecosystem: 'make',
    source: path.basename(makefile),
    declaration: `make ${target}`,
  }));
};

// Every command the Kernel is allowed to execute in this project, with the
// semantic class each one can prove.
export const discoverProjectCommands = ({ projectRoot = process.cwd() } = {}) => {
  const commands = [...nodeCommands(projectRoot)];
  for (const entry of CANONICAL_COMMANDS) {
    if (!existsSync(path.join(projectRoot, entry.manifest))) continue;
    for (const command of entry.commands) {
      commands.push({ ...command, ecosystem: entry.ecosystem, source: entry.manifest, declaration: `${command.command} ${command.args.join(' ')}` });
    }
  }
  commands.push(...makeCommands(projectRoot));

  const seen = new Set();
  const unique = [];
  for (const command of commands) {
    if (seen.has(command.commandRef)) continue;
    seen.add(command.commandRef);
    unique.push(command);
  }
  return unique;
};

export const findProjectCommand = ({ projectRoot = process.cwd(), commandRef } = {}) =>
  discoverProjectCommands({ projectRoot }).find((command) => command.commandRef === commandRef) || null;

// Command refs in this project that can satisfy any of the given classes.
export const commandRefsForClasses = ({ projectRoot = process.cwd(), classes = [], commands = null } = {}) => {
  const allowed = new Set(classes);
  return (commands || discoverProjectCommands({ projectRoot }))
    .filter((command) => allowed.has(command.commandClass))
    .map((command) => command.commandRef);
};

export const ecosystemsForProject = ({ projectRoot = process.cwd(), commands = null } = {}) =>
  [...new Set((commands || discoverProjectCommands({ projectRoot })).map((command) => command.ecosystem))];
