import {
  COMMON_NAMESPACE_IRIS
} from './shared/namespace-registry/index.js';
import {
  countAllTriples,
  countNamedGraphs,
  deleteExactTriples,
  exportSavedQueriesAsJsonLd,
  getAllGraphNames,
  getAllSavedQueries,
  getAllTriples,
  getSetting,
  resetAxiolotlProjectStorageForTests,
  saveSavedQuery,
  saveSetting,
  storeTriplesInNamedGraph
} from './indexeddb-triplestore.js';

function createAsyncRequest({ result, error = null }) {
  const request = { result, error, onsuccess: null, onerror: null, onblocked: null, onupgradeneeded: null };
  queueMicrotask(() => {
    if (error) request.onerror?.();
    else request.onsuccess?.();
  });
  return request;
}

function createNameList(values = []) {
  return {
    values,
    contains(name) {
      return this.values.includes(name);
    },
    [Symbol.iterator]() {
      return this.values[Symbol.iterator]();
    }
  };
}

function createMockIndexedDB() {
  const databases = new Map();

  function ensureDb(name) {
    if (databases.has(name)) return databases.get(name);
    const stores = new Map();
    const db = {
      name,
      objectStoreNames: createNameList([]),
      close() {},
      createObjectStore(storeName, options = {}) {
        const meta = {
          name: storeName,
          keyPath: options.keyPath || null,
          records: new Map(),
          indexNames: createNameList([]),
          createIndex(indexName) {
            this.indexNames.values.push(indexName);
          }
        };
        stores.set(storeName, meta);
        db.objectStoreNames.values.push(storeName);
        return meta;
      },
      transaction(storeNames, mode) {
        const tx = {
          mode,
          oncomplete: null,
          onerror: null,
          onabort: null,
          error: null,
          completionQueued: false,
          objectStore(storeName) {
            const meta = stores.get(storeName);
            if (!meta) throw new Error(`Missing store ${storeName}`);
            return createObjectStoreApi(meta, tx);
          }
        };
        return tx;
      }
    };
    databases.set(name, db);
    return db;
  }

  function queueTransactionComplete(tx) {
    if (tx.completionQueued) return;
    tx.completionQueued = true;
    setTimeout(() => tx.oncomplete?.(), 0);
  }

  function createObjectStoreApi(meta, tx) {
    return {
      get(key) {
        const request = createAsyncRequest({ result: meta.records.get(key) || null });
        queueTransactionComplete(tx);
        return request;
      },
      put(value, key) {
        const resolvedKey = key ?? (meta.keyPath ? value?.[meta.keyPath] : undefined);
        meta.records.set(resolvedKey, value);
        const request = createAsyncRequest({ result: resolvedKey });
        queueTransactionComplete(tx);
        return request;
      },
      delete(key) {
        const existed = meta.records.delete(key);
        const request = createAsyncRequest({ result: existed });
        queueTransactionComplete(tx);
        return request;
      },
      clear() {
        meta.records.clear();
        const request = createAsyncRequest({ result: undefined });
        queueTransactionComplete(tx);
        return request;
      },
      getAll() {
        const request = createAsyncRequest({ result: [...meta.records.values()] });
        queueTransactionComplete(tx);
        return request;
      }
    };
  }

  return {
    databases() {
      return Promise.resolve([...databases.keys()].map((name) => ({ name })));
    },
    open(name, version) {
      const db = ensureDb(name);
      const request = { result: db, onsuccess: null, onerror: null, onblocked: null, onupgradeneeded: null };
      queueMicrotask(() => {
        request.transaction = {
          objectStore(storeName) {
            return db.transaction(storeName, 'versionchange').objectStore(storeName);
          }
        };
        if (version) request.onupgradeneeded?.({ target: request });
        request.onsuccess?.();
      });
      return request;
    },
    deleteDatabase(name) {
      databases.delete(name);
      return createAsyncRequest({ result: undefined });
    },
    seed(name, storeName, rows, { keyPath = 'id' } = {}) {
      const db = ensureDb(name);
      if (!db.objectStoreNames.contains(storeName)) {
        db.createObjectStore(storeName, { keyPath });
      }
      const store = db.transaction(storeName, 'readwrite').objectStore(storeName);
      rows.forEach((row) => store.put(row));
    }
  };
}

describe('Axiolotl shared project triplestore', () => {
  let originalIndexedDB;

  beforeEach(() => {
    originalIndexedDB = globalThis.indexedDB;
    globalThis.indexedDB = createMockIndexedDB();
    resetAxiolotlProjectStorageForTests();
  });

  afterEach(() => {
    resetAxiolotlProjectStorageForTests();
    globalThis.indexedDB = originalIndexedDB;
  });

  test('stores and reads SPARQL settings through shared project settings', async () => {
    await saveSetting('sparqlEndpoint', 'https://example.org/sparql');

    await expect(getSetting('sparqlEndpoint')).resolves.toBe('https://example.org/sparql');
  });

  test('stores saved SPARQL queries as project artifacts', async () => {
    await saveSavedQuery({
      id: 'query:classes',
      label: 'Classes',
      type: 'https://example.org/Query',
      value: 'SELECT * WHERE { ?s a owl:Class }',
      createdAt: '2026-08-01T12:00:00.000Z'
    });

    await expect(getAllSavedQueries()).resolves.toEqual([
      expect.objectContaining({
        id: 'query:classes',
        label: 'Classes',
        value: 'SELECT * WHERE { ?s a owl:Class }'
      })
    ]);

    await expect(exportSavedQueriesAsJsonLd()).resolves.toEqual([
      expect.objectContaining({
        '@id': 'query:classes',
        '@type': ['https://example.org/Query', COMMON_NAMESPACE_IRIS.cco2.informationContentEntity],
        [COMMON_NAMESPACE_IRIS.dcterms.title]: [{
          '@value': 'Classes',
          '@type': COMMON_NAMESPACE_IRIS.xsd.string
        }],
        [COMMON_NAMESPACE_IRIS.dcterms.format]: 'application/sparql-query',
        [COMMON_NAMESPACE_IRIS.rdf.value]: [{
          '@value': 'SELECT * WHERE { ?s a owl:Class }',
          '@type': COMMON_NAMESPACE_IRIS.xsd.string
        }]
      })
    ]);
  });

  test('stores, counts, filters, and deletes quad rows through shared graph storage', async () => {
    await storeTriplesInNamedGraph([
      {
        subject: 'http://example.org/s',
        predicate: 'http://example.org/p',
        object: 'literal',
        objectType: 'Literal',
        graph: 'urn:graph:test'
      },
      {
        subject: 'http://example.org/s2',
        predicate: 'http://example.org/p',
        object: 'http://example.org/o',
        objectType: 'NamedNode',
        graph: ''
      }
    ]);

    await expect(countAllTriples()).resolves.toBe(2);
    await expect(countNamedGraphs()).resolves.toBe(1);
    await expect(getAllGraphNames()).resolves.toEqual(['urn:graph:test']);
    await expect(getAllTriples()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ graph: 'urn:graph:test', object: 'literal' }),
      expect.objectContaining({ graph: '', object: 'http://example.org/o' })
    ]));

    await expect(deleteExactTriples([{
      subject: 'http://example.org/s',
      predicate: 'http://example.org/p',
      object: 'literal',
      objectType: 'Literal',
      graph: 'urn:graph:test'
    }])).resolves.toBe(1);
    await expect(countAllTriples()).resolves.toBe(1);
  });

  test('migrates legacy triples, settings, and saved queries on first read', async () => {
    globalThis.indexedDB.seed('inferenceDB', 'triples', [{
      subject: 'http://legacy.example/s',
      predicate: 'http://legacy.example/p',
      object: 'legacy',
      objectType: 'Literal',
      graph: 'urn:graph:legacy'
    }], { keyPath: 'subject' });
    globalThis.indexedDB.seed('inferenceDB', 'savedQueries', [{
      id: 'query:legacy',
      label: 'Legacy query',
      type: 'https://example.org/Query',
      value: 'SELECT * WHERE { ?s ?p ?o }',
      createdAt: '2026-07-01T12:00:00.000Z'
    }]);
    globalThis.indexedDB.seed('SPARQLSettings', 'Settings', [{
      key: 'sparqlEndpoint',
      value: 'https://legacy.example/sparql'
    }], { keyPath: 'key' });

    await expect(getAllTriples()).resolves.toEqual([
      expect.objectContaining({
        subject: 'http://legacy.example/s',
        graph: 'urn:graph:legacy'
      })
    ]);
    await expect(getAllSavedQueries()).resolves.toEqual([
      expect.objectContaining({ id: 'query:legacy' })
    ]);
    await expect(getSetting('sparqlEndpoint')).resolves.toBe('https://legacy.example/sparql');
  });
});
