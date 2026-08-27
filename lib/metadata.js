import { readFile } from 'node:fs/promises';
import { atomicWriteFile } from './durable.js';

const VERSION = 1;
const MAX_TAGS = 8;
const MAX_TAG_LENGTH = 24;
const MAX_NOTE_LENGTH = 2000;
const UNSAFE_SESSION_IDS = new Set(['__proto__', 'constructor', 'prototype']);
const WRITE_QUEUES = new Map();

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

function sessionId(value) {
  const id = String(value);
  if (id.trim() === '' || UNSAFE_SESSION_IDS.has(id)) {
    throw new MetadataStoreError('metadata-session-id-invalid', 'metadata session id is invalid');
  }
  return id;
}

function emptyDocument() { return { version: VERSION, sessions: Object.create(null) }; }

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
  const sessions = Object.create(null);
  for (const [id, entry] of Object.entries(value.sessions)) {
    if (id.trim() === '' || UNSAFE_SESSION_IDS.has(id)) {
      throw new MetadataStoreError('metadata-store-unavailable', 'metadata session id is invalid', 503);
    }
    sessions[id] = parseStoredEntry(entry);
  }
  return { version: VERSION, sessions };
}

export function createMetadataStore({ filePath, now = () => new Date() }) {
  async function load() {
    try { return { status: 'ready', document: parseDocument(await readFile(filePath, 'utf8')) }; }
    catch (error) {
      if (error?.code === 'ENOENT') return { status: 'ready', document: emptyDocument() };
      return { status: 'unavailable', document: emptyDocument() };
    }
  }

  async function save(document) {
    await atomicWriteFile(filePath, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8' });
  }

  function mutate(operation) {
    const previous = WRITE_QUEUES.get(filePath) ?? Promise.resolve();
    const result = previous.then(async () => {
      const loaded = await load();
      if (loaded.status !== 'ready') throw new MetadataStoreError('metadata-store-unavailable', 'metadata store is unreadable', 503);
      return operation(loaded.document);
    });
    const settled = result.catch(() => undefined);
    WRITE_QUEUES.set(filePath, settled);
    settled.then(() => {
      if (WRITE_QUEUES.get(filePath) === settled) WRITE_QUEUES.delete(filePath);
    });
    return result;
  }

  return {
    async getMany(ids) {
      const loaded = await load();
      if (loaded.status !== 'ready') return { status: 'unavailable', entries: {} };
      const entries = {};
      for (const value of ids) {
        const id = sessionId(value);
        if (Object.hasOwn(loaded.document.sessions, id)) entries[id] = loaded.document.sessions[id];
      }
      return { status: 'ready', entries };
    },
    set(id, input) {
      return mutate(async (document) => {
        const key = sessionId(id);
        const normalized = normalizeMetadata(input);
        if (normalized.tags.length === 0 && normalized.note === '') {
          delete document.sessions[key];
          await save(document);
          return null;
        }
        const entry = { ...normalized, updatedAt: now().toISOString() };
        document.sessions[key] = entry;
        await save(document);
        return entry;
      });
    },
    remove(ids) {
      return mutate(async (document) => {
        let changed = false;
        for (const value of ids) {
          const id = sessionId(value);
          if (Object.hasOwn(document.sessions, id)) {
            delete document.sessions[id];
            changed = true;
          }
        }
        if (changed) await save(document);
      });
    },
  };
}
