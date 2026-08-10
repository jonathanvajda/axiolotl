// Dependencies
//   comunica-browser.js
//     QueryEngine
//   indexeddb-triplestore.js
//     storeTriplesInNamedGraph
//     getAllTriples
//     clearTriples
//   rdflib.js
//     $rdf
import {
  clearGraph as clearGraphFromProjectStorage,
  clearSavedQueries,
  clearSettingsStore,
  clearTriples,
  getAllGraphNames,
  getAllTriples,
  getTriplesByField,
  initTripleStore,
  storeTriplesInNamedGraph,
  wipeActiveWorkspace
} from './indexeddb-triplestore.js';
import {
  commonSPARQLPrefixes,
  debuggingConsoleEnabled,
  showToast
} from './semantic-core.js';
import { readFileAsText } from './shared/browser-file-io/index.js';
import { getSupportedMimeTypeForFilename } from './shared/format-registry/index.js';
import {
  parseRdfTextWithAdapters,
  rdfJsTermToRdflib
} from './shared/rdf-io/index.js';
import {
  createTimestampedGraphIri,
  isAbsoluteIri,
  isBlankNodeId,
  normalizeIriToken
} from './shared/ontology-utils/index.js';
import {
  classifySparqlOperationFamily,
  buildSparqlUpdatePreviewConstructs,
  describeSparqlUpdateShape
} from './shared/sparql-utils/index.js';

const engine = new Comunica.QueryEngine();
// N3 RDF/JS terms & store
const { DataFactory, Store } = N3;
const { namedNode, blankNode, literal, quad, defaultGraph } = DataFactory;

/* -----------------------------
   IRI / term-kind detection
   ----------------------------- */

// Objects: NamedNode (absolute IRI), BlankNode, or Literal
function looksLikeBnodeId(v) {
  return typeof v === 'string' && (isBlankNodeId(v) || v.startsWith('_g_') || /^[A-Za-z]\d+$/.test(v));
}

/* -----------------------------
   Consolidated rdflib.js helpers
   Use type metadata when present; fallback to heuristics
   ----------------------------- */

// Subjects: either NamedNode (absolute IRI) or BlankNode
function asSubjectTerm(v, type) {
  if ((type === 'NamedNode') && isAbsoluteIri(v)) return $rdf.sym(v);
  if (isAbsoluteIri(v)) return $rdf.sym(v); // fallback if metadata missing
  // subjects canâ€™t be literals â†’ use bnode if not an absolute IRI
  const id = String(v || '').replace(/^_:/, '').replace(/^_g_/, '');
  return $rdf.blankNode(id || 's');
}

// Predicates: must be absolute IRI
function asPredicateTerm(v, type) {
  if ((type === 'NamedNode') && isAbsoluteIri(v)) return $rdf.sym(v);
  if (isAbsoluteIri(v)) return $rdf.sym(v); // fallback if metadata missing
  throw new Error(`Predicate must be absolute IRI: ${String(v)}`);
}

// Objects: NamedNode (absolute IRI), BlankNode, or Literal
function asObjectTerm(v, type, lang, datatype) {
  if ((type === 'NamedNode') && isAbsoluteIri(v)) return $rdf.sym(v);
  if (type === 'BlankNode' || looksLikeBnodeId(v)) {
    const id = String(v || '').replace(/^_:/, '').replace(/^_g_/, '');
    return $rdf.blankNode(id || 'o');
  }
  if (lang) return $rdf.literal(v ?? '', lang);
  if (datatype) return $rdf.literal(v ?? '', undefined, $rdf.sym(datatype));
  if (isAbsoluteIri(v)) return $rdf.sym(v); // last-chance fallback
  return $rdf.literal(v ?? '');
}

/* -----------------------------
   RDFJS (N3) helpers for Comunica
   Use type metadata when present; fallback to heuristics
   ----------------------------- */

// Helpers to convert stored shapes to RDFJS terms
// (supports multiple persisted shapes: {s,p,o,g} or {subject,predicate,object,graph})

// Subjects: either NamedNode (absolute IRI) or BlankNode
function asRdfjsSubject(v, type) {
  const iri = typeof v === 'string' ? normalizeIriToken(v) : v;
  if ((type === 'NamedNode') && isAbsoluteIri(iri)) return namedNode(iri);
  if (isAbsoluteIri(iri)) return namedNode(iri);
  return blankNode(String(v || '').replace(/^_:/, '').replace(/^_g_/, ''));
}

