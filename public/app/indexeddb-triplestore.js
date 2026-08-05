// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Jonathan Vajda

import { COMMON_NAMESPACE_IRIS } from './shared/namespace-registry/index.js';
import {
  DEFAULT_PROJECT_PORTFOLIO_PROJECT_ID,
  clearGraphQuadRows,
  createProjectPortfolioStores,
  createStableRecordId,
  deleteGraphRecordWithQuadRows,
  deleteIndexedDbDatabase,
  ensureProjectPortfolioProject,
  inspectLegacyIndexedDbDatabase,
  normalizeQuadRow,
  openProjectPortfolioDatabase,
  readLegacyObjectStoreRows,
  replaceGraphQuadRows
} from './shared/indexeddb-data-management/index.js';
import { debuggingConsoleEnabled } from './semantic-core.js';

const NS = COMMON_NAMESPACE_IRIS;

const LEGACY_TRIPLE_DB_NAME = 'inferenceDB';
const LEGACY_TRIPLE_STORE_NAME = 'triples';
const LEGACY_QUERY_STORE_NAME = 'savedQueries';
const LEGACY_SETTINGS_DB_NAME = 'SPARQLSettings';
const LEGACY_SETTINGS_STORE_NAME = 'Settings';

const AXIOLOTL_APP_ID = 'axiolotl';
const AXIOLOTL_PROJECT_LABEL = 'Default Cross-App Workspace';
const QUERY_ARTIFACT_KIND = 'sparql-query';
const DEFAULT_GRAPH_LABEL = 'Default graph';

const QUERY_IRI = {
  class: 'https://github.com/jonathanvajda/SemanticArtifactOntology/ont000007',
  predicate: 'https://github.com/jonathanvajda/SemanticArtifactOntology/has_sparql_query_text_value',
  label: NS.rdfs.label
};

let portfolioPromise = null;
let legacyMigrationPromise = null;

/**
 * Clears cached shared store handles for deterministic tests.
 *
 * @returns {void}
 */
function resetAxiolotlProjectStorageForTests() {
  portfolioPromise = null;
  legacyMigrationPromise = null;
}

async function openAxiolotlProjectStores() {
  if (!portfolioPromise) {
    portfolioPromise = openProjectPortfolioDatabase()
      .then(async (db) => {
        const stores = createProjectPortfolioStores(db, {
          projectId: DEFAULT_PROJECT_PORTFOLIO_PROJECT_ID
        });
        await ensureProjectPortfolioProject(stores, {
          projectId: DEFAULT_PROJECT_PORTFOLIO_PROJECT_ID,
          label: AXIOLOTL_PROJECT_LABEL,
          tags: ['cross-app', AXIOLOTL_APP_ID]
        });
        return stores;
      });
  }
  return portfolioPromise;
}

async function migrateLegacyAxiolotlDataIfNeeded() {
  if (!legacyMigrationPromise) {
    legacyMigrationPromise = migrateLegacyAxiolotlData();
  }
  return legacyMigrationPromise;
}

async function migrateLegacyAxiolotlData() {
  const stores = await openAxiolotlProjectStores();
  const [quadCount, queryArtifacts, settings] = await Promise.all([
    stores.quadRows.countQuadRows({ projectId: DEFAULT_PROJECT_PORTFOLIO_PROJECT_ID }),
    stores.artifacts.listProjectArtifacts(DEFAULT_PROJECT_PORTFOLIO_PROJECT_ID, {
      artifactKind: QUERY_ARTIFACT_KIND
    }),
    stores.settings.listSettingRecords()
  ]);

  if (quadCount === 0) {
    const legacyTriples = await safeReadLegacyRows(LEGACY_TRIPLE_DB_NAME, LEGACY_TRIPLE_STORE_NAME);
    if (legacyTriples.length) {
      await storeTriplesInNamedGraphInternal(legacyTriples, {
        migratedFromLegacy: true,
        dispatchEvent: false
      });
    }
  }

  if (queryArtifacts.length === 0) {
    const legacyQueries = await safeReadLegacyRows(LEGACY_TRIPLE_DB_NAME, LEGACY_QUERY_STORE_NAME);
    for (const row of legacyQueries) {
      if (!row?.id) continue;
      await saveSavedQueryInternal(row, {
        migratedFromLegacy: true,
        dispatchEvent: false
      });
    }
  }

  if (settings.length === 0) {
    const legacySettings = await safeReadLegacyRows(LEGACY_SETTINGS_DB_NAME, LEGACY_SETTINGS_STORE_NAME);
    for (const row of legacySettings) {
      if (!row?.key) continue;
      await saveSettingInternal(row.key, row.value, {
        migratedFromLegacy: true,
        dispatchEvent: false
      });
    }
  }
}

