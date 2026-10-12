import test from 'node:test';
import assert from 'node:assert/strict';
import { detectClaudeOutputArtifacts, stripClaudeOutputArtifacts, canExecuteAsToolCall } from '../src/host/kernel/prompts/claude-opus-5.js';

test('a tool call rendered as text is detected', () => {
  const output = 'Here is the change.\n<invoke name="edit_file">\n<parameter name="path">a.js</parameter>\n</invoke>';
  assert.ok(detectClaudeOutputArtifacts(output).includes('text-tool-call'));
});

test('text that looks like a tool call is never promoted to a real one', () => {
  // The single most important guard here: prose must not become an action.
  assert.equal(canExecuteAsToolCall('<invoke name="edit_file">'), false);
  assert.equal(canExecuteAsToolCall(), false);
});

test('system and thinking tags are detected and stripped', () => {
  const output = '<system-reminder>internal</system-reminder>Result: done.';
  assert.ok(detectClaudeOutputArtifacts(output).includes('system-xml-tag'));
  assert.equal(stripClaudeOutputArtifacts(output), 'internalResult: done.');
});

test('a reasoning transcript preamble is detected', () => {
  assert.ok(detectClaudeOutputArtifacts('Let me think about this first\nchangedPaths: []').includes('reasoning-transcript'));
});

test('clean structured output is left untouched', () => {
  const clean = 'capsuleId: capsule-1\nsummary: added segments\nchangedPaths:\n  - scripts/kernel/context-segments.mjs';
  assert.deepEqual(detectClaudeOutputArtifacts(clean), []);
  assert.equal(stripClaudeOutputArtifacts(clean), clean);
});

test('detection is repeatable across calls', () => {
  // The patterns are global regexes; a stale lastIndex would make the second
  // call disagree with the first.
  const output = '<invoke name="edit_file">';
  assert.deepEqual(detectClaudeOutputArtifacts(output), detectClaudeOutputArtifacts(output));
});
