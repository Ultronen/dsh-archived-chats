import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { inspectClaudeJsonl, exportClaudeJsonl } from '../lib/interop/claude.js';

const fixture = (name) => readFile(new URL(`./fixtures/interop/${name}`, import.meta.url));

test('inspects Claude user and assistant turns without mutating source bytes', async () => {
  const bytes = await fixture('claude-simple.jsonl');
  const before = Buffer.from(bytes);
  const result = inspectClaudeJsonl(bytes);

  assert.deepEqual(bytes, before);
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].id, 'claude-simple');
  assert.equal(result.sessions[0].workspace.title, '/tmp/project');
  assert.deepEqual(result.sessions[0].messages.map(({ role, content }) => ({ role, content })), [
    { role: 'user', content: 'Hello Claude' },
    { role: 'assistant', content: 'Hello!' },
    { role: 'user', content: 'Second turn' },
    { role: 'assistant', content: 'Second answer' },
  ]);
  assert.ok(result.report.losses.some((loss) => loss.code === 'unsupported-event' && loss.type === 'summary'));
  assert.ok(result.report.losses.some((loss) => loss.code === 'malformed-json'));
  assert.ok(result.report.losses.some((loss) => loss.code === 'optional-field-missing'));
});

test('maps Claude tool use/result pairs and reports attachment references', async () => {
  const result = inspectClaudeJsonl(await fixture('claude-tools.jsonl'));
  assert.equal(result.sessions.length, 1);
  const messages = result.sessions[0].messages;
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[1].role, 'assistant');
  assert.equal(messages[1].toolCall.name, 'Bash');
  assert.deepEqual(messages[1].toolCall.arguments, { command: 'ls' });
  assert.equal(messages[2].role, 'tool');
  assert.equal(messages[2].toolCallId, 'toolu-1');
  assert.equal(messages[2].content, 'README.md\nsrc/');
  assert.equal(messages[3].content, 'I found the files.');
  assert.deepEqual(result.sessions[0].attachments, [{ path: 'attachments/diagram.png', mediaType: 'image/png' }]);
  assert.ok(result.report.warnings.some((warning) => warning.code === 'attachment-references'));
});

test('repeated inspection and export are deterministic', async () => {
  const bytes = await fixture('claude-tools.jsonl');
  assert.deepEqual(inspectClaudeJsonl(bytes), inspectClaudeJsonl(bytes));

  const session = {
    id: 'export-session',
    title: 'Export me',
    workspace: { id: 'workspace-1', title: '/work/repo' },
    messages: [
      { id: 'message-1', role: 'user', content: 'Hi' },
      { id: 'message-2', role: 'assistant', content: 'There' },
      { id: 'message-3', role: 'assistant', content: '', toolCall: { name: 'Bash', arguments: { command: 'ls' } }, toolCallId: 'toolu-1' },
      { id: 'message-4', role: 'tool', content: 'done', toolCallId: 'toolu-1' },
    ],
    attachments: [{ path: 'attachments/diagram.png', mediaType: 'image/png' }],
  };
  const first = exportClaudeJsonl(session);
  const second = exportClaudeJsonl(structuredClone(session));
  assert.deepEqual(first, second);
  assert.ok(first.bytes instanceof Uint8Array);
  const records = new TextDecoder().decode(first.bytes).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(records[0].type, 'system');
  assert.equal(records[0].sessionId, 'export-session');
  assert.deepEqual(records.slice(1).map((record) => record.type), ['user', 'assistant', 'assistant', 'user']);
  assert.ok(first.report.warnings.some((warning) => warning.code === 'native-resume-unsupported'));
  assert.ok(first.report.warnings.some((warning) => warning.code === 'transcript-handoff'));
  assert.ok(first.report.warnings.some((warning) => warning.code === 'attachments-not-included'));
});

test('reports unsupported roles and invalid inputs without throwing', () => {
  const result = inspectClaudeJsonl('{"type":"assistant","message":{"role":"assistant","content":null}}\n{"type":"user","message":{"role":"alien","content":"x"}}');
  assert.ok(result.report.losses.some((item) => item.code === 'record-invalid'));
  assert.ok(result.report.losses.some((item) => item.code === 'unsupported-message-role'));
  assert.deepEqual(inspectClaudeJsonl({}).sessions, []);
});

test('maps top-level Claude tool events and accepts an unterminated final JSONL line', () => {
  const input = [
    JSON.stringify({ type: 'tool_use', sessionId: 'top-level-tools', id: 'toolu-top', name: 'Bash', input: { command: 'pwd' } }),
    JSON.stringify({ type: 'tool_result', sessionId: 'top-level-tools', tool_use_id: 'toolu-top', content: 'done' }),
  ].join('\n');
  const result = inspectClaudeJsonl(input);
  assert.deepEqual(result.sessions[0].messages.map(({ role, toolCallId, content }) => ({ role, toolCallId, content })), [
    { role: 'assistant', toolCallId: 'toolu-top', content: '' },
    { role: 'tool', toolCallId: 'toolu-top', content: 'done' },
  ]);
  assert.ok(!result.report.losses.some((item) => item.code === 'line-count-bounded'));
});