// Predicates: must be absolute IRI
function asRdfjsPredicate(v, type) {
  const iri = typeof v === 'string' ? normalizeIriToken(v) : v;
  if ((type === 'NamedNode') && isAbsoluteIri(iri)) return namedNode(iri);
  if (isAbsoluteIri(iri)) return namedNode(iri);
  throw new Error(`Predicate must be absolute IRI: ${String(v)}`);
}

// Objects: NamedNode (absolute IRI), BlankNode, or Literal
function asRdfjsObject(v, type, lang, datatype) {
  const iri = typeof v === 'string' ? normalizeIriToken(v) : v;
  if ((type === 'NamedNode') && isAbsoluteIri(iri)) return namedNode(iri);
  if (type === 'BlankNode' || looksLikeBnodeId(v)) {
    return blankNode(String(v).replace(/^_:/, '').replace(/^_g_/, ''));
  }
  if (lang) return literal(v ?? '', lang);
  if (datatype) return literal(v ?? '', namedNode(normalizeIriToken(datatype)));
  if (isAbsoluteIri(iri)) return namedNode(iri);
  return literal(v ?? '');
}

async function loadGraphFromIndexedDB() {
  const triples = await getAllTriples();
  const store = new N3.Store();

  for (const t of triples) {
    const sVal = t.subject ?? t.s;
    const pVal = t.predicate ?? t.p;
    const oVal = t.object ?? t.o;
    const gVal = t.graph ?? t.g ?? '';

    const s = asRdfjsSubject(sVal, t.subjectType ?? t.sType);
    const p = asRdfjsPredicate(pVal, t.predicateType ?? t.pType);
    const o = asRdfjsObject(
      oVal,
      t.objectType ?? t.oType,
      t.objectLang ?? t.lang,
      t.objectDatatype ?? t.datatype
    );
    const g = (typeof gVal === 'string' && gVal.trim() !== '')
      ? N3.DataFactory.namedNode(gVal.trim())
      : N3.DataFactory.defaultGraph();

    store.addQuad(N3.DataFactory.quad(s, p, o, g));
  }

  return store;
}

/**
 * Parses N-Triples with N3.js. rdflib.js does not accept the
 * application/n-triples media type in this browser build.
 * @param {string} rdfText - Raw N-Triples text.
 * @param {$rdf.Formula} targetGraph - The rdflib graph to populate.
 * @param {string} graphIRI - Optional named graph IRI.
 * @returns {number} Number of parsed statements.
 */
async function parseNTriplesIntoNamedGraph(rdfText, targetGraph, graphIRI) {
  const parsed = await parseRdfTextWithAdapters(rdfText, {
    format: 'application/n-triples',
    baseIri: 'http://example.org/',
    runtime: { N3, $rdf }
  });
  const graphSym = graphIRI ? $rdf.sym(graphIRI) : undefined;

  parsed.quads.forEach(q => {
    targetGraph.add(
      rdfJsTermToRdflib(q.subject, $rdf),
      rdfJsTermToRdflib(q.predicate, $rdf),
      rdfJsTermToRdflib(q.object, $rdf),
      graphSym
    );
  });

  return parsed.quads.length;
}

/**
 * Parses RDF content and adds statements to a target graph under a given named graph.
 * @param {string} rdfText - The raw RDF content.
 * @param {$rdf.Formula} targetGraph - The rdflib graph to populate.
 * @param {string} graphIRI - The named graph IRI to assign to each triple.
 * @param {string} mimeType - The RDF MIME type (e.g., text/turtle, application/rdf+xml).
 * @returns {Promise<void>}
 */
const parseIntoNamedGraph = async (rdfText, targetGraph, graphIRI, mimeType) => {
  if (mimeType === 'application/n-triples') {
    try {
      const count = await parseNTriplesIntoNamedGraph(rdfText, targetGraph, graphIRI);
      if (debuggingConsoleEnabled) {console.info(
        `[parseIntoNamedGraph] Added ${count} N-Triples statements to ` +
        (graphIRI ? `graph <${graphIRI}>` : 'the default graph')
      )};
      return;
    } catch (err) {
      if (debuggingConsoleEnabled) {console.error('[parseIntoNamedGraph] Error parsing N-Triples with N3.js:', err)};
      throw err;
    }
  }

  const parsed = await parseRdfTextWithAdapters(rdfText, {
    format: mimeType,
    baseIri: 'http://example.org/',
    runtime: { N3, jsonld: globalThis.jsonld, $rdf }
  });
  const graphSym = graphIRI ? $rdf.sym(graphIRI) : undefined;
  parsed.quads.forEach(q => {
    targetGraph.add(
      rdfJsTermToRdflib(q.subject, $rdf),
      rdfJsTermToRdflib(q.predicate, $rdf),
      rdfJsTermToRdflib(q.object, $rdf),
      graphSym
    );
  });
  if (debuggingConsoleEnabled) {console.info(
    `[parseIntoNamedGraph] Added ${parsed.quads.length} statements to ` +
    (graphIRI ? `graph <${graphIRI}>` : 'the default graph')
  )};};