async function initSettingsDB() {
  await openAxiolotlProjectStores();
  await migrateLegacyAxiolotlDataIfNeeded();
  return { backend: 'shared-project-portfolio', store: LEGACY_SETTINGS_STORE_NAME };
}

async function getSetting(key) {
  try {
    await migrateLegacyAxiolotlDataIfNeeded();
    const stores = await openAxiolotlProjectStores();
    return await stores.settings.readSettingValue(String(key || '').trim(), undefined);
  } catch (error) {
    if (debuggingConsoleEnabled) console.warn('[getSetting] failed:', error);
    return undefined;
  }
}

async function saveSetting(key, value) {
  await saveSettingInternal(key, value);
}

async function saveSettingInternal(key, value, { migratedFromLegacy = false, dispatchEvent = true } = {}) {
  const stores = await openAxiolotlProjectStores();
  await stores.settings.storeSettingRecord({
    scope: DEFAULT_PROJECT_PORTFOLIO_PROJECT_ID,
    key: String(key || '').trim(),
    value,
    appId: AXIOLOTL_APP_ID,
    metadata: migratedFromLegacy
      ? { migratedFrom: { databaseName: LEGACY_SETTINGS_DB_NAME, storeName: LEGACY_SETTINGS_STORE_NAME } }
      : {}
  });
  if (dispatchEvent) dispatchStorageEvent('settings-changed', {
    db: 'OntologyWorkbenchProjects',
    store: 'settings',
    type: 'put',
    key
  });
}

async function clearSettingsStore() {
  const stores = await openAxiolotlProjectStores();
  const records = await stores.settings.listSettingRecords();
  await Promise.all(records.map((record) => stores.settings.deleteSettingRecord(record.key)));
  dispatchStorageEvent('settings-changed', {
    db: 'OntologyWorkbenchProjects',
    store: 'settings',
    type: 'clear'
  });
}

async function initQueryStore() {
  await openAxiolotlProjectStores();
  await migrateLegacyAxiolotlDataIfNeeded();
  return { backend: 'shared-project-portfolio', store: 'artifacts' };
}

async function saveSavedQuery(record) {
  return saveSavedQueryInternal(record);
}

async function saveSavedQueryInternal(record, { migratedFromLegacy = false, dispatchEvent = true } = {}) {
  const normalized = normalizeSavedQueryRecord(record);
  const stores = await openAxiolotlProjectStores();
  await stores.artifacts.storeProjectArtifact({
    artifactId: normalized.id,
    projectId: DEFAULT_PROJECT_PORTFOLIO_PROJECT_ID,
    artifactKind: QUERY_ARTIFACT_KIND,
    role: 'query',
    label: normalized.label,
    mediaType: 'application/sparql-query',
    extension: 'rq',
    createdAt: normalized.createdAt,
    updatedAt: normalized.updatedAt || normalized.createdAt,
    source: { appId: AXIOLOTL_APP_ID },
    metadata: {
      queryType: normalized.type,
      ...(migratedFromLegacy
        ? { migratedFrom: { databaseName: LEGACY_TRIPLE_DB_NAME, storeName: LEGACY_QUERY_STORE_NAME } }
        : {})
    }
  }, normalized.value);
  if (dispatchEvent) dispatchStorageEvent('saved-queries-changed', {
    db: 'OntologyWorkbenchProjects',
    store: 'artifacts',
    type: 'put',
    key: normalized.id
  });
  return normalized;
}

async function getSavedQueryById(id) {
  await migrateLegacyAxiolotlDataIfNeeded();
  const stores = await openAxiolotlProjectStores();
  const artifact = await stores.artifacts.getProjectArtifact(id);
  return artifact ? artifactToSavedQueryRecord(artifact) : undefined;
}

