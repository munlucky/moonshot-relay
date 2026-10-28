import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '../..');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));

// No cached result is read. Missing inputs and changed reviewed source fail closed.
export function fingerprintFiles(files, configuration, environment) {
  const inputs = Object.entries(files).sort(([a], [b]) => a.localeCompare(b))
    .map(([name, file]) => ({ name, sha256: hash(fs.readFileSync(file)) }));
  return { inputs, configuration, environment, digest: hash(JSON.stringify({ inputs, configuration, environment })) };
}

export function assertSourceBinding(root, binding) {
  for (const { file, sha256 } of binding.files) {
    if (hash(fs.readFileSync(path.join(root, file))) !== sha256) {
      throw new Error(`SOURCE_CORRESPONDENCE_STALE: review ${file} against Fencing.tla before updating fencing-source.json`);
    }
  }
}

export function classifyTlc(run, invariants) {
  const log = `${run.stdout || ''}\n${run.stderr || ''}`;
  if (run.error || run.signal) return { status: 'INCOMPLETE', violated: null };
  const violated = log.match(/Invariant (\w+) is violated/);
  if (run.status === 12 && violated && invariants.includes(violated[1])
    && log.includes('The behavior up to this point is:')) {
    return { status: 'VIOLATION', violated: violated[1] };
  }
  if (run.status === 0 && !violated && log.includes('Model checking completed. No error has been found.')) {
    return { status: 'PASS', violated: null };
  }
  return { status: 'INCOMPLETE', violated: null };
}