/**
 * Serializes an rdflib graph and runs a SPARQL UPDATE query against it using Comunica.
 * @param {string} updateQuery - The SPARQL UPDATE string.
 * @param {$rdf.Formula} graph - The rdflib graph to operate on.
 * @returns {Promise<$rdf.Formula>} A promise resolving to the updated graph.
 */
const applyUpdateWithComunica = async (updateQuery, graph) => {
  // NOTE: Running UPDATE against a read-only stringSource cannot mutate `graph`.
  // We intentionally do NOT serialize any result here because UPDATE has no stream output.
  // Prefer the CONSTRUCT path for inference.
  if (debuggingConsoleEnabled) {console.warn('[applyUpdateWithComunica] UPDATE against stringSource is a no-op; prefer CONSTRUCT.')};
  const comunica = engine;
  const text = graph.serialize(null, undefined, 'text/turtle');
  const source = { type: 'stringSource', value: text, mediaType: 'text/turtle' };
  await comunica.queryVoid(updateQuery, {
    sources: [source],
    baseIRI: 'http://example.org/',
    lenient: true
  });
  return graph;
  // If youâ€™d rather fail loudly so no one uses this path:
  // throw new Error('applyUpdateWithComunica is not supported for stringSource; use CONSTRUCT-based inference.');
};


async function collectQueryResult(result) {
  if (result.type === 'bindings') {
    const { data } = await engine.resultToString(result, 'application/sparql-results+json');
    let json = '';
    await new Promise((resolve, reject) => {
      data.on('data', chunk => { json += chunk; });
      data.on('end', resolve);
      data.on('error', reject);
    });
    const parsed = JSON.parse(json);
    return {
      vars: parsed?.head?.vars || [],
      rows: parsed?.results?.bindings || []
    };
  }

  if (result.type === 'boolean') {
    const bool = await result.booleanResult;
    return {
      vars: ['ASK'],
      rows: [{ ASK: { type: 'literal', value: String(bool) } }]
    };
  }

  if (result.type === 'quads') {
    const { data } = await engine.resultToString(result, 'application/n-triples');
    let nt = '';
    await new Promise((resolve, reject) => {
      data.on('data', chunk => { nt += chunk; });
      data.on('end', resolve);
      data.on('error', reject);
    });
    return nt
      .split('\n')
      .filter(Boolean)
      .map(line => ({ nt: { value: line } }));
  }

  return { vars: [], rows: [] };
}

async function runQueryOnLocalDataset(query) {
  const store = await loadGraphFromIndexedDB();

  const result = await engine.query(query, {
    sources: [{ type: 'rdfjsSource', value: store }],
  });

  try {
    const asJson = await engine.resultToString(result, 'application/sparql-results+json');
    let jsonText = '';
    await new Promise((resolve, reject) => {
      asJson.data.on('data', chunk => { jsonText += chunk; });
      asJson.data.on('end', resolve);
      asJson.data.on('error', reject);
    });

    const parsed = JSON.parse(jsonText);
    if ('boolean' in parsed) {
      return {
        vars: ['ASK'],
        rows: [{ ASK: { type: 'literal', value: String(!!parsed.boolean) } }]
      };
    }
    return {
      vars: parsed.head?.vars || [],
      rows: parsed.results?.bindings || []
    };
  } catch (_) {
    const asNT = await engine.resultToString(result, 'application/n-triples');
    let nt = '';
    await new Promise((resolve, reject) => {
      asNT.data.on('data', chunk => { nt += chunk; });
      asNT.data.on('end', resolve);
      asNT.data.on('error', reject);
    });
    return nt.split('\n').filter(Boolean).map(line => ({ nt: { value: line } }));
  }
}

/**
 * Executes a SPARQL query against a specific named graph stored in IndexedDB using Comunica.
 * 
 * @param {string} graphIRI - The IRI of the named graph to query.
 * @param {string} query - The SPARQL SELECT/ASK/CONSTRUCT query string to evaluate.
 * @returns {Promise<Array>} - Resolves with an array of bindings (or results depending on query type).
 */
async function queryFromNamedGraph(graphIRI, query) {
  try {
    if (debuggingConsoleEnabled) {console.info(`[queryFromNamedGraph] Querying named graph <${graphIRI}>`)};

    // Step 1: Get all triples for the named graph
    const triples = await getTriplesByField('graph', graphIRI);
    if (!triples.length) {
      if (debuggingConsoleEnabled) {console.warn(`[queryFromNamedGraph] No triples found for graph: <${graphIRI}>`)};
      return { vars: [], rows: [] };
    }

    // Step 2: Convert stored triples to proper RDFJS quads
    const quads = triples.map(t => quad(
      asRdfjsSubject(t.subject ?? t.s, t.subjectType ?? t.sType),
      asRdfjsPredicate(t.predicate ?? t.p, t.predicateType ?? t.pType),
      asRdfjsObject(
        t.object ?? t.o,
        t.objectType ?? t.oType,
        t.objectLang ?? t.lang,
        t.objectDatatype ?? t.datatype
      ),
      (t.graph && String(t.graph).trim()) ? namedNode(t.graph) : defaultGraph()
    ));

    // Step 3: Query over an RDFJS Store (a real RDFJS Source)
    const store = new Store(quads);
    const result = await engine.query(query, {
      sources: [{ type: 'rdfjsSource', value: store }],
    });

    // Step 4: Collect and return results
    if (result.type === 'bindings') {
      // Produce SPARQL JSON bindings so your UI table code can render them
      const { data } = await engine.resultToString(result, 'application/sparql-results+json');
      let json = '';
      await new Promise((resolve, reject) => {
        data.on('data', chunk => json += chunk);
        data.on('end', resolve);
        data.on('error', reject);
      });
      const parsed = JSON.parse(json);
      return { vars: parsed?.head?.vars || [], rows: parsed?.results?.bindings || [] };
    }

    if (result.type === 'boolean') {
      const bool = await result.booleanResult;
      return { vars: ['ASK'], rows: [{ ASK: { type: 'literal', value: String(bool) } }] };
    }

    if (result.type === 'quads') {
      const { data } = await engine.resultToString(result, 'application/n-triples');
      let nt = '';
      await new Promise((resolve, reject) => {
        data.on('data', chunk => nt += chunk);
        data.on('end', resolve);
        data.on('error', reject);
      });
      // Graph-y results â€” keep old shape (your UI already supports it)
      return nt.split('\n').filter(Boolean).map(line => ({ nt: { value: line } }));
    }

    if (debuggingConsoleEnabled) {console.warn(`[queryFromNamedGraph] Unrecognized result type: ${result.type}`)};
    return { vars: [], rows: [] };

  } catch (err) {
    if (debuggingConsoleEnabled) {console.error(`[queryFromNamedGraph] Error querying graph <${graphIRI}>:`, err)};
    return { vars: [], rows: [] };
  }
}


/**
 * Executes a SPARQL query over all named graphs in IndexedDB using Comunica.
 * 
 * @param {string} query - The SPARQL query string (SELECT, ASK, CONSTRUCT supported).
 * @returns {Promise<Array>} - Resolves with results: array of bindings, quads, or booleans.
 */
async function queryAllNamedGraphs(query) {
  try {
    if (debuggingConsoleEnabled) {console.info('[queryAllNamedGraphs] Running query over all named graphs')};

    // Step 1: Retrieve all triples
    const triples = await getAllTriples();
    if (!triples.length) {
      if (debuggingConsoleEnabled) {console.warn('[queryAllNamedGraphs] No triples found in store')};
      return { vars: [], rows: [] };
    }

    // Step 2: Convert stored triples to proper RDFJS quads
    const quads = triples.map(t => quad(
      asRdfjsSubject(t.subject ?? t.s, t.subjectType ?? t.sType),
      asRdfjsPredicate(t.predicate ?? t.p, t.predicateType ?? t.pType),
      asRdfjsObject(
        t.object ?? t.o,
        t.objectType ?? t.oType,
        t.objectLang ?? t.lang,
        t.objectDatatype ?? t.datatype
      ),
      (t.graph && String(t.graph).trim()) ? namedNode(t.graph) : defaultGraph()
    ));

    // Step 3: Query over an RDFJS Store (a real RDFJS Source)
    const store = new Store(quads);
    const result = await engine.query(query, {
      sources: [{ type: 'rdfjsSource', value: store }],
    });

    // Step 4: Collect and return results (version-agnostic)
    try {
      // Try bindings/boolean first (SELECT and ASK)
      const asJson = await engine.resultToString(result, 'application/sparql-results+json');
      let jsonText = '';
      await new Promise((resolve, reject) => {
        asJson.data.on('data', chunk => { jsonText += chunk; });
        asJson.data.on('end', resolve);
        asJson.data.on('error', reject);
      });

      // If we got valid SPARQL JSON, return it
      const parsed = JSON.parse(jsonText);
      if (parsed && typeof parsed === 'object') {
        if ('boolean' in parsed) {
          return { vars: ['ASK'], rows: [{ ASK: { type: 'literal', value: String(!!parsed.boolean) } }] };
        }
        if (parsed.results && Array.isArray(parsed.results.bindings)) {
          return { vars: parsed.head?.vars || [], rows: parsed.results.bindings };
        }
      }
      // If JSON parsed but isn't results/boolean, fall through to quads
    } catch (_) {
      // Not JSON / not SELECT-ASK â€” fall through to N-Triples
    }

    // Fallback: quads (CONSTRUCT/DESCRIBE)
    try {
      // Quads path (CONSTRUCT / DESCRIBE)
      const asNT = await engine.resultToString(result, 'application/n-triples');
      let nt = '';
      await new Promise((resolve, reject) => {
        asNT.data.on('data', chunk => { nt += chunk; });
        asNT.data.on('end', resolve);
        asNT.data.on('error', reject);
      });
      return nt.split('\n').filter(Boolean).map(line => ({ nt: { value: line } }));
    } catch (e) {
      if (debuggingConsoleEnabled) {console.warn('[queryAllNamedGraphs] Could not stringify as JSON or N-Triples', e)};
      return { vars: [], rows: [] };
    }

  } catch (err) {
    if (debuggingConsoleEnabled) {console.error('[queryAllNamedGraphs] Query error:', err)};
    // Either bubble up:
    throw err;
  }
}

