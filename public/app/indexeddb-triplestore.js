// indexeddb-triplestore.js
// Dependencies
// idb : aka indexedDB
// openDB

const DB_NAME = 'inferenceDB';
const STORE_NAME = 'triples';

const SETTINGS_DB_NAME = 'SPARQLSettings';
const SETTINGS_STORE_NAME = 'Settings';

const QUERY_STORE_NAME = 'savedQueries';
const INFERENCE_DB_VERSION = 3;

let tripleDbHandle = null;
let settingsDbHandle = null;

/*
* Initializes the settings database with required object store.
* Creates the 'Settings' object store with 'key' as the keyPath.
* @returns {Promise<IDBPDatabase>} A promise that resolves to the database instance.
*/
async function initSettingsDB() {
  return idb.openDB(SETTINGS_DB_NAME, INFERENCE_DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(SETTINGS_STORE_NAME)) {
        db.createObjectStore(SETTINGS_STORE_NAME, { keyPath: 'key' });
      }
    }
  });
}

function isNotFound(err) {
  return err?.name === 'NotFoundError' || /NotFoundError/i.test(err?.message || '');
}

/** Get a setting (safe after wipes). Returns undefined if missing/unavailable. */
async function getSetting(key) {
  try {
    const db = await initSettingsDB();                 // ensures store exists on this version
    return (await db.get(SETTINGS_STORE_NAME, key))?.value;
  } catch (e) {
    // If a stale handle or race caused NotFoundError, just treat as "no value"
    if (isNotFound(e)) return undefined;
    if (debuggingConsoleEnabled) console.warn('[getSetting] fallback due to:', e);
    return undefined;
  }
}

/** Save a setting (safe after wipes). No-ops on failure. */
async function saveSetting(key, value) {
  try {
    const db = await initSettingsDB();
    await db.put(SETTINGS_STORE_NAME, { key, value });
  } catch (e) {
    if (isNotFound(e)) {
      // Retry once by re-opening (upgrade will create the store)
      try {
        const db = await initSettingsDB();
        await db.put(SETTINGS_STORE_NAME, { key, value });
        return;
      } catch { }
    }
    if (debuggingConsoleEnabled) console.warn('[saveSetting] failed:', e);
  }
}

/*
* Retrieves a setting by key from the settings database.
* @param {string} key - The key of the setting to retrieve.
* @returns {Promise<any>} A promise that resolves to the setting value, or undefined if not found. 
*/
async function getSetting(key) {
  const db = await initSettingsDB();
  const entry = await db.get(SETTINGS_STORE_NAME, key);
  return entry?.value;
}

/**
 * Clears all SPARQL settings from the settings store.
 */
async function clearSettingsStore() {
  try {
    const db = await initSettingsDB();
    const tx = db.transaction(SETTINGS_STORE_NAME, 'readwrite');
    await tx.objectStore(SETTINGS_STORE_NAME).clear();
    await tx.done;

    try {
      window?.dispatchEvent(new CustomEvent('settings-changed', {
        detail: { db: SETTINGS_DB_NAME, store: SETTINGS_STORE_NAME, type: 'clear' }
      }));
    } catch {}

    if (debuggingConsoleEnabled) {
      console.info('[clearSettingsStore] All settings cleared from store.');
    }
  } catch (error) {
    if (debuggingConsoleEnabled) {
      console.error('[clearSettingsStore] Error clearing settings store:', error);
    }
    throw error;
  }
}

const QUERY_IRI = {
  class: "https://github.com/jonathanvajda/SemanticArtifactOntology/ont000007",
  predicate: "https://github.com/jonathanvajda/SemanticArtifactOntology/has_sparql_query_text_value",
  label: "http://www.w3.org/2000/01/rdf-schema#label"
}

/**
 * Initializes the triple store database and ensures the savedQueries store exists.
 * Reuses the same DB as triples, but adds a separate store for saved query artifacts.
 * @returns {Promise<IDBPDatabase>}
 */
async function initQueryStore() {
  return initTripleStore();
}

/**
 * Save one normalized query record.
 * @param {{id:string,type:string,value:string,label?:string,createdAt?:string}} record
 * @returns {Promise<object>}
 */