async function getAllSavedQueries() {
  await migrateLegacyAxiolotlDataIfNeeded();
  const stores = await openAxiolotlProjectStores();
  const artifacts = await stores.artifacts.listProjectArtifacts(DEFAULT_PROJECT_PORTFOLIO_PROJECT_ID, {
    artifactKind: QUERY_ARTIFACT_KIND
  });
  return artifacts
    .map(artifactToSavedQueryRecord)
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

async function deleteSavedQuery(id) {
  const stores = await openAxiolotlProjectStores();
  await stores.artifacts.deleteProjectArtifact(id);
  dispatchStorageEvent('saved-queries-changed', {
    db: 'OntologyWorkbenchProjects',
    store: 'artifacts',
    type: 'delete',
    key: id
  });
}

function savedQueryRecordToJsonLd(record) {
  return {
    '@id': record.id,
    '@type': [record.type, NS.owl.NamedIndividual],
    [QUERY_IRI.predicate]: [{ '@value': record.value }],
    [QUERY_IRI.label]: [{ '@value': record.label }]
  };
}

async function exportSavedQueriesAsJsonLd() {
  return (await getAllSavedQueries()).map(savedQueryRecordToJsonLd);
}

function savedQueriesToCsv(rows) {
  return import('./shared/tabular-io/index.js').then(({ serializeQueryRecordsToDelimitedText }) =>
    serializeQueryRecordsToDelimitedText(rows.map((row) => ({
      queryId: row.id,
      queryLabel: row.label,
      queryLanguage: 'sparql',
      queryText: row.value,
      queryKind: row.type
    })), {
      trailingNewline: false,
      defaultQueryLanguage: 'sparql'
    })
  );
}

async function exportSavedQueriesAsCsv() {
  return savedQueriesToCsv(await getAllSavedQueries());
}

function parseSavedQueriesCsv(csvText) {
  return import('./shared/tabular-io/index.js').then(({ parseQueryRecordsFromDelimitedText }) =>
    parseQueryRecordsFromDelimitedText(csvText, {
      defaultQueryLanguage: 'sparql'
    }).records.map((row) => ({
      id: row.queryId,
      label: row.queryLabel,
      type: row.queryKind || QUERY_IRI.class,
      value: row.queryText
    }))
  );
}

async function importSavedQueriesFromCsv(csvText) {
  const rows = await parseSavedQueriesCsv(csvText);
  for (const row of rows) {
    if (!row.id || !row.type) continue;
    await saveSavedQueryInternal({
      ...row,
      createdAt: new Date().toISOString()
    }, { dispatchEvent: false });
  }
  dispatchStorageEvent('saved-queries-changed', {
    db: 'OntologyWorkbenchProjects',
    store: 'artifacts',
    type: 'bulk-import'
  });
  return { count: rows.length };
}

async function clearSavedQueries() {
  const rows = await getAllSavedQueries();
  const stores = await openAxiolotlProjectStores();
  await Promise.all(rows.map((row) => stores.artifacts.deleteProjectArtifact(row.id)));
  dispatchStorageEvent('saved-queries-changed', {
    db: 'OntologyWorkbenchProjects',
    store: 'artifacts',
    type: 'clear'
  });
}

async function initTripleStore() {
  await openAxiolotlProjectStores();
  await migrateLegacyAxiolotlDataIfNeeded();
  return { backend: 'shared-project-portfolio', store: 'quadRows' };
}

async function storeTriplesInNamedGraph(triples) {
  return storeTriplesInNamedGraphInternal(triples);
}

async function storeTriplesInNamedGraphInternal(triples, { migratedFromLegacy = false, dispatchEvent = true } = {}) {
  const rows = (Array.isArray(triples) ? triples : []).map((triple) => normalizeAxiolotlTripleRow(triple, { migratedFromLegacy }));
  const stores = await openAxiolotlProjectStores();
  await stores.quadRows.upsertQuadRows(rows);
  await storeGraphRecordsForRows(stores, rows, migratedFromLegacy);
  if (dispatchEvent) dispatchStorageEvent('triples-changed', {
    db: 'OntologyWorkbenchProjects',
    store: 'quadRows',
    type: 'put'
  });
}

async function getAllTriples() {
  await migrateLegacyAxiolotlDataIfNeeded();
  const stores = await openAxiolotlProjectStores();
  return (await stores.quadRows.listQuadRows({ projectId: DEFAULT_PROJECT_PORTFOLIO_PROJECT_ID }))
    .map(quadRowToLegacyTripleRow);
}

async function getAllGraphNames() {
  const rows = await getAllTriples();
  return [...new Set(rows.map((row) => row.graph).filter(Boolean))].sort();
}

async function countAllTriples() {
  await migrateLegacyAxiolotlDataIfNeeded();
  const stores = await openAxiolotlProjectStores();
  return stores.quadRows.countQuadRows({ projectId: DEFAULT_PROJECT_PORTFOLIO_PROJECT_ID });
}

async function countNamedGraphs() {
  return (await getAllGraphNames()).length;
}

const deleteExactTriples = async (triples = []) => {
  const stores = await openAxiolotlProjectStores();
  const rows = (Array.isArray(triples) ? triples : []).map(normalizeAxiolotlTripleRow);
  const removed = await stores.quadRows.deleteQuadRows(rows);
  dispatchStorageEvent('triples-changed', {
    db: 'OntologyWorkbenchProjects',
    store: 'quadRows',
    type: 'delete'
  });
  return removed;
};

async function clearTriples() {
  const stores = await openAxiolotlProjectStores();
  await stores.quadRows.clearQuadRows({ projectId: DEFAULT_PROJECT_PORTFOLIO_PROJECT_ID });
  const graphs = await stores.graphs.listGraphRecords(DEFAULT_PROJECT_PORTFOLIO_PROJECT_ID);
  await Promise.all(graphs.map((graph) => stores.graphs.deleteGraphRecord(graph.graphId)));
  dispatchStorageEvent('triples-changed', {
    db: 'OntologyWorkbenchProjects',
    store: 'quadRows',
    type: 'clear'
  });
}

const getTriplesByField = async (field, value) => {
  const rows = await getAllTriples();
  return rows.filter((row) => row[field] === value);
};

async function closeOpenIndexedDBConnections() {
  resetAxiolotlProjectStorageForTests();
}

async function deleteIndexedDBInstance(name) {
  return deleteIndexedDbDatabase(name).then((deleted) => ({ name, deleted, blocked: false }));
}

async function wipeActiveWorkspace() {
  await clearActiveWorkspace();
}

async function clearActiveWorkspace() {
  await Promise.all([
    clearTriples(),
    clearSettingsStore(),
    clearSavedQueries()
  ]);
}

async function hardResetDatabases() {
  await clearActiveWorkspace();
}

async function clearGraph(graphIRI) {
  const stores = await openAxiolotlProjectStores();
  const graphId = createGraphId(graphIRI || '');
  const graph = await stores.graphs.getGraphRecord(graphId);
  if (graph) await deleteGraphRecordWithQuadRows(stores, graphId);
  else await stores.quadRows.clearQuadRows({ projectId: DEFAULT_PROJECT_PORTFOLIO_PROJECT_ID, graph: graphIRI || null });
  dispatchStorageEvent('triples-changed', {
    db: 'OntologyWorkbenchProjects',
    store: 'quadRows',
    type: 'clear-graph',
    graph: graphIRI || ''
  });
}

async function replaceGraphRows(graphIRI, triples) {
  const stores = await openAxiolotlProjectStores();
  const graphId = createGraphId(graphIRI || '');
  const rows = (Array.isArray(triples) ? triples : []).map((triple) => normalizeAxiolotlTripleRow({
    ...triple,
    graph: graphIRI || ''
  }));
  await replaceGraphQuadRows(stores, createGraphRecord(graphIRI || '', rows.length), rows);
}

async function clearGraphRows(graphIRI) {
  const stores = await openAxiolotlProjectStores();
  return clearGraphQuadRows(stores, createGraphId(graphIRI || ''));
}

async function safeReadLegacyRows(dbName, storeName) {
  try {
    const status = await inspectLegacyIndexedDbDatabase(dbName);
    if (!status.exists) return [];
    return await readLegacyObjectStoreRows(dbName, storeName);
  } catch {
    return [];
  }
}

function normalizeSavedQueryRecord(record) {
  return {
    id: String(record?.id || createStableRecordId('artifact:axiolotl-query', [record?.label || record?.value || Date.now()])).trim(),
    label: String(record?.label || 'Saved SPARQL query').trim(),
    type: String(record?.type || QUERY_IRI.class).trim(),
    value: String(record?.value ?? ''),
    createdAt: record?.createdAt || new Date().toISOString(),
    updatedAt: record?.updatedAt || record?.createdAt || new Date().toISOString()
  };
}

function artifactToSavedQueryRecord(artifact) {
  return {
    id: artifact.artifactId,
    label: artifact.label,
    type: artifact.metadata?.queryType || QUERY_IRI.class,
    value: typeof artifact.payload === 'string' ? artifact.payload : String(artifact.payload ?? ''),
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt
  };
}

function normalizeAxiolotlTripleRow(triple, { migratedFromLegacy = false } = {}) {
  const graph = normalizeIriString(
    typeof triple?.graph === 'string'
      ? triple.graph
      : (triple?.graph?.value || triple?.g || triple?.why?.value || '')
  ) || null;
  const graphId = createGraphId(graph || '');
  return normalizeQuadRow({
    projectId: DEFAULT_PROJECT_PORTFOLIO_PROJECT_ID,
    graphId,
    subject: typeof triple?.subject === 'string' ? triple.subject : (triple?.subject?.value ?? triple?.s),
    subjectType: triple?.subjectType ?? triple?.subject?.termType ?? triple?.sType ?? 'NamedNode',
    predicate: typeof triple?.predicate === 'string' ? triple.predicate : (triple?.predicate?.value ?? triple?.p),
    predicateType: triple?.predicateType ?? triple?.predicate?.termType ?? triple?.pType ?? 'NamedNode',
    object: typeof triple?.object === 'string' ? triple.object : (triple?.object?.value ?? triple?.o),
    objectType: triple?.objectType ?? triple?.object?.termType ?? triple?.oType ?? 'NamedNode',
    objectLang: triple?.objectLang ?? triple?.object?.lang ?? triple?.object?.language ?? triple?.lang ?? '',
    objectDatatype: triple?.objectDatatype ?? triple?.object?.datatype?.value ?? triple?.datatype ?? '',
    graph,
    metadata: migratedFromLegacy ? { migratedFrom: LEGACY_TRIPLE_DB_NAME } : {}
  });
}

function quadRowToLegacyTripleRow(row) {
  return {
    subject: row.subject,
    subjectType: row.subjectType,
    predicate: row.predicate,
    predicateType: row.predicateType,
    object: row.object,
    objectType: row.objectType,
    objectLang: row.objectLang || null,
    objectDatatype: row.objectDatatype || null,
    graph: row.graph || ''
  };
}

async function storeGraphRecordsForRows(stores, rows, migratedFromLegacy = false) {
  const byGraph = new Map();
  for (const row of rows) {
    const graph = row.graph || '';
    byGraph.set(graph, (byGraph.get(graph) || 0) + 1);
  }
  await Promise.all([...byGraph.entries()].map(([graph, count]) =>
    stores.graphs.storeGraphRecord(createGraphRecord(graph, count, migratedFromLegacy))
  ));
}

function createGraphRecord(graph, quadCount = 0, migratedFromLegacy = false) {
  return {
    graphId: createGraphId(graph),
    projectId: DEFAULT_PROJECT_PORTFOLIO_PROJECT_ID,
    graphIri: graph || null,
    role: 'loaded',
    label: graph || DEFAULT_GRAPH_LABEL,
    source: { appId: AXIOLOTL_APP_ID },
    materialization: {
      strategy: 'materialized-on-import',
      status: 'ready',
      quadCount,
      indexedAt: new Date().toISOString()
    },
    metadata: migratedFromLegacy
      ? { migratedFrom: { databaseName: LEGACY_TRIPLE_DB_NAME, storeName: LEGACY_TRIPLE_STORE_NAME } }
      : {}
  };
}

function createGraphId(graph) {
  return createStableRecordId('graph:axiolotl', [graph || 'default']);
}

function normalizeIriString(s) {
  if (typeof s !== 'string') return s;
  let text = s.trim();
  if (text.length >= 2 && text[0] === '<' && text[text.length - 1] === '>') {
    text = text.slice(1, -1).trim();
  }
  return text;
}

function dispatchStorageEvent(name, detail) {
  try {
    window?.dispatchEvent(new CustomEvent(name, { detail }));
  } catch {}
}

export {
  QUERY_IRI,
  initSettingsDB,
  getSetting,
  saveSetting,
  clearSettingsStore,
  initQueryStore,
  saveSavedQuery,
  getSavedQueryById,
  getAllSavedQueries,
  deleteSavedQuery,
  savedQueryRecordToJsonLd,
  exportSavedQueriesAsJsonLd,
  savedQueriesToCsv,
  exportSavedQueriesAsCsv,
  parseSavedQueriesCsv,
  importSavedQueriesFromCsv,
  clearSavedQueries,
  initTripleStore,
  storeTriplesInNamedGraph,
  getAllTriples,
  getAllGraphNames,
  countAllTriples,
  countNamedGraphs,
  deleteExactTriples,
  clearTriples,
  getTriplesByField,
  closeOpenIndexedDBConnections,
  deleteIndexedDBInstance,
  wipeActiveWorkspace,
  clearActiveWorkspace,
  hardResetDatabases,
  clearGraph,
  replaceGraphRows,
  clearGraphRows,
  resetAxiolotlProjectStorageForTests
};
