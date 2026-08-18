import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MetadataStoreError,
  createMetadataStore,
  normalizeMetadata,
} from '../lib/metadata.js';

test('normalizeMetadata trims, de-duplicates, and preserves the first tag spelling', () => {
  assert.deepEqual(normalizeMetadata({
    tags: [' Important ', 'important', '研究'],
    note: '  first line\nsecond line  ',
  }), {
    tags: ['Important', '研究'],
    note: 'first line\nsecond line',
  });
});

test('normalizeMetadata enforces tag and note limits in Unicode code points', () => {
  assert.throws(() => normalizeMetadata({ tags: Array.from({ length: 9 }, (_, i) => `t${i}`), note: '' }),
    (error) => error instanceof MetadataStoreError && error.code === 'too-many-tags');
  assert.throws(() => normalizeMetadata({ tags: ['界'.repeat(25)], note: '' }),
    (error) => error instanceof MetadataStoreError && error.code === 'tag-too-long');
  assert.throws(() => normalizeMetadata({ tags: [], note: '界'.repeat(2001) }),
    (error) => error instanceof MetadataStoreError && error.code === 'note-too-long');
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dac-metadata-'));
  return { root, filePath: join(root, 'metadata.json') };
}

test('metadata store persists canonical entries and removes empty entries', async () => {
  const { filePath } = await fixture();
  const store = createMetadataStore({ filePath, now: () => new Date('2026-08-18T12:00:00.000Z') });
  const saved = await store.set('session-a', { tags: [' Important '], note: ' note ' });
  assert.deepEqual(saved, { tags: ['Important'], note: 'note', updatedAt: '2026-08-18T12:00:00.000Z' });
  assert.deepEqual(await store.getMany(['session-a']), { status: 'ready', entries: { 'session-a': saved } });
  assert.equal(await store.set('session-a', { tags: [], note: '' }), null);
  assert.deepEqual((await store.getMany(['session-a'])).entries, {});
});

test('unreadable metadata remains untouched and rejects mutations', async () => {
  const { filePath } = await fixture();
  await writeFile(filePath, '{broken', 'utf8');
  const store = createMetadataStore({ filePath });
  assert.deepEqual(await store.getMany(['session-a']), { status: 'unavailable', entries: {} });
  await assert.rejects(store.set('session-a', { tags: [], note: 'x' }),
    (error) => error.code === 'metadata-store-unavailable' && error.status === 503);
  assert.equal(await readFile(filePath, 'utf8'), '{broken');
});

test('unsupported versions and malformed session entries make the store unavailable', async () => {
  const { filePath } = await fixture();
  const store = createMetadataStore({ filePath });
  await writeFile(filePath, JSON.stringify({ version: 2, sessions: {} }), 'utf8');
  assert.equal((await store.getMany(['session-a'])).status, 'unavailable');
  await writeFile(filePath, JSON.stringify({
    version: 1,
    sessions: { 'session-a': { tags: 'not-an-array', note: '', updatedAt: '2026-08-18T12:00:00.000Z' } },
  }), 'utf8');
  assert.equal((await store.getMany(['session-a'])).status, 'unavailable');
});

test('concurrent saves serialize without dropping sessions', async () => {
  const { filePath } = await fixture();
  const store = createMetadataStore({ filePath });
  await Promise.all([
    store.set('session-a', { tags: ['a'], note: '' }),
    store.set('session-b', { tags: ['b'], note: '' }),
  ]);
  const result = await store.getMany(['session-a', 'session-b']);
  assert.deepEqual(Object.keys(result.entries).sort(), ['session-a', 'session-b']);
});