async function saveSavedQuery(record) {
  const db = await initQueryStore();
  const tx = db.transaction(QUERY_STORE_NAME, 'readwrite');
  const store = tx.objectStore(QUERY_STORE_NAME);

  const normalized = {
    id: String(record.id).trim(),
    label: String(record.label).trim(),
    type: String(record.type).trim(),
    value: String(record.value ?? ''),
    createdAt: record.createdAt || new Date().toISOString()
  };

  await store.put(normalized);
  await tx.done;

  try {
    window?.dispatchEvent(new CustomEvent('saved-queries-changed', {
      detail: { db: DB_NAME, store: QUERY_STORE_NAME, type: 'put', key: normalized.id }
    }));
  } catch { }

  return normalized;
}

/**
 * Get one saved query by IRI.
 * @param {string} id
 * @returns {Promise<object|undefined>}
 */
async function getSavedQueryById(id) {
  const db = await initQueryStore();
  return db.get(QUERY_STORE_NAME, id);
}

/**
 * List all saved queries.
 * @returns {Promise<Array<{id:string,label:string,type:string,value:string,createdAt:string}>>}
 */
async function getAllSavedQueries() {
  const db = await initQueryStore();

  if (!db.objectStoreNames.contains(QUERY_STORE_NAME)) {
    if (debuggingConsoleEnabled) {
      console.warn(`[getAllSavedQueries] Missing store: ${QUERY_STORE_NAME}`);
    }
    return [];
  }

  const rows = await db.getAll(QUERY_STORE_NAME);
  return rows.sort((a, b) => {
    const av = a.createdAt || '';
    const bv = b.createdAt || '';
    return bv.localeCompare(av);
  });
}

/**
 * Delete one saved query by IRI.
 * @param {string} id
 * @returns {Promise<void>}
 */
async function deleteSavedQuery(id) {
  const db = await initQueryStore();
  const tx = db.transaction(QUERY_STORE_NAME, 'readwrite');
  await tx.objectStore(QUERY_STORE_NAME).delete(id);
  await tx.done;

  try {
    window?.dispatchEvent(new CustomEvent('saved-queries-changed', {
      detail: { db: DB_NAME, store: QUERY_STORE_NAME, type: 'delete', key: id }
    }));
  } catch { }
}

/**
 * Convert one normalized query record into your JSON-LD shape.
 * @param {{id:string,label:string,type:string,value:string}} record
 * @returns {object}
 */
function savedQueryRecordToJsonLd(record) {
  return {
    '@id': record.id,
    '@type': [record.type, 'http://www.w3.org/2002/07/owl#NamedIndividual'],
    [QUERY_IRI.predicate]: [{ '@value': record.value }],
    [QUERY_IRI.label]: [{'@value': record.label }]
  };
}

/**
 * Export all saved queries as a JSON-LD array.
 * @returns {Promise<Array<object>>}
 */
async function exportSavedQueriesAsJsonLd() {
  const rows = await getAllSavedQueries();
  return rows.map(savedQueryRecordToJsonLd);
}

const SAVED_QUERY_CSV_HEADERS = [
  'query ID (IRI)',
  'label',
  'type (class iri)',
  "value ('has sparql query text value')"
];

