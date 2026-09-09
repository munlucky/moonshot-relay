export const SWITCHER_PRODUCT_ID = 'moon-harness-switcher';
export const SWITCHER_SCHEMA_VERSION = 1;
export const KERNEL_RUNTIME_ID = 'moon-relay-kernel';
export const SURFACES = ['claude_desktop', 'claude_cli', 'codex_cli', 'codex_desktop', 'qwen_cli', 'ade_cli', 'antigravity_desktop'];
export const GUI_SURFACES = new Set(['claude_desktop', 'codex_desktop', 'antigravity_desktop']);
export const ERROR_CODES = Object.freeze([
  'process_active', 'wrong_harness', 'application_not_resolved', 'login_required',
  'journal_recovery_required', 'unsafe_target', 'target_collision', 'shared_mutable_surface',
  'close_incomplete', 'kernel_not_installed', 'operator_approval_missing', 'lease_conflict',
  'relay_track_retired',
]);
export const SURFACE_ENV = Object.freeze({
  claude_desktop: 'CLAUDE_CONFIG_DIR',
  claude_cli: 'CLAUDE_CONFIG_DIR',
  codex_cli: 'CODEX_HOME',
  codex_desktop: 'CODEX_HOME',
  qwen_cli: 'QWEN_HOME',
  ade_cli: 'ADE_HOME',
  antigravity_desktop: 'ANTIGRAVITY_HOME',
});
export const makeId = (prefix = 'receipt') => `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