function observeJava(java) {
  const observation = spawnSync(java, ['-XshowSettings:properties', '-version'], {
    encoding: 'utf8', timeout: 10000, windowsHide: true,
  });
  if (observation.error || observation.status !== 0) throw new Error('JAVA_UNAVAILABLE');
  const version = `${observation.stdout || ''}\n${observation.stderr || ''}`;
  const home = version.match(/^\s*java.home = (.+)$/m)?.[1]?.trim();
  if (!home) throw new Error('JAVA_HOME_UNOBSERVED');
  const binary = fs.realpathSync(path.join(home, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'));
  return {
    javaCommand: java, javaBinary: binary, javaSha256: hash(fs.readFileSync(binary)),
    javaVersion: version.match(/(?:openjdk|java) version[^\r\n]*/)?.[0] || version.trim(),
    platform: process.platform, arch: process.arch, nodeVersion: process.version,
    javaOptions: Object.fromEntries(['JAVA_TOOL_OPTIONS', 'JDK_JAVA_OPTIONS', '_JAVA_OPTIONS'].map(key => [key, process.env[key] || ''])),
  };
}

export function runFencing(args = process.argv.slice(2)) {
  const allowedArgs = args.length === 0 || (args.length === 1 && args[0] === '--experiment')
    || (args.length === 2 && args[0] === '--property');
  if (!allowedArgs) throw new Error('Usage: fencing.mjs [--experiment | --property <invariant>]');
  const manifestFile = path.join(here, 'fencing-cases.json');
  const bindingFile = path.join(here, 'fencing-source.json');
  const manifest = readJson(manifestFile);
  const binding = readJson(bindingFile);
  let cases = args[0] === '--experiment' ? manifest.cases
    : manifest.cases.filter(job => manifest.defaultCases.includes(job.id));
  if (args[0] === '--property') {
    const property = args[1];
    if (!manifest.cases.some(job => job.mutant === 'none' && !job.reissue && job.invariants.includes(property))) {
      throw new Error(`UNKNOWN_PROPERTY: ${property}`);
    }
    cases = [{ id: `required-${property}`, kind: 'required-property', mutant: 'none', reissue: false, invariants: [property], expected: 'PASS' }];
  }
  const jar = path.resolve(process.env.TLA2TOOLS_JAR || path.join(projectRoot, '.moonshot-relay/formal/tla2tools.jar'));
  if (hash(fs.readFileSync(jar)) !== manifest.tool.sha256) throw new Error('TLC_TOOL_DIGEST_MISMATCH');
  assertSourceBinding(projectRoot, binding);
  const java = process.env.JAVA || 'java';
  const environment = observeJava(java);
  const files = {
    'model/Fencing.tla': path.join(here, 'Fencing.tla'),
    'configuration/cases.json': manifestFile,
    'configuration/source.json': bindingFile,
    'runner/fencing.mjs': fileURLToPath(import.meta.url),
    'tool/tla2tools.jar': jar,
    'package.json': path.join(projectRoot, 'package.json'),
    'package-lock.json': path.join(projectRoot, 'package-lock.json'),
    ...Object.fromEntries(binding.files.map(({ file }) => [file, path.join(projectRoot, file)])),
  };
  const configuration = { cases, timeoutMs: 300000, heap: '4g', workers: 1, seed: 1 };
  const before = fingerprintFiles(files, configuration, environment);
  const parent = path.resolve(process.env.FORMAL_FENCING_OUT || path.join(projectRoot, '.moonshot-relay/formal/runs'));
  const output = path.join(parent, `${Date.now()}-${crypto.randomUUID()}`);
  fs.mkdirSync(output, { recursive: true });
  fs.copyFileSync(files['model/Fencing.tla'], path.join(output, 'Fencing.tla'));
  const startedAt = new Date().toISOString();
  const results = [];
  for (const job of cases) {
    const cfg = `INIT Init\nNEXT Next\nCONSTANTS\n Mutant = "${job.mutant}"\n Reissue = ${job.reissue ? 'TRUE' : 'FALSE'}\n FailRecovery = TRUE\nINVARIANTS ${job.invariants.join(' ')}\nCHECK_DEADLOCK FALSE\n`;
    fs.writeFileSync(path.join(output, `${job.id}.cfg`), cfg);
    const start = performance.now();
    const run = spawnSync(java, ['-Xmx4g', '-cp', jar, 'tlc2.TLC', '-workers', '1', '-seed', '1',
      '-metadir', path.join(output, `${job.id}-states`), '-config', `${job.id}.cfg`, 'Fencing'], {
      cwd: output, encoding: 'utf8', timeout: configuration.timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true,
    });
    const log = `${run.stdout || ''}\n${run.stderr || ''}`;
    fs.writeFileSync(path.join(output, `${job.id}.log`), log);
    const verdict = classifyTlc(run, job.invariants);
    const stats = log.match(/([\d,]+) states generated, ([\d,]+) distinct states found/);
    const result = {
      ...job, ...verdict, expectationMet: verdict.status === job.expected,
      exitCode: run.status, error: run.error?.code || null, seconds: +( (performance.now() - start) / 1000).toFixed(2),
      generatedStates: stats ? +stats[1].replaceAll(',', '') : null,
      distinctStates: stats ? +stats[2].replaceAll(',', '') : null,
      configSha256: hash(cfg), logSha256: hash(log), log: `${job.id}.log`,
    };
    results.push(result);
    console.log(JSON.stringify({ id: result.id, kind: result.kind, status: result.status, violated: result.violated, expectationMet: result.expectationMet }));
  }
  const after = fingerprintFiles(files, configuration, observeJava(java));
  const stable = before.digest === after.digest;
  const expectationsMet = stable && results.every(result => result.expectationMet);
  const report = {
    schemaVersion: 1, startedAt, finishedAt: new Date().toISOString(), mode: args[0] || 'guards',
    status: expectationsMet ? 'EXPECTATIONS_MET' : 'FAILED', inputsStable: stable,
    evidenceIdentity: before, afterDigest: after.digest, results,
    limits: ['Finite model only; source correspondence is reviewed, not mechanically proved.',
      'Safety4A and Recovery1Mark have counterexamples. EXPECTATIONS_MET does not mean all properties hold.',
      'Safety3 checks validity at final observation, not uninterrupted validity until return.',
      'No prior report is reused. Kernel proof receipts retain completion authority.'],
  };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, inputsStable: stable, output, fingerprint: before.digest }));
  return expectationsMet ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = runFencing(); }
  catch (error) { console.error(JSON.stringify({ status: 'INCOMPLETE', error: error.message })); process.exitCode = 2; }
}