function escapeCsvCell(value) {
  const s = String(value ?? '');
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * Convert normalized query rows to CSV text.
 * @param {Array<{id:string,label:string,type:string,value:string}>} rows
 * @returns {string}
 */
function savedQueriesToCsv(rows) {
  const lines = [SAVED_QUERY_CSV_HEADERS.join(',')];
  for (const row of rows) {
    lines.push([
      escapeCsvCell(row.id),
      escapeCsvCell(row.label),
      escapeCsvCell(row.type),
      escapeCsvCell(row.value)
    ].join(','));
  }
  return lines.join('\n');
}

/**
 * Export all saved queries as normalized CSV text.
 * @returns {Promise<string>}
 */
async function exportSavedQueriesAsCsv() {
  const rows = await getAllSavedQueries();
  return savedQueriesToCsv(rows);
}

/**
 * Parse a normalized CSV line array into query objects.
 * Assumes CSV was generated by this app's exporter.
 * @param {string} csvText
 * @returns {Array<{id:string,label:string,type:string,value:string}>}
 */
function parseSavedQueriesCsv(csvText) {
  const text = String(csvText || '').trim();
  if (!text) return [];

  const rows = [];
  let i = 0;
  let field = '';
  let row = [];
  let inQuotes = false;

  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        field += '"';
        i += 2;
        continue;
      }
      if (ch === '"') {
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }

    if (ch === ',') {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }

    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 1;
      continue;
    }

    if (ch === '\r') {
      i += 1;
      continue;
    }

    field += ch;
    i += 1;
  }

  row.push(field);
  rows.push(row);

  if (!rows.length) return [];

  const header = rows[0].map(x => String(x).trim());
  const expected = SAVED_QUERY_CSV_HEADERS;

  const headerOk = expected.length === header.length &&
    expected.every((h, idx) => h === header[idx]);

  if (!headerOk) {
    throw new Error('CSV header does not match the normalized saved-query format.');
  }

  return rows.slice(1)
    .filter(r => r.some(cell => String(cell).trim() !== ''))
    .map(r => ({
      id: String(r[0] || '').trim(),
      label: String(r[1] || '').trim(),
      type: String(r[2] || '').trim(),
      value: String(r[3] || '')
    }));
}

/**
 * Import normalized CSV into savedQueries store.
 * Upserts by id.
 * @param {string} csvText
 * @returns {Promise<{count:number}>}
 */
async function importSavedQueriesFromCsv(csvText) {
  const rows = parseSavedQueriesCsv(csvText);
  const db = await initQueryStore();
  const tx = db.transaction(QUERY_STORE_NAME, 'readwrite');
  const store = tx.objectStore(QUERY_STORE_NAME);

  for (const row of rows) {
    if (!row.id || !row.type) continue;
    await store.put({
      id: row.id,
      label: row.label,
      type: row.type,
      value: row.value,
      createdAt: new Date().toISOString()
    });
  }

  await tx.done;

  try {
    window?.dispatchEvent(new CustomEvent('saved-queries-changed', {
      detail: { db: DB_NAME, store: QUERY_STORE_NAME, type: 'bulk-import' }
    }));
  } catch { }

  return { count: rows.length };
}

async function clearSavedQueries() {
  const db = await initQueryStore();
  const tx = db.transaction(QUERY_STORE_NAME, 'readwrite');
  await tx.objectStore(QUERY_STORE_NAME).clear();
  await tx.done;

  try {
    window?.dispatchEvent(new CustomEvent('saved-queries-changed', {
      detail: { db: DB_NAME, store: QUERY_STORE_NAME, type: 'clear' }
    }));
  } catch { }
}



/**
 * Initializes the triple store database with required indexes.
 * Creates the 'triples' object store with indexes for subject, predicate, object, and graph.
 * @returns {Promise<IDBPDatabase>} A promise that resolves to the database instance.
 */
/**
 * Initializes the IndexedDB database with required stores and indexes.
 * Creates:
 * - 'triples' object store
 * - 'savedQueries' object store
 * @returns {Promise<IDBPDatabase>}
 */
async function initTripleStore() {
  try {
    if (debuggingConsoleEnabled) {
      console.info('[initTripleStore] Initializing IndexedDB store...');
    }

    const db = await idb.openDB(DB_NAME, INFERENCE_DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, {
            keyPath: ['subject', 'predicate', 'object', 'graph']
          });
          store.createIndex('subject', 'subject');
          store.createIndex('predicate', 'predicate');
          store.createIndex('object', 'object');
          store.createIndex('graph', 'graph');
        }

        if (!db.objectStoreNames.contains(QUERY_STORE_NAME)) {
          const queryStore = db.createObjectStore(QUERY_STORE_NAME, {
            keyPath: 'id'
          });
          queryStore.createIndex('label', 'label');
          queryStore.createIndex('type', 'type');
          queryStore.createIndex('value', 'value');
          queryStore.createIndex('createdAt', 'createdAt');
        }
      }
    });

    return db;
  } catch (error) {
    if (debuggingConsoleEnabled) {
      console.error('[initTripleStore] Failed to initialize store:', error);
    }
    throw error;
  }
}

