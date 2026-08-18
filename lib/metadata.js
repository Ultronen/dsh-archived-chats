import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const VERSION = 1;
const MAX_TAGS = 8;
const MAX_TAG_LENGTH = 24;
const MAX_NOTE_LENGTH = 2000;

export class MetadataStoreError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'MetadataStoreError';
    this.code = code;
    this.status = status;
  }
}

const codePointLength = (value) => Array.from(value).length;

export function normalizeMetadata(input) {
  if (!Array.isArray(input?.tags) || typeof input?.note !== 'string') {
    throw new MetadataStoreError('metadata-invalid', 'tags must be an array and note must be a string');
  }
  if (input.tags.length > MAX_TAGS) {
    throw new MetadataStoreError('too-many-tags', `at most ${MAX_TAGS} tags are allowed`);
  }
  const tags = [];
  const seen = new Set();
  for (const raw of input.tags) {
    if (typeof raw !== 'string') throw new MetadataStoreError('tag-invalid', 'every tag must be a string');
    const tag = raw.trim();
    if (tag === '') throw new MetadataStoreError('tag-empty', 'tags cannot be empty');
    if (codePointLength(tag) > MAX_TAG_LENGTH) throw new MetadataStoreError('tag-too-long', `tags are limited to ${MAX_TAG_LENGTH} characters`);
    const key = tag.toLocaleLowerCase('en-US');
    if (!seen.has(key)) { seen.add(key); tags.push(tag); }
  }
  const note = input.note.trim();
  if (codePointLength(note) > MAX_NOTE_LENGTH) throw new MetadataStoreError('note-too-long', `notes are limited to ${MAX_NOTE_LENGTH} characters`);
  return { tags, note };
}

function emptyDocument() { return { version: VERSION, sessions: {} }; }

function parseStoredEntry(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new MetadataStoreError('metadata-store-unavailable', 'metadata entry is invalid', 503);
  }
  const normalized = normalizeMetadata({ tags: value.tags, note: value.note });
  if (typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))) {
    throw new MetadataStoreError('metadata-store-unavailable', 'metadata timestamp is invalid', 503);
  }
  return { ...normalized, updatedAt: value.updatedAt };
}

function parseDocument(text) {
  const value = JSON.parse(text);
  if (value?.version !== VERSION || value.sessions === null || typeof value.sessions !== 'object' || Array.isArray(value.sessions)) {
    throw new MetadataStoreError('metadata-store-unavailable', 'metadata schema is unsupported', 503);
  }
  const sessions = {};
  for (const [id, entry] of Object.entries(value.sessions)) {
    if (id.trim() === '') throw new MetadataStoreError('metadata-store-unavailable', 'metadata session id is invalid', 503);
    sessions[id] = parseStoredEntry(entry);
  }
  return { version: VERSION, sessions };
}

export function createMetadataStore({ filePath, now = () => new Date() }) {
  let writeQueue = Promise.resolve();

  async function load() {
    try { return { status: 'ready', document: parseDocument(await readFile(filePath, 'utf8')) }; }
    catch (error) {
      if (error?.code === 'ENOENT') return { status: 'ready', document: emptyDocument() };
      return { status: 'unavailable', document: emptyDocument() };
    }
  }

  async function save(document) {
    await mkdir(dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
    await rename(tempPath, filePath);
  }

  function mutate(operation) {
    const result = writeQueue.then(async () => {
      const loaded = await load();
      if (loaded.status !== 'ready') throw new MetadataStoreError('metadata-store-unavailable', 'metadata store is unreadable', 503);
      return operation(loaded.document);
    });
    writeQueue = result.catch(() => undefined);
    return result;
  }

  return {
    async getMany(ids) {
      const loaded = await load();
      if (loaded.status !== 'ready') return { status: 'unavailable', entries: {} };
      const entries = {};
      for (const id of ids.map(String)) if (loaded.document.sessions[id] !== undefined) entries[id] = loaded.document.sessions[id];
      return { status: 'ready', entries };
    },
    set(id, input) {
      return mutate(async (document) => {
        const normalized = normalizeMetadata(input);
        if (normalized.tags.length === 0 && normalized.note === '') {
          delete document.sessions[String(id)];
          await save(document);
          return null;
        }
        const entry = { ...normalized, updatedAt: now().toISOString() };
        document.sessions[String(id)] = entry;
        await save(document);
        return entry;
      });
    },
    remove(ids) {
      return mutate(async (document) => {
        let changed = false;
        for (const id of ids.map(String)) if (delete document.sessions[id]) changed = true;
        if (changed) await save(document);
      });
    },
  };
}
