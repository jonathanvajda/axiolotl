import {
  assertNonEmptyRdfGraphExport,
  createRdfGraphExportDataset,
  selectRdfGraphExportQuads,
  serializeRdfGraphExport
} from './shared/rdf-io/index.js';

/**
 * Selects quads for an Axiolotl active-workspace export.
 *
 * @param {object} store - RDF/JS dataset-like store with `getQuads()`.
 * @param {'default'|'named'|'all'} scope - Export scope.
 * @param {object} runtime - Runtime containing `N3`.
 * @returns {object[]} Selected quads.
 */
export function selectWorkspaceExportQuads(store, scope = 'default', runtime = {}) {
  return selectRdfGraphExportQuads(store, {
    scope,
    defaultGraphTerm: runtime.N3?.DataFactory?.defaultGraph
      ? runtime.N3.DataFactory.defaultGraph()
      : undefined
  });
}

/**
 * Creates a runtime-native dataset for an Axiolotl active-workspace export.
 *
 * @param {object} store - Source RDF/JS dataset-like store.
 * @param {'default'|'named'|'all'} scope - Export scope.
 * @param {object} runtime - Runtime containing `N3`.
 * @returns {object} Dataset-like object for serialization.
 */
export function createWorkspaceExportStore(store, scope = 'default', runtime = {}) {
  return createRdfGraphExportDataset(store, {
    scope,
    runtime
  });
}

/**
 * Serializes an Axiolotl active-workspace export.
 *
 * @param {object} store - RDF/JS dataset-like store.
 * @param {object} options - Export options.
 * @param {'default'|'named'|'all'} [options.scope='default'] - Export scope.
 * @param {string} [options.mimeType='text/turtle'] - Output MIME type.
 * @param {object} options.runtime - Runtime containing N3/jsonld/rdflib libraries.
 * @returns {Promise<{text: string, count: number, mimeType: string}>} Serialized export.
 */
export async function serializeWorkspaceExport(store, options = {}) {
  return serializeRdfGraphExport(store, {
    scope: options.scope || 'default',
    format: options.mimeType || options.mime || 'text/turtle',
    runtime: options.runtime || {}
  });
}

export {
  assertNonEmptyRdfGraphExport as assertNonEmptyWorkspaceSerialization
};
