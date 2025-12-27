// indexeddb-triplestore.js
// Dependencies
  // idb : aka indexedDB
    // openDB

const DB_NAME = 'inferenceDB';
const STORE_NAME = 'triples';

const SETTINGS_DB_NAME = 'SPARQLSettings';
const SETTINGS_STORE_NAME = 'Settings';

/*
* Initializes the settings database with required object store.
* Creates the 'Settings' object store with 'key' as the keyPath.
* @returns {Promise<IDBPDatabase>} A promise that resolves to the database instance.
*/
async function initSettingsDB() {
  return idb.openDB(SETTINGS_DB_NAME, 1, {
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
      } catch {}
    }
    if (debuggingConsoleEnabled) console.warn('[saveSetting] failed:', e);
  }
}

 async function saveSetting(key, value) {
  const db = await initSettingsDB();
  await db.put(SETTINGS_STORE_NAME, { key, value });
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
 * Initializes the triple store database with required indexes.
 * Creates the 'triples' object store with indexes for subject, predicate, object, and graph.
 * @returns {Promise<IDBPDatabase>} A promise that resolves to the database instance.
 */
async function initTripleStore() {
  try {
    if (debuggingConsoleEnabled) {console.info('[initTripleStore] Initializing IndexedDB store...');}
    const db = await idb.openDB(DB_NAME, 1, {
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
      }
    });
    return db;
  } catch (error) {
    if (debuggingConsoleEnabled) {console.error('[initTripleStore] Failed to initialize store:', error);}
    throw error;
  }
};

/**
 * Adds RDF triples to the IndexedDB triple store.
 * @param {Array} triples - Array of rdflib.js triple objects.
 */
async function storeTriplesInNamedGraph(triples) {
  try {
    if (debuggingConsoleEnabled) {console.info(`[storeTriplesInNamedGraph] Adding ${triples.length} triples to IndexedDB`);}
    const db = await initTripleStore();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    for (const t of triples) {
      await store.put({
        subject: t.subject.value,
        subjectType: t.subject.termType,          // "NamedNode" | "BlankNode"
        predicate: t.predicate.value,
        predicateType: t.predicate.termType,      // should be "NamedNode"
        object: t.object.value,
        objectType: t.object.termType,            // "NamedNode" | "BlankNode" | "Literal"
        objectLang: t.object.lang || null,
        objectDatatype: t.object.datatype?.value || null,
        graph: t.graph ? t.graph.value : ''
      });
    }
    await tx.done;
    try { window?.dispatchEvent(new CustomEvent('triples-changed', { detail: { db: DB_NAME, store: STORE_NAME, type: 'put' } })); } catch {}
    if (debuggingConsoleEnabled) {console.info('[storeTriplesInNamedGraph] Triples successfully stored.');}
  } catch (error) {
    if (debuggingConsoleEnabled) {console.error('[storeTriplesInNamedGraph] Error storing triples:', error);}
    throw error;
  }
};

/**
 * Retrieves all triples from the triple store.
 * @returns {Promise<Array>} A promise that resolves to an array of all stored triples.
 */
async function getAllTriples () {
  try {
    const db = await initTripleStore();
    const triples = await db.getAll(STORE_NAME);
    if (debuggingConsoleEnabled) {console.info(`[getAllTriples] Retrieved ${triples.length} triples.`);}
    return triples;
  } catch (error) {
    if (debuggingConsoleEnabled) {console.error('[getAllTriples] Failed to fetch triples:', error);}
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

    if (debuggingConsoleEnabled) {console.info(`[getAllGraphNames] Found ${unique.length} named graphs`);}
    return unique;
  } catch (err) {
    if (debuggingConsoleEnabled) {console.error('[getAllGraphNames] Failed to retrieve graph names:', err);}
    return [];
  }
}

/**
 * Remove a batch of exact triples (subject,predicate,object,graph) from the store.
 * @param {Array<{subject:string,predicate:string,object:string,graph:string}>} triples
 */
const deleteExactTriples = async (triples=[]) => {
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
      if (debuggingConsoleEnabled) {console.warn('[deleteExactTriples] Failed to delete key', key, e);}
    }
  }
  await tx.done;
  if (debuggingConsoleEnabled) {console.info(`[deleteExactTriples] Removed ${removed}/${triples.length} triples.`);}
  return removed;
};


/**
 * Clears all triples from the triple store.
 */
async function clearTriples() {
  try {
    const db = await initTripleStore();
    await db.clear(STORE_NAME);
    try { window?.dispatchEvent(new CustomEvent('triples-changed', { detail: { db: DB_NAME, store: STORE_NAME, type: 'clear' } })); } catch {}
    if (debuggingConsoleEnabled) {console.info('[clearTriples] All triples cleared from store.');}
  } catch (error) {
    if (debuggingConsoleEnabled) {console.error('[clearTriples] Error clearing store:', error);}
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
    if (debuggingConsoleEnabled) {console.info(`[getTriplesByField] Retrieved ${results.length} triples for ${field}=${value}`);}
    return results;
  } catch (error) {
    if (debuggingConsoleEnabled) {console.error(`[getTriplesByField] Error retrieving by ${field}:`, error);}
    throw error;
  }
};


// Best-effort: close any open connections first (avoids 'blocked' state)
async function closeOpenIndexedDBConnections () {
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
    new Promise((resolve, reject) => {
      const req = indexedDB.deleteDatabase(name);
      req.onsuccess = () => {
        if (debuggingConsoleEnabled) {console.info(`[wipeActiveWorkspace] Deleted IndexedDB "${name}"`);}
        resolve();
      };
      req.onerror = () => {
        if (debuggingConsoleEnabled) {console.error(`[wipeActiveWorkspace] Failed to delete "${name}"`, req.error);}
        reject(req.error);
      };
      req.onblocked = () => {
        if (debuggingConsoleEnabled) {console.warn(`[wipeActiveWorkspace] Delete for "${name}" is blocked (another tab open?)`);}
      };
     });
 });
};

// Clear Browser's localStorage
function clearLocalStorage() {
  // Clear localStorage (if you prefer a narrower clear, replace with removals of known keys)
  try {
    localStorage.clear();
    if (debuggingConsoleEnabled) {console.info('[wipeActiveWorkspace] Cleared localStorage');}
  } catch (e) {
    if (debuggingConsoleEnabled) {console.warn('[wipeActiveWorkspace] Could not clear localStorage:', e);}
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

  try { window?.dispatchEvent(new CustomEvent('triples-changed',  { detail: { db: 'inferenceDB',  store: 'triples',  type: 'clear' } })); } catch {}
  try { window?.dispatchEvent(new CustomEvent('settings-changed', { detail: { db: 'SPARQLSettings', store: 'Settings', type: 'clear' } })); } catch {}
  try { notifyIdbChange?.({ db: 'inferenceDB',  store: 'triples',  type: 'clear' }); } catch {}
  try { notifyIdbChange?.({ db: 'SPARQLSettings', store: 'Settings', type: 'clear' }); } catch {}
}