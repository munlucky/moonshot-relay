// Canonical project-command contract (§11.3, P1-4).
//
// Host owns project declaration observation. This module normalizes those
// declarations into provider-neutral command records. Trust still decides
// which semantic command classes and refs may satisfy a proof obligation.

import type {
  ProjectCommand,
  ProjectCommandDeclarationObservation,
} from './project-command.js';

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
] as const);

export type CommandClass = typeof COMMAND_CLASSES[number];

export const classifyCommandName = (
  name: unknown = '',
  body: unknown = '',
): CommandClass => {
  const value = String(name).toLowerCase();
  const script = String(body).toLowerCase();
  const matches = (pattern: RegExp): boolean => pattern.test(value) || pattern.test(script);

  if (/(^|[:\-_/])(post-deploy|post-deployment)([:\-_/])(observe|observation|check|verify)([:\-_/]|$)/u.test(value)) return 'post-deployment-observation';
  if (/(^|[:\-_/])(runtime)([:\-_/])(reproduce|reproduction)([:\-_/]|$)/u.test(value)) return 'runtime-reproduction';
  if (/(^|[:\-_/])(runtime)([:\-_/])(observe|observation)([:\-_/]|$)/u.test(value)) return 'runtime-observation';
  if (/(^|[:\-_/])(deploy|deployment|release|publish)([:\-_/]|$)/u.test(value)) return 'deployment';
  if (/(^|[:\-_/])(e2e|browser|playwright|cypress|selenium|webdriver)([:\-_/]|$)/u.test(value)) return 'e2e';
  if (/(^|[:\-_/])(integration|api-test|contract-test|smoke)([:\-_/]|$)/u.test(value)) return 'integration-test';
  if (/^(test|tests|spec|jest|vitest|mocha|pytest|unit)([:\-_/]|$)/u.test(value)) return 'unit-test';
  if (/(^|[:\-_/])(unit|regression)([:\-_/]|$)/u.test(value)) return 'unit-test';
  if (/^(lint|typecheck|tsc|check|static|analyze|analysis|vet|clippy|mypy|ruff|flake8|audit|format:check|fmt:check)([:\-_/]|$)/u.test(value)) return 'static-analysis';
  if (/(^|[:\-_/])(lint|typecheck|static-analysis)([:\-_/]|$)/u.test(value)) return 'static-analysis';
  if (/^(build|compile|bundle|package|dist)([:\-_/]|$)/u.test(value)) return 'build';
  if (matches(/\b(jest|vitest|mocha|pytest|go test|cargo test)\b/u)) return 'unit-test';
  return 'script';
};

interface CanonicalCommandSet {
  manifest: string;
  ecosystem: string;
  commands: Array<{
    commandRef: string;
    commandClass: CommandClass;
    command: string;
    args: string[];
  }>;
}

const CANONICAL_COMMANDS: readonly CanonicalCommandSet[] = Object.freeze([
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

const nodeCommands = (
  observation: ProjectCommandDeclarationObservation,
): ProjectCommand[] => {
  const node = observation.node;
  if (!node) return [];

  const commands: ProjectCommand[] = Object.entries(node.scripts).map(([name, body]) => ({
    commandRef: name,
    commandClass: classifyCommandName(name, body),
    command: node.runner,
    args: node.runner === 'yarn' ? [name] : ['run', name],
    ecosystem: 'node',
    source: 'package.json',
    declaration: body,
  }));

  const hasDeclaredTypeScriptCheck = commands.some(({ commandRef }) => (
    /^(?:typecheck|tsc)(?::|$)/iu.test(commandRef)
  ));
  if (
    node.hasTypeScriptDependency
    && node.hasTypeScriptConfig
    && !hasDeclaredTypeScriptCheck
    && node.localTypeScriptBinary
  ) {
    commands.push({
      commandRef: 'typescript:check',
      commandClass: 'static-analysis',
      command: 'node',
      args: [node.localTypeScriptBinary, '--noEmit'],
      ecosystem: 'node',
      source: 'package.json+tsconfig.json+typescript package bin',
      declaration: `node ${node.localTypeScriptBinary} --noEmit`,
    });
  }

  return commands;
};

const canonicalCommands = (
  observation: ProjectCommandDeclarationObservation,
): ProjectCommand[] => {
  const manifests = new Set(observation.manifests);
  return CANONICAL_COMMANDS.flatMap((entry) => (
    manifests.has(entry.manifest)
      ? entry.commands.map((command) => ({
          ...command,
          ecosystem: entry.ecosystem,
          source: entry.manifest,
          declaration: `${command.command} ${command.args.join(' ')}`,
        }))
      : []
  ));
};

const makeCommands = (
  observation: ProjectCommandDeclarationObservation,
): ProjectCommand[] => (
  observation.make
    ? observation.make.targets.map((target) => ({
        commandRef: `make:${target}`,
        commandClass: classifyCommandName(target),
        command: 'make',
        args: [target],
        ecosystem: 'make',
        source: observation.make?.source || 'Makefile',
        declaration: `make ${target}`,
      }))
    : []
);

export const discoverProjectCommands = ({
  observation,
}: {
  observation?: ProjectCommandDeclarationObservation | null;
} = {}): ProjectCommand[] => {
  if (!observation) return [];

  const commands = [
    ...nodeCommands(observation),
    ...canonicalCommands(observation),
    ...makeCommands(observation),
  ];
  const seen = new Set<string>();
  const unique: ProjectCommand[] = [];
  for (const command of commands) {
    if (seen.has(command.commandRef)) continue;
    seen.add(command.commandRef);
    unique.push(command);
  }
  return unique;
};

export const findProjectCommand = ({
  commands = [],
  commandRef,
}: {
  commands?: readonly ProjectCommand[];
  commandRef?: unknown;
} = {}): ProjectCommand | null => (
  commands.find((command) => command.commandRef === String(commandRef || '')) || null
);

export const commandRefsForClasses = ({
  classes = [],
  commands = [],
}: {
  classes?: readonly string[];
  commands?: readonly ProjectCommand[];
} = {}): string[] => {
  const allowed = new Set(classes.map(String));
  return commands
    .filter((command) => allowed.has(command.commandClass))
    .map((command) => command.commandRef);
};

export const ecosystemsForProject = ({
  commands = [],
}: {
  commands?: readonly ProjectCommand[];
} = {}): string[] => (
  [...new Set(commands.map((command) => command.ecosystem))]
);