/**
 * Deletes all triples from a specific named graph.
 * 
 * @param {string} graphIRI - The IRI of the named graph to clear.
 * @returns {Promise<void>}
 */
function clearGraph(graphIRI) {
  return clearGraphFromProjectStorage(graphIRI)
    .then(() => {if (debuggingConsoleEnabled) {console.info(`[clearGraph] Cleared ${graphIRI}`)};})
    .catch(err => {
      if (debuggingConsoleEnabled) {console.error(`[clearGraph] Failed to clear graph <${graphIRI}>:`, err)};
      throw err;
    });
}

/**
 * Build full SPARQL query with prefixes 
*/ 
function buildQuery(prefixes, queryText) {
  const prefixHeader = prefixes
    .map(pfx => commonSPARQLPrefixes[pfx])
    .filter(Boolean)
    .join('\n');
  return `${prefixHeader}\n${queryText}`;
}

/**
 * Run a CONSTRUCT preview over the current workspace and return serialized RDF.
 * Pure with respect to persistence (read-only). Errors bubble to caller.
 * @param {string} constructQuery - SPARQL CONSTRUCT query
 * @param {'text/turtle'|'application/n-triples'} format
 * @returns {Promise<string>} serialized RDF text
 */
const runConstructPreview = async (constructQuery, format='text/turtle') => {
  if (debuggingConsoleEnabled) {console.info('[runConstructPreview] Executing CONSTRUCT preview...')};
  const store = await loadGraphFromIndexedDB();
  const res = await engine.query(constructQuery, { sources:[{ type:'rdfjsSource', value: store }] });
  if (!res) return '';

  if (typeof engine.resultToString === 'function') {
    const mime = format === 'application/n-triples' ? 'application/n-triples' : 'text/turtle';
    const serialized = await engine.resultToString(res, mime);
    if (serialized?.data) return await collectStreamText(serialized.data);
  }

  if (!res.quadStream) return '';

  const { Writer } = N3;                              // available in your build
  const writer = new Writer({ format: format === 'application/n-triples' ? 'N-Triples' : 'Turtle' });
  return await new Promise((resolve, reject) => {
    res.quadStream.on('data', q => writer.addQuad(q));
    res.quadStream.on('error', reject);
    res.quadStream.on('end', () => writer.end((err, str) => err ? reject(err) : resolve(str)));
  });
};

async function collectStreamText(stream) {
  return await new Promise((resolve, reject) => {
    let text = '';
    stream.on('data', chunk => {
      text += String(chunk);
    });
    stream.on('end', () => resolve(text));
    stream.on('error', reject);
  });
}

// Execute a SPARQL query on a remote SPARQL endpoint
async function runQueryOnEndpoint(endpoint, query, authHeaders = {}) {
  const headers = {
    'Content-Type': 'application/sparql-query',
    ...authHeaders,
  };
  const response = await fetch(endpoint, { method: 'POST', headers, body: query });
  if (!response.ok) {
    const txt = await response.text().catch(()=> '');
    throw new Error(`Endpoint error ${response.status}: ${txt || response.statusText}`);
  }
  const data = await response.json();
  const vars = data?.head?.vars || [];
  const rows = data?.results?.bindings || [];
  return { vars, rows };
}



