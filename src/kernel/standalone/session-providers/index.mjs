import * as codex from './codex.mjs';
import * as claude from './claude.mjs';

export const providers = { codex, claude };
export const providerFor = (provider) => providers[String(provider || '').toLowerCase()] || null;