/**
 * Adds RDF triples to the IndexedDB triple store.
 * Accepts either:
 *  1) term-based quads/statements (subject.value, predicate.value, etc.)
 *  2) already-flattened row objects (subject, predicate, object, graph as strings)
 * @param {Array} triples
 */
async function storeTriplesInNamedGraph(triples) {
  try {
    if (debuggingConsoleEnabled) {
      console.info(`[storeTriplesInNamedGraph] Adding ${triples.length} triples to IndexedDB`);
    }

    const db = await initTripleStore();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);

    for (const t of triples) {
      const row = {
        subject: typeof t.subject === 'string' ? t.subject : (t.subject?.value ?? ''),
        subjectType: t.subjectType ?? t.subject?.termType ?? '',
        predicate: typeof t.predicate === 'string' ? t.predicate : (t.predicate?.value ?? ''),
        predicateType: t.predicateType ?? t.predicate?.termType ?? '',
        object: typeof t.object === 'string' ? t.object : (t.object?.value ?? ''),
        objectType: t.objectType ?? t.object?.termType ?? '',
        objectLang: t.objectLang ?? t.object?.lang ?? t.object?.language ?? null,
        objectDatatype: t.objectDatatype ?? t.object?.datatype?.value ?? null,
        graph: normalizeIriString(
          typeof t.graph === 'string'
            ? t.graph
            : (t.graph?.value || t.why?.value || '')
        )
      };

      // Cheap defensive check so the real bad row is obvious
      if (
        typeof row.subject !== 'string' ||
        typeof row.predicate !== 'string' ||
        typeof row.object !== 'string' ||
        typeof row.graph !== 'string'
      ) {
        console.error('[storeTriplesInNamedGraph] Invalid row:', row, t);
        throw new Error('Invalid triple row for IndexedDB storage.');
      }

      await store.put(row);
    }

    await tx.done;

    try {
      window?.dispatchEvent(new CustomEvent('triples-changed', {
        detail: { db: DB_NAME, store: STORE_NAME, type: 'put' }
      }));
    } catch {}

    if (debuggingConsoleEnabled) {
      console.info('[storeTriplesInNamedGraph] Triples successfully stored.');
    }
  } catch (error) {
    if (debuggingConsoleEnabled) {
      console.error('[storeTriplesInNamedGraph] Error storing triples:', error);
    }
    throw error;
  }
}

/**
 * Retrieves all triples from the triple store.
 * @returns {Promise<Array>} A promise that resolves to an array of all stored triples.
 */
async function getAllTriples() {
  try {
    const db = await initTripleStore();
    const triples = await db.getAll(STORE_NAME);
    if (debuggingConsoleEnabled) { console.info(`[getAllTriples] Retrieved ${triples.length} triples.`); }
    return triples;
  } catch (error) {
    if (debuggingConsoleEnabled) { console.error('[getAllTriples] Failed to fetch triples:', error); }
    throw error;
  }
};

/**
 * Retrieves all distinct named graph IRIs from IndexedDB.
 * 
 * @returns {Promise<string[]>} - Resolves with an array of unique named graph IRIs.
 */
async function getAllGraphNames() {
  try {
    const db = await initTripleStore();
    const tx = db.transaction(STORE_NAME);
    const idx = tx.store.index('graph');

    // Option A (simple): load values then map .graph
    const rows = await idx.getAll();
    const unique = [...new Set(
      rows
        .map(r => r?.graph)
        .filter(g => typeof g === 'string' && g.trim() !== '')
        .map(g => g.trim())
    )];

    if (debuggingConsoleEnabled) { console.info(`[getAllGraphNames] Found ${unique.length} named graphs`); }
    return unique;
  } catch (err) {
    if (debuggingConsoleEnabled) { console.error('[getAllGraphNames] Failed to retrieve graph names:', err); }
    return [];
  }
}

