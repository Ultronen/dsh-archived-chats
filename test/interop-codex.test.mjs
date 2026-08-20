import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { inspectCodexJsonl, exportCodexJsonl } from '../lib/interop/codex.js';

const fixture = (name) => readFile(new URL(`./fixtures/interop/${name}`, import.meta.url));

test('inspects one Codex session across multiple turns without mutating source bytes', async () => {
  const bytes = await fixture('codex-simple.jsonl');
  const before = Buffer.from(bytes);
  const result = inspectCodexJsonl(bytes);

  assert.deepEqual(bytes, before);
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].id, 'codex-simple');
  assert.equal(result.sessions[0].workspace.title, '/tmp/project');
  assert.deepEqual(result.sessions[0].messages.map(({ role, content }) => ({ role, content })), [
    { role: 'user', content: 'Hello Codex' },
    { role: 'assistant', content: 'Hello!' },
    { role: 'user', content: 'Second turn' },
    { role: 'assistant', content: 'Second answer' },
  ]);
  assert.ok(result.report.losses.some((loss) => loss.code === 'unsupported-event' && loss.type === 'future_event'));
  assert.ok(result.report.losses.some((loss) => loss.code === 'malformed-json'));
});
test('maps Codex function calls and outputs, and reports attachment references', async () => {
  const result = inspectCodexJsonl(await fixture('codex-tools.jsonl'));
  assert.equal(result.sessions.length, 1);
  const messages = result.sessions[0].messages;
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[1].role, 'assistant');
  assert.equal(messages[1].toolCall.name, 'shell_command');
  assert.equal(messages[2].role, 'tool');
  assert.equal(messages[2].toolCallId, 'call-1');
  assert.equal(messages[2].content, 'README.md\nsrc/');
  assert.deepEqual(result.sessions[0].attachments, [{ path: 'attachments/diagram.png', mediaType: 'image/png' }]);
  assert.ok(result.report.warnings.some((warning) => warning.code === 'attachment-references'));
});

test('repeated inspection is deterministic', async () => {
  const bytes = await fixture('codex-tools.jsonl');
  assert.deepEqual(inspectCodexJsonl(bytes), inspectCodexJsonl(bytes));
});

test('exports deterministic transcript JSONL and identifies handoff limitations', () => {
  const session = {
    id: 'export-session',
    title: 'Export me',
    workspace: { id: 'workspace-1', title: '/work/repo' },
    messages: [
      { id: 'message-1', role: 'user', content: 'Hi' },
      { id: 'message-2', role: 'assistant', content: 'There' },
      { id: 'message-3', role: 'tool', content: 'done', toolCallId: 'call-1' },
    ],
    attachments: [{ path: 'attachments/diagram.png', mediaType: 'image/png' }],
  };
  const first = exportCodexJsonl(session);
  const second = exportCodexJsonl(structuredClone(session));

  assert.deepEqual(first, second);
  assert.ok(first.bytes instanceof Uint8Array);
  const records = new TextDecoder().decode(first.bytes).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(records[0].type, 'session_meta');
  assert.equal(records[0].payload.id, 'export-session');
  assert.deepEqual(records.slice(1).map((record) => record.type), ['response_item', 'response_item', 'response_item']);
  assert.ok(first.report.warnings.some((warning) => warning.code === 'native-resume-unsupported'));
  assert.ok(first.report.warnings.some((warning) => warning.code === 'transcript-handoff'));
  assert.ok(first.report.warnings.some((warning) => warning.code === 'attachments-not-included'));
});

test('reserves explicit call IDs before generating fallback IDs and preserves empty messages', () => {
  const result = exportCodexJsonl({
    id: 'collision-session',
    messages: [
      { role: 'assistant', content: '', toolCall: { name: 'first', arguments: {} }, toolCallId: 'call-1' },
      { role: 'tool', content: 'result-with-generated-id' },
      { role: 'user', content: '' },
    ],
  });
  const records = new TextDecoder().decode(result.bytes).trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(records.slice(1).map((record) => record.payload.type), ['function_call', 'function_call_output', 'message']);
  assert.equal(records[1].payload.call_id, 'call-1');
  assert.equal(records[2].payload.call_id, 'call-2');
  assert.equal(records[3].payload.content[0].text, '');
});

test('reports malformed session metadata with line and session context', () => {
  const input = [
    JSON.stringify({ type: 'session_meta', payload: null }),
    JSON.stringify({ type: 'session_meta', payload: {} }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'still grouped' } }),
  ].join('\n');
  const result = inspectCodexJsonl(input);
  const malformed = result.report.losses.filter((item) => item.code === 'record-invalid');
  assert.equal(malformed.length, 2);
  assert.deepEqual(malformed.map((item) => item.line), [1, 2]);
  assert.ok(malformed.every((item) => item.sessionId === 'session-1'));
});
