#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { runFromFixture } from '../../scripts/provider-model-route-advisor.mjs';

const usage = () => 'Usage: node tools/evals/provider-model-routing.js run --fixture-root <dir> [--json]';

const parseArgs = (argv) => {
  const [command = 'run'] = argv;
  const options = { command, fixtureRoot: '', json: false };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') options.json = true;
    else if (arg === '--fixture-root') options.fixtureRoot = argv[++index] || '';
    else if (arg.startsWith('--')) options[arg.slice(2)] = argv[++index] || '';
    else throw new Error(`Unknown argument: ${arg}\n${usage()}`);
  }
  return options;
};

export async function evaluateProviderRoutingFixture(fixturePath, { evidenceOut = '' } = {}) {
  const result = await runFromFixture(fixturePath, { evidenceOut });
  const distinctUsage = result.items.every((item) => (
    Object.hasOwn(item.usage, 'estimatedInputTokens')
    && Object.hasOwn(item.usage, 'actualInputTokens')
    && Object.hasOwn(item.usage, 'verificationVerdict')
    && Object.hasOwn(item.usage, 'userAcceptance')
    && item.usage.actualInputTokens === null
    && item.usage.actualCredits === null
    && item.usage.retryCredits === null
  ));
  const pairedManifest = result.calibration.evaluationManifest;
  const automaticRoutingDisabled = result.calibration.automaticRoutingEligible === false;
  const exactCodexProfiles = ['gpt-5.6-luna:high', 'gpt-5.6-luna:xhigh', 'gpt-5.6-terra:high', 'gpt-5.6-sol:high'];
  const declaredCodexProfiles = pairedManifest.candidateProfilesByProvider?.codex || [];
  const pairedManifestDeclared = declaredCodexProfiles.length === exactCodexProfiles.length
    && declaredCodexProfiles.every((profile, index) => profile === exactCodexProfiles[index])
    && pairedManifest.sampleCount === result.items.length
    && Object.hasOwn(pairedManifest, 'nonInferiorityMargin')
    && Object.hasOwn(pairedManifest, 'creditCeiling');
  const modelBackedEvaluationReady = pairedManifest.evaluationReadiness === 'model_backed'
    && pairedManifest.repetitions > 0
    && pairedManifest.modelBackedRuns === 'complete';
  const noMutation = result.hostMutation.performed === false
    && result.items.every((item) => item.hostMutation.performed === false);
  const status = result.promotionDecision === 'shadow_only'
    && result.reasonCoverage >= 0.95
    && distinctUsage
    && automaticRoutingDisabled
    && pairedManifestDeclared
    && noMutation
    ? 'pass'
    : 'fail';
  return {
    schemaVersion: 1,
    status,
    suite: 'provider-model-routing-shadow',
    promotionDecision: result.promotionDecision,
    reasonCoverage: result.reasonCoverage,
    distinctUsage,
    automaticRoutingDisabled,
    pairedManifestDeclared,
    modelBackedEvaluationReady,
    evaluationManifest: pairedManifest,
    noMutation,
    itemCount: result.items.length,
    results: result.items.map((item) => ({
      id: item.id,
      provider: item.provider,
      applicationMode: item.decision.applicationMode,
      contextAction: item.decision.contextAction,
      usage: item.usage,
    })),
  };
}

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === '--help' || options.command === '-h') {
    console.log(usage());
    return;
  }
  if (options.command !== 'run' || !options.fixtureRoot) throw new Error(usage());
  const fixturePath = path.join(path.resolve(options.fixtureRoot), 'shadow-corpus.json');
  const result = await evaluateProviderRoutingFixture(fixturePath, { evidenceOut: options['evidence-out'] || '' });
  console.log(options.json ? JSON.stringify(result, null, 2) : result.status);
  if (result.status !== 'pass') process.exitCode = 1;
};

if (import.meta.url === `file://${process.argv[1]?.replaceAll('\\', '/')}` || process.argv[1]?.endsWith('provider-model-routing.js')) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