/**
/**
 * Turn an UPDATE into 0..n CONSTRUCT previews.
 * @type {(updateStr: string) => Array<{label:string, query:string}>}
 */
const makePreviewConstructs = buildSparqlUpdatePreviewConstructs;
const describeUpdateShape = describeSparqlUpdateShape;

function isUpdateQuery(q) {
  if (debuggingConsoleEnabled) {console.info('[isUpdateQuery] Checking if query is UPDATE...');}
  return classifySparqlOperationFamily(q) === 'UPDATE';
}

/**
 * Classify a SPARQL string into 'UPDATE' | 'READ' | 'UNKNOWN'
 * Pure function: does not read external state or mutate.
 * @param {string} q - SPARQL text
 * @returns {'UPDATE'|'READ'|'UNKNOWN'}
 */
const getQueryKind = (q) => {
  return classifySparqlOperationFamily(q);
};

// Flush Active workspace
async function flushActiveWorkspace() {
  const ok = confirm('This will delete ALL Active Workspace data from the shared project database. Continue?');
  if (!ok) return;

  try {
    await wipeActiveWorkspace();           // your existing function

    showToast('Workspace data cleared.', 'success');
  } catch (e) {
    if (debuggingConsoleEnabled) console.error('[flush-active-workspace] Failed to clear workspace:', e);
    showToast('Something went wrong while clearing. See console for details.', 'error');
  }
}

// Row-based uploader: stash each selected file into IndexedDB (skip empty rows)
async function addFilesToDB(rows, errors, namedGraphError) {
  for (const row of rows) {
    const file = row.querySelector('.rdf-file')?.files?.[0];
    const iriRaw = (row.querySelector('.graph-iri')?.value || '').trim();

    // Skip rows with no file chosen
    if (!file) continue;

    try {
      const text = await readFileAsText(file);
      const detected = getSupportedMimeTypeForFilename(file.name);
      const mime = detected.ok && detected.value.category === 'rdf' ? detected.value.mimeType : 'text/turtle';

      const g = $rdf.graph();
      // 4-arg signature; pass null/undefined for default graph when IRI blank
      await parseIntoNamedGraph(text, g, iriRaw || null, mime);

      // persist rdflib statements to IndexedDB
      await storeTriplesInNamedGraph(g.statements);
      if (debuggingConsoleEnabled) {console.info(`[add-to-db] Stored ${g.statements.length} triples into ${iriRaw ? `<${iriRaw}>` : 'default graph'}`);}
      const label = iriRaw ? `<${iriRaw}>` : 'default graph';
      showToast(`Loaded ${g.statements.length} triple(s) into ${label}`, 'success');
    } catch (e) {
      errors.push(`Failed to parse ${file?.name || '(no file name)'}: ${e.message}`);
      if (debuggingConsoleEnabled) {console.error(e);}
      showToast(`Failed to load ${file?.name || '(file)'}: ${e.message}`, 'error');
    }
  }

  if (errors.length) {
    showToast(`Completed with ${errors.length} error(s). See console for details.`, 'error');
  } else {
    showToast('All selected files loaded successfully.', 'success');
  }

  namedGraphError.textContent = errors.join(' | ');
};

/**
 * Parse RDF text to an rdflib graph.
 * Pure w.r.t. persistence; returns a new graph.
 * @param {string} text
 * @param {string} mime - rdflib-supported content type
 * @param {string} baseIRI
 * @returns {Promise<$rdf.Formula>}
 */
async function parseRdfTextToGraph(text, mime='text/turtle', baseIRI='http://example.org/') {
  const g = $rdf.graph();

  const parsed = await parseRdfTextWithAdapters(text, {
    format: mime,
    baseIri: baseIRI,
    runtime: { N3, jsonld: globalThis.jsonld, $rdf }
  });
  parsed.quads.forEach(q => {
    g.add(
      rdfJsTermToRdflib(q.subject, $rdf),
      rdfJsTermToRdflib(q.predicate, $rdf),
      rdfJsTermToRdflib(q.object, $rdf),
      q.graph && q.graph.termType !== 'DefaultGraph' ? rdfJsTermToRdflib(q.graph, $rdf) : undefined
    );
  });
  return g;
}

/**
 * Copy all statements from `src` into `dst`, targeting default or named graph.
 * Mutates only `dst`.
 * @param {$rdf.Formula} src
 * @param {$rdf.Formula} dst
 * @param {'default'|'named'} mode
 * @param {string|null} graphIRI - required when mode==='named'
 * @returns {$rdf.Formula} dst
 */
function mergeIntoGraph(src, dst, mode='default', graphIRI=null) {
  const gSym = (mode === 'named' && graphIRI) ? $rdf.sym(graphIRI) : undefined;
  src.statements.forEach(st => dst.add(st.subject, st.predicate, st.object, gSym));
  return dst;
}

/**
 * Serialize an rdflib graph to a given RDF MIME.
 * Pure.
 * @param {$rdf.Formula} graph
 * @param {string} mime
 * @param {string} baseIRI
 * @returns {string}
 */
function serializeGraph(graph, mime='text/turtle', baseIRI='http://example.org/') {
  return $rdf.serialize(null, graph, baseIRI, mime);
}

/**
 * Build a named-graph IRI with time+uuid suffix.
 * Pure; no side effects.
 * @param {string} base - Base IRI to prefix (e.g., 'urn:graph:import')
 */
function makeNamedGraphIRI(base='urn:graph:auto') {
  return createTimestampedGraphIri(base);
}

/**
 * Persist a graph into IndexedDB (default or named) without loading the store.
 * - Fast path: transform + (optional) de-dup + append
 * - If you need "replace" semantics for a named graph, clear it first (see note below)
 *
 * @param {$rdf.Formula} graph
 * @param {'default'|'named'} mode
 * @param {string|null} graphIRI   - if null and mode==='named', auto-IRI is created
 * @param {string} autoBase        - base used when auto-creating a graph IRI
 * @param {Object} opts
 * @param {boolean} [opts.dedupe=true]   - de-duplicate within this batch
 * @param {boolean} [opts.replace=false] - if true and mode==='named', clear target graph before append
 * @returns {Promise<{count:number, graphIRI:string}>}
 */
async function stashGraphToIndexedDB(graph, mode='default', graphIRI=null, autoBase='urn:graph:auto', opts={}) {
  const iri = (mode === 'named') ? (graphIRI || makeNamedGraphIRI(autoBase)) : null;
  const graphValue = iri || '';

  if (!graph || typeof graph.getQuads !== 'function') {
    throw new Error('stashGraphToIndexedDB expected an N3.Store or compatible RDF/JS source');
  }

  const prepared = graph.getQuads(null, null, null, null).map((q, i) => {
    const row = {
      subject: q.subject?.value ?? '',
      subjectType: q.subject?.termType ?? '',
      predicate: q.predicate?.value ?? '',
      predicateType: q.predicate?.termType ?? '',
      object: q.object?.value ?? '',
      objectType: q.object?.termType ?? '',
      objectLang: q.object?.language || null,
      objectDatatype: q.object?.datatype?.value || null,
      graph: graphValue || (q.graph?.termType === 'DefaultGraph' ? '' : (q.graph?.value ?? ''))
    };

    if (
      typeof row.subject !== 'string' ||
      typeof row.predicate !== 'string' ||
      typeof row.object !== 'string' ||
      typeof row.graph !== 'string'
    ) {
      console.error('[stashGraphToIndexedDB] Invalid prepared row at index', i, row, q);
      throw new Error(`Invalid prepared row at index ${i}`);
    }

    return row;
  });

  await storeTriplesInNamedGraph(prepared);
  return { count: prepared.length, graphIRI: iri || '(default graph)' };
}


async function clearActiveTriples() {
  const ok = confirm('This will delete all triples from the Active Workspace. Continue?');
  if (!ok) return;

  try {
    await clearTriples();


    if (debuggingConsoleEnabled) {
      console.info('[clear-active-triples] Triple store cleared.');
    }
    showToast('All triples cleared.', 'success');
  } catch (e) {
    if (debuggingConsoleEnabled) {
      console.error('[clear-active-triples] Failed:', e);
    }
    showToast('Something went wrong while clearing triples. See console for details.', 'error');
  }
}

async function clearActiveSettings() {
  const ok = confirm('This will delete all saved SPARQL settings. Continue?');
  if (!ok) return;

  try {
    await clearSettingsStore();


    if (debuggingConsoleEnabled) {
      console.info('[clear-active-settings] Settings store cleared.');
    }
    showToast('SPARQL settings cleared.', 'success');
  } catch (e) {
    if (debuggingConsoleEnabled) {
      console.error('[clear-active-settings] Failed:', e);
    }
    showToast('Something went wrong while clearing settings. See console for details.', 'error');
  }
}

async function clearActiveSavedQueries() {
  const ok = confirm('This will delete all saved queries. Continue?');
  if (!ok) return;

  try {
    await clearSavedQueries();

    if (debuggingConsoleEnabled) {
      console.info('[clear-active-saved-queries] Saved queries cleared.');
    }
    showToast('Saved queries cleared.', 'success');
  } catch (e) {
    if (debuggingConsoleEnabled) {
      console.error('[clear-active-saved-queries] Failed:', e);
    }
    showToast('Something went wrong while clearing saved queries. See console for details.', 'error');
  }
}

/**
 * Canonical (pre-listed) URL â†’ fetch â†’ parse â†’ stash to default/named.
 * Side-effects: fetch network + write to IndexedDB.
 * @param {Object} opt
 * @param {string} opt.url
 * @param {'default'|'named'} [opt.targetMode='default']
 * @param {string|null} [opt.graphIRI=null]
 * @returns {Promise<{count:number, graphIRI:string}>}
 */
async function importCanonical(opt={}) {
  const { url, targetMode='default', graphIRI=null } = opt;
  if (!url) throw new Error('importCanonical: url is required');
  const resp = await fetch(url, { cache: 'no-store' });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  const text = await resp.text();
  const detected = getSupportedMimeTypeForFilename(url);
  const mime = detected.ok && detected.value.category === 'rdf' ? detected.value.mimeType : 'text/turtle';
  const parsed = await parseRdfTextToGraph(text, mime);
  return await stashGraphToIndexedDB(parsed, targetMode, graphIRI, 'urn:graph:canonical');
}

/**
 * Local file â†’ read â†’ parse â†’ stash to default/named.
 * Side-effects: read file + write to IndexedDB.
 * @param {Object} opt
 * @param {File} opt.file
 * @param {'default'|'named'} [opt.targetMode='default']
 * @param {string|null} [opt.graphIRI=null]
 * @returns {Promise<{count:number, graphIRI:string}>}
 */
async function importLocalFile(opt={}) {
  const { file, targetMode='default', graphIRI=null } = opt;
  if (!file) throw new Error('importLocalFile: file is required');
  const text = await readFileAsText(file);
  const detected = getSupportedMimeTypeForFilename(file.name);
  const mime = detected.ok && detected.value.category === 'rdf' ? detected.value.mimeType : 'text/turtle';
  const parsed = await parseRdfTextToGraph(text, mime);
  return await stashGraphToIndexedDB(parsed, targetMode, graphIRI, 'urn:graph:upload');
}

/**
 * Preview INSERT portion of an UPDATE as a graph and optionally persist it.
 * Uses your existing preview generator/executor.
 * Side-effects only when persist===true.
 * @param {string} updateStr
 * @param {Object} opt
 * @param {'default'|'named'} [opt.targetMode='default']
 * @param {string|null} [opt.graphIRI=null]
 * @param {boolean} [opt.persist=false]
 * @returns {Promise<{previewGraph:$rdf.Formula, count:number, graphIRI?:string}>}
 */
async function previewInsertFromUpdate(updateStr, opt={}) {
  const { targetMode='default', graphIRI=null, persist=false } = opt;
  if (typeof makePreviewConstructs !== 'function' || typeof runConstructPreview !== 'function') {
    throw new Error('previewInsertFromUpdate requires makePreviewConstructs + runConstructPreview');
  }
  const previews = makePreviewConstructs(String(updateStr));
  const ins = previews.find(p => /inserted/i.test(p.label));
  if (!ins || !ins.query) {
    if (debuggingConsoleEnabled) {console.info('[previewInsertFromUpdate] No INSERT preview available.');}
    const empty = $rdf.graph();
    return { previewGraph: empty, count: 0 };
  }

  const ttl = await runConstructPreview(ins.query, 'text/turtle');    // serialize from CONSTRUCT
  const previewGraph = await parseRdfTextToGraph(ttl, 'text/turtle'); // parse back into rdflib

  if (!persist) {
    if (debuggingConsoleEnabled) {console.info('[previewInsertFromUpdate] Preview only (not persisted).');}
    return { previewGraph, count: previewGraph.statements.length };
  }

  const res = await stashGraphToIndexedDB(previewGraph, targetMode, graphIRI, 'urn:graph:update');
  return { previewGraph, count: res.count, graphIRI: res.graphIRI };
}

export {
  clearActiveSavedQueries,
  applyUpdateWithComunica,
  addFilesToDB,
  buildQuery,
  clearActiveSettings,
  clearActiveTriples,
  clearGraph,
  describeUpdateShape,
  flushActiveWorkspace,
  importCanonical,
  importLocalFile,
  loadGraphFromIndexedDB,
  makeNamedGraphIRI,
  makePreviewConstructs,
  getQueryKind,
  isAbsoluteIri,
  parseIntoNamedGraph,
  parseRdfTextToGraph,
  previewInsertFromUpdate,
  queryAllNamedGraphs,
  queryFromNamedGraph,
  runQueryOnEndpoint,
  runQueryOnLocalDataset,
  runConstructPreview,
  stashGraphToIndexedDB
};
