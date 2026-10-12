import { requiredIndex } from '../../shared/required-index.js';
// ADE/Qwen Code context policy.
//
// Keep provider-specific context controls outside Kernel authority. The owner
// session is only an orchestrator; model-owned work runs in fresh named child
// agents with a prompt ceiling that fits 128k-class services with headroom.

export const ADE_CHILD_PROMPT_TOKEN_LIMIT = 120_000;
export const ADE_MAX_SUBAGENT_DEPTH = 1;

export const ADE_OWNER_SYSTEM_PROMPT = [
  'You are the Moon Relay Kernel ADE owner.',
  'Orchestrate only: call Kernel next/report and dispatch each model-owned action to one fresh named kernel-worker or kernel-reviewer child.',
  'Do not inspect, plan, edit, test, debug, or review repository work in the owner session.',
  'Keep only compact run state; never forward owner or prior-child transcripts.',
  'Kernel alone owns proof and completion.',
].join(' ');

const hasFlag = (args: readonly string[], flag: string): boolean => args.some((arg) => arg === flag || String(arg).startsWith(`${flag}=`));

const stripValueFlag = (args: readonly string[], flag: string): string[] => {
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = String(args[index]);
    if (value === flag) {
      index += 1;
      continue;
    }
    if (value.startsWith(`${flag}=`)) continue;
    result.push(requiredIndex(args, index));
  }
  return result;
};

export const withAdeQwenOwnerArgs = (args: readonly string[] = []): string[] => {
  const incoming = Array.isArray(args) ? [...args] : [];
  const hasSystemPrompt = hasFlag(incoming, '--system-prompt');
  const normalized = stripValueFlag(incoming, '--max-subagent-depth');
  if (!hasSystemPrompt) normalized.push('--system-prompt', ADE_OWNER_SYSTEM_PROMPT);
  normalized.push('--max-subagent-depth', String(ADE_MAX_SUBAGENT_DEPTH));
  return normalized;
};