/**
 * Counts all triples in the triple store without loading them.
 * @returns {Promise<number>}
 */
async function countAllTriples() {
  try {
    const db = await initTripleStore();
    const tx = db.transaction(STORE_NAME);
    const count = await tx.store.count();

    if (debuggingConsoleEnabled) {
      console.info(`[countAllTriples] Found ${count} triples.`);
    }
    return count;
  } catch (error) {
    if (debuggingConsoleEnabled) {
      console.error('[countAllTriples] Failed to count triples:', error);
    }
    return 0;
  }
}

/**
 * Counts distinct named graphs in the triple store.
 * Excludes the default graph, which is stored as an empty string.
 * @returns {Promise<number>}
 */
async function countNamedGraphs() {
  try {
    const db = await initTripleStore();
    const tx = db.transaction(STORE_NAME);
    const idx = tx.store.index('graph');

    const keys = await idx.getAllKeys();
    const count = new Set(
      keys
        .filter(g => typeof g === 'string' && g.trim() !== '')
        .map(g => g.trim())
    ).size;

    if (debuggingConsoleEnabled) {
      console.info(`[countNamedGraphs] Found ${count} named graphs.`);
    }
    return count;
  } catch (error) {
    if (debuggingConsoleEnabled) {
      console.error('[countNamedGraphs] Failed to count named graphs:', error);
    }
    return 0;
  }
}



/**
 * Remove a batch of exact triples (subject,predicate,object,graph) from the store.
 * @param {Array<{subject:string,predicate:string,object:string,graph:string}>} triples
 */
const deleteExactTriples = async (triples = []) => {
  const db = await initTripleStore();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  const store = tx.objectStore(STORE_NAME);
  let removed = 0;
  for (const t of triples) {
    const key = [t.subject, t.predicate, t.object, t.graph || ''];
    try {
      await store.delete(key);
      removed++;
    } catch (e) {
      if (debuggingConsoleEnabled) { console.warn('[deleteExactTriples] Failed to delete key', key, e); }
    }
  }
  await tx.done;
  if (debuggingConsoleEnabled) { console.info(`[deleteExactTriples] Removed ${removed}/${triples.length} triples.`); }
  return removed;
};


/**
 * Clears all triples from the triple store.
 */
async function clearTriples() {
  try {
    const db = await initTripleStore();
    await db.clear(STORE_NAME);
    try { window?.dispatchEvent(new CustomEvent('triples-changed', { detail: { db: DB_NAME, store: STORE_NAME, type: 'clear' } })); } catch { }
    if (debuggingConsoleEnabled) { console.info('[clearTriples] All triples cleared from store.'); }
  } catch (error) {
    if (debuggingConsoleEnabled) { console.error('[clearTriples] Error clearing store:', error); }
    throw error;
  }
};

/**
 * Retrieves triples matching a specific subject, predicate, object, or graph.
 * @param {string} field - One of 'subject', 'predicate', 'object', or 'graph'.
 * @param {string} value - The value to match.
 * @returns {Promise<Array>} A promise that resolves to matching triples.
 */
const getTriplesByField = async (field, value) => {
  try {
    const db = await initTripleStore();
    const index = db.transaction(STORE_NAME).store.index(field);
    const results = await index.getAll(value);
    if (debuggingConsoleEnabled) { console.info(`[getTriplesByField] Retrieved ${results.length} triples for ${field}=${value}`); }
    return results;
  } catch (error) {
    if (debuggingConsoleEnabled) { console.error(`[getTriplesByField] Error retrieving by ${field}:`, error); }
    throw error;
  }
};


// Best-effort: close any open connections first (avoids 'blocked' state)
async function closeOpenIndexedDBConnections() {
  try {
    const [db1, db2] = await Promise.all([
      idb.openDB(DB_NAME).catch(() => null),
      idb.openDB(SETTINGS_DB_NAME).catch(() => null),
    ]);
    db1?.close?.();
    db2?.close?.();
  } catch (_) { /* ignore */ }
};

/**
 * Deletes the specified IndexedDB database.
 * @param {string} name - The name of the database to delete.
 */
async function deleteIndexedDBInstance(name) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name);

    req.onsuccess = () => {
      if (debuggingConsoleEnabled) {
        console.info(`[deleteIndexedDBInstance] Deleted "${name}"`);
      }
      resolve({ name, deleted: true, blocked: false });
    };

    req.onerror = () => {
      if (debuggingConsoleEnabled) {
        console.error(`[deleteIndexedDBInstance] Failed to delete "${name}"`, req.error);
      }
      reject(req.error || new Error(`Failed to delete ${name}`));
    };

    req.onblocked = () => {
      const err = new Error(`Delete blocked for "${name}". Another tab or open connection is still using it.`);
      if (debuggingConsoleEnabled) {
        console.warn(`[deleteIndexedDBInstance] ${err.message}`);
      }
      reject(err);
    };
  });
}

// Clear Browser's localStorage
function clearLocalStorage() {
  // Clear localStorage (if you prefer a narrower clear, replace with removals of known keys)
  try {
    localStorage.clear();
    if (debuggingConsoleEnabled) { console.info('[wipeActiveWorkspace] Cleared localStorage'); }
  } catch (e) {
    if (debuggingConsoleEnabled) { console.warn('[wipeActiveWorkspace] Could not clear localStorage:', e); }
  }
};

/**
 * Wipes the Active Workspace: deletes the IndexedDB databases and clears localStorage.
 * - Drops "inferenceDB" (triples) and "SPARQLSettings" (settings).
 * - Clears localStorage keys for this origin.
 */
async function wipeActiveWorkspace() {
  // close any open connections first (avoids 'blocked' state)
  await closeOpenIndexedDBConnections();

  // Delete the two databases (and actually await the promises)
  await Promise.allSettled([
    deleteIndexedDBInstance(DB_NAME),
    deleteIndexedDBInstance(SETTINGS_DB_NAME)
  ]);

  // Clear localStorage
  clearLocalStorage();

  try { window?.dispatchEvent(new CustomEvent('triples-changed', { detail: { db: 'inferenceDB', store: 'triples', type: 'clear' } })); } catch { }
  try { window?.dispatchEvent(new CustomEvent('settings-changed', { detail: { db: 'SPARQLSettings', store: 'Settings', type: 'clear' } })); } catch { }
  try { notifyIdbChange?.({ db: 'inferenceDB', store: 'triples', type: 'clear' }); } catch { }
  try { notifyIdbChange?.({ db: 'SPARQLSettings', store: 'Settings', type: 'clear' }); } catch { }
}


async function clearActiveWorkspace() {
  await Promise.all([
    clearTriples(),
    clearSettingsStore(),
    clearSavedQueries()
  ]);
  clearLocalStorage();

  try { window?.dispatchEvent(new CustomEvent('triples-changed',  { detail: { db: DB_NAME, store: STORE_NAME, type: 'clear' } })); } catch {}
  try { window?.dispatchEvent(new CustomEvent('settings-changed', { detail: { db: SETTINGS_DB_NAME, store: SETTINGS_STORE_NAME, type: 'clear' } })); } catch {}
  try { window?.dispatchEvent(new CustomEvent('saved-queries-changed', { detail: { db: DB_NAME, store: QUERY_STORE_NAME, type: 'clear' } })); } catch {}
}

async function hardResetDatabases() {
  await closeAllKnownDbHandles();

  await Promise.all([
    deleteIndexedDBInstance(DB_NAME),
    deleteIndexedDBInstance(SETTINGS_DB_NAME)
  ]);

  clearLocalStorage();

  try { window?.dispatchEvent(new CustomEvent('triples-changed',  { detail: { db: DB_NAME, store: STORE_NAME, type: 'clear' } })); } catch {}
  try { window?.dispatchEvent(new CustomEvent('settings-changed', { detail: { db: SETTINGS_DB_NAME, store: SETTINGS_STORE_NAME, type: 'clear' } })); } catch {}
  try { window?.dispatchEvent(new CustomEvent('saved-queries-changed', { detail: { db: DB_NAME, store: QUERY_STORE_NAME, type: 'clear' } })); } catch {}
}