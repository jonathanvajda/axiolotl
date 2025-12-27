// Dependencies
//   comunica-browser.js
//     QueryEngine
//   indexeddb-triplestore.js
//     storeTriplesInNamedGraph
//     getAllTriples
//     clearTriples
//   rdflib.js
//     $rdf

const engine = new Comunica.QueryEngine();
// N3 RDF/JS terms & store
const { DataFactory, Store } = N3;
const { namedNode, blankNode, literal, quad, defaultGraph } = DataFactory;

/* -----------------------------
   IRI / term-kind detection
   ----------------------------- */

// Absolute IRI detection that does NOT classify CURIEs like "skos:prefLabel" as IRIs
function isAbsoluteIri(s) {
  if (typeof s !== 'string' || s.length === 0) return false;
  if (/\s/.test(s)) return false; // IRIs can’t have spaces
  // schemes with // (hierarchical)
  if (/^(?:https?|wss?|ftp|file):\/\//i.test(s)) return true;
  // schemes without // (non-hierarchical)
  if (/^(?:urn|tag|mailto|data|ipfs|ipns):/i.test(s)) return true;
  return false; // everything else (e.g., "skos:prefLabel") is NOT an absolute IRI
}

// Objects: NamedNode (absolute IRI), BlankNode, or Literal
function looksLikeBnodeId(v) {
  return typeof v === 'string' && (v.startsWith('_:') || v.startsWith('_g_') || /^[A-Za-z]\d+$/.test(v));
}

/**
 * This normalizes an IRI string by trimming whitespace and removing surrounding angle brackets.
 * @param {*} s
 * @returns   {string|*} normalized IRI string, or original value if not a string
 */

function normalizeIriString(s) {
  if (typeof s !== 'string') return s;
  let t = s.trim();
  // Strip surrounding angle brackets like <http://example.org/x>
  if (t.length >= 2 && t[0] === '<' && t[t.length - 1] === '>') {
    t = t.slice(1, -1).trim();
  }
  return t;
}

/* -----------------------------
   Consolidated rdflib.js helpers
   Use type metadata when present; fallback to heuristics
   ----------------------------- */

// Subjects: either NamedNode (absolute IRI) or BlankNode
function asSubjectTerm(v, type) {
  if ((type === 'NamedNode') && isAbsoluteIri(v)) return $rdf.sym(v);
  if (isAbsoluteIri(v)) return $rdf.sym(v); // fallback if metadata missing
  // subjects can’t be literals → use bnode if not an absolute IRI
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
  const iri = normalizeIriString(v);
  if ((type === 'NamedNode') && isAbsoluteIri(iri)) return namedNode(iri);
  if (isAbsoluteIri(iri)) return namedNode(iri);
  return blankNode(String(v || '').replace(/^_:/, '').replace(/^_g_/, ''));
}

// Predicates: must be absolute IRI
function asRdfjsPredicate(v, type) {
  const iri = normalizeIriString(v);
  if ((type === 'NamedNode') && isAbsoluteIri(iri)) return namedNode(iri);
  if (isAbsoluteIri(iri)) return namedNode(iri);
  throw new Error(`Predicate must be absolute IRI: ${String(v)}`);
}

// Objects: NamedNode (absolute IRI), BlankNode, or Literal
function asRdfjsObject(v, type, lang, datatype) {
  const iri = normalizeIriString(v);
  if ((type === 'NamedNode') && isAbsoluteIri(iri)) return namedNode(iri);
  if (type === 'BlankNode' || looksLikeBnodeId(v)) {
    return blankNode(String(v).replace(/^_:/, '').replace(/^_g_/, ''));
  }
  if (lang) return literal(v ?? '', lang);
  if (datatype) return literal(v ?? '', namedNode(normalizeIriString(datatype)));
  if (isAbsoluteIri(iri)) return namedNode(iri);
  return literal(v ?? '');
}

// Build an RDFJS Store (N3.Store) from an rdflib.js graph
function formulaToRdfjsStore(graph) {
  const store = new Store();
  for (const st of graph.statements) {
    // subject
    const s = st.subject.termType === 'NamedNode'
      ? namedNode(st.subject.value)
      : blankNode(st.subject.id || st.subject.value);

    // predicate (rdflib guarantees IRIs here)
    const p = namedNode(st.predicate.value);

    // object
    let o;
    if (st.object.termType === 'NamedNode') {
      o = namedNode(st.object.value);
    } else if (st.object.termType === 'BlankNode') {
      o = blankNode(st.object.id || st.object.value || 'o');
    } else {
      const lang = st.object.lang || st.object.language || undefined;
      const dt = st.object.datatype ? namedNode(st.object.datatype.value) : undefined;
      o = lang ? literal(st.object.value, lang)
          : dt ? literal(st.object.value, dt)
          : literal(st.object.value);
    }

    // graph
    const g = (st.why && st.why.value) ? namedNode(st.why.value) : defaultGraph();

    store.addQuad(quad(s, p, o, g));
  }
  return store;
}

/* -----------------------------
   IndexedDB ↔ rdflib graph
   ----------------------------- */

/**
 * Loads all triples from IndexedDB into an rdflib.js graph.
 * @returns {Promise<$rdf.Formula>} A promise resolving to the populated rdflib graph.
 */
const loadGraphFromIndexedDB = async () => {
  try {
    if (debuggingConsoleEnabled) {console.info('[loadGraphFromIndexedDB] Loading triples into rdflib graph...')};
    const graph = $rdf.graph();
    const triples = await getAllTriples();

    triples.forEach(t => {
      try {
        // support both typed records and legacy strings
        const sVal = t.subject ?? t.s;
        const pVal = t.predicate ?? t.p;
        const oVal = t.object ?? t.o;
        const gVal = t.graph ?? t.g;

        const s = asSubjectTerm(sVal, t.subjectType ?? t.sType);
        const p = asPredicateTerm(pVal, t.predicateType ?? t.pType);
        const o = asObjectTerm(
          oVal,
          t.objectType ?? t.oType,
          t.objectLang ?? t.lang,
          t.objectDatatype ?? t.datatype
        );
        const g = gVal && String(gVal).trim() ? $rdf.sym(String(gVal)) : undefined;

        graph.add(s, p, o, g);
      } catch (e) {
        if (debuggingConsoleEnabled) {console.warn('[loadGraphFromIndexedDB] Skipping bad triple:', t, e)};
      }
    });

    if (debuggingConsoleEnabled) {console.info(`[loadGraphFromIndexedDB] Loaded ${graph.statements.length} statements.`)};
    return graph;
  } catch (error) {
    if (debuggingConsoleEnabled) {console.error('[loadGraphFromIndexedDB] Error:', error)};
    throw error;
  }
};

/**
 * Parses RDF content and adds statements to a target graph under a given named graph.
 * @param {string} rdfText - The raw RDF content.
 * @param {$rdf.Formula} targetGraph - The rdflib graph to populate.
 * @param {string} graphIRI - The named graph IRI to assign to each triple.
 * @param {string} mimeType - The RDF MIME type (e.g., text/turtle, application/rdf+xml).
 * @returns {Promise<void>}
 */
const parseIntoNamedGraph = async (rdfText, targetGraph, graphIRI, mimeType) => {
  return new Promise((resolve, reject) => {
    const tmp = $rdf.graph();
    $rdf.parse(rdfText, tmp, 'http://example.org/', mimeType, err => {
      if (err) {
        if (debuggingConsoleEnabled) {console.error('[parseIntoNamedGraph] Error parsing RDF:', err)};
        reject(err);
      } else {
        const graphSym = graphIRI ? $rdf.sym(graphIRI) : undefined; // undefined ⇒ default graph
        tmp.statements.forEach(q => {
          targetGraph.add(q.subject, q.predicate, q.object, graphSym);
        });
        if (debuggingConsoleEnabled) {console.info(
          `[parseIntoNamedGraph] Added ${tmp.statements.length} statements to ` +
          (graphIRI ? `graph <${graphIRI}>` : 'the default graph')
        )};
        resolve();
      }
    });
  });
};

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
  const datasetText = $rdf.serialize(null, graph, 'http://example.org/', 'text/turtle');
  const source = { type: 'stringSource', value: datasetText, mediaType: 'text/turtle' };
  await comunica.queryVoid(updateQuery, {
    sources: [source],
    baseIRI: 'http://example.org/',
    lenient: true
  });
  return graph;
  // If you’d rather fail loudly so no one uses this path:
  // throw new Error('applyUpdateWithComunica is not supported for stringSource; use CONSTRUCT-based inference.');
};


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
      // Graph-y results — keep old shape (your UI already supports it)
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
      // Not JSON / not SELECT-ASK — fall through to N-Triples
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
  return initTripleStore()
    .then(db => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.store;
      return store.getAll()
        .then(triples => {
          const toDelete = triples.filter(t => t.graph === graphIRI);
          for (const triple of toDelete) {
            store.delete([triple.subject, triple.predicate, triple.object, triple.graph]);
          }
        })
        .then(() => tx.done)
        .then(() => {if (debuggingConsoleEnabled) {console.info(`[clearGraph] Cleared ${graphIRI}`)}});
    })
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
  const g = await loadGraphFromIndexedDB();           // rdflib graph
  const store = formulaToRdfjsStore(g);               // N3.Store (RDFJS)
  const res = await engine.query(constructQuery, { sources:[{ type:'rdfjsSource', value: store }] });
  if (!res || !res.quadStream) return '';
  const { Writer } = N3;                              // available in your build
  const writer = new Writer({ format: format === 'application/n-triples' ? 'N-Triples' : 'Turtle' });
  return await new Promise((resolve, reject) => {
    res.quadStream.on('data', q => writer.addQuad(q));
    res.quadStream.on('error', reject);
    res.quadStream.on('end', () => writer.end((err, str) => err ? reject(err) : resolve(str)));
  });
};

// Execute a SPARQL query on a remote SPARQL endpoint
async function runQueryOnEndpoint(endpoint, query) {
  const headers = {
    'Content-Type': 'application/sparql-query',
    ...endpointAuthHeaders,
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

/* Executes a SPARQL query on IndexedDB-stored triples using Comunica.
  * graphs: array of named graph IRIs, or ['all'] for all graphs
  * query: SPARQL query string
  * returns: array of results (bindings or boolean)
*/  
async function runQueryOnDatabase(graphs, query) {
  // All graphs / none selected → one shot
  if (!graphs || graphs.length === 0 || graphs.includes('all')) {
    return await queryAllNamedGraphs(query);
  }

  // Single graph → one shot
  if (graphs.length === 1) {
    return await queryFromNamedGraph(graphs[0], query);
  }

  // Multiple graphs → query each, preserve vars from first non-empty SELECT/ASK,
  // and concatenate rows. If any path returns graph-y ({nt}) results, return that array directly.
  let mergedVars = null;
  let mergedRows = [];
  for (const g of graphs) {
    const res = await queryFromNamedGraph(g, query);

    // If this path returned quads (array of {nt}), we can't merge — just return them.
    if (Array.isArray(res) && res[0] && res[0].nt) {
      return res;
    }

    // Normal SELECT/ASK shape
    if (res && Array.isArray(res.vars) && Array.isArray(res.rows)) {
      if (!mergedVars && res.vars.length) mergedVars = res.vars.slice();
      if (Array.isArray(res.rows) && res.rows.length) {
        mergedRows = mergedRows.concat(res.rows);
      }
    }
  }
  return { vars: mergedVars || [], rows: mergedRows };
}


/**
 * Turn an UPDATE into 0..n CONSTRUCT previews.
 * Supported shapes: INSERT DATA {...}, INSERT{T}WHERE{P}, DELETE WHERE{P},
 * DELETE{T}WHERE{P}, and DELETE{T}INSERT{U}WHERE{P}.
 * Pure; string-in/string-out. Caller decides how to execute.
 * @param {string} updateStr
 * @returns {Array<{label:string, query:string}>}
 */
const makePreviewConstructs = (updateStr) => {
  const s = String(updateStr ?? '').replace(/^\s*#.*$/mg,'').trim();
  const out = [];

  // INSERT DATA { GRAPH <g>? { ... } }
  // We preview "triples to be inserted". If GRAPH is present we ignore it for preview;
  // execution context (graph target) is set by UI.
  const mInsertData = s.match(/^INSERT\s+DATA\s*\{([\s\S]+)\}\s*;?\s*$/i);
  if (mInsertData) {
    const body = mInsertData[1];
    // Fallback: show the raw body as CONSTRUCT by wrapping as template+WHERE { body }.
    out.push({
      label: 'Triples that would be inserted',
      query: `CONSTRUCT { ${body} } WHERE { ${body} }`
    });
    return out;
  }

  // DELETE WHERE { P }
  const mDeleteWhere = s.match(/^DELETE\s+WHERE\s*\{([\s\S]+)\}\s*;?\s*$/i);
  if (mDeleteWhere) {
    const P = mDeleteWhere[1];
    out.push({
      label: 'Triples that would be deleted',
      query: `CONSTRUCT { ${P} } WHERE { ${P} }`
    });
    return out;
  }

  // DELETE { T } INSERT { U } WHERE { P }
  const mDelIns = s.match(/^DELETE\s*\{([\s\S]+?)\}\s*INSERT\s*\{([\s\S]+?)\}\s*WHERE\s*\{([\s\S]+?)\}\s*;?\s*$/i);
  if (mDelIns) {
    const T = mDelIns[1], U = mDelIns[2], P = mDelIns[3];
    out.push({ label:'Triples that would be deleted', query:`CONSTRUCT { ${T} } WHERE { ${P} }` });
    out.push({ label:'Triples that would be inserted', query:`CONSTRUCT { ${U} } WHERE { ${P} }` });
    return out;
  }

  // INSERT { T } WHERE { P }
  const mInsert = s.match(/^INSERT\s*\{([\s\S]+?)\}\s*WHERE\s*\{([\s\S]+?)\}\s*;?\s*$/i);
  if (mInsert) {
    const T = mInsert[1], P = mInsert[2];
    out.push({ label:'Triples that would be inserted', query:`CONSTRUCT { ${T} } WHERE { ${P} }` });
    return out;
  }

  // DELETE { T } WHERE { P }
  const mDelete = s.match(/^DELETE\s*\{([\s\S]+?)\}\s*WHERE\s*\{([\s\S]+?)\}\s*;?\s*$/i);
  if (mDelete) {
    const T = mDelete[1], P = mDelete[2];
    out.push({ label:'Triples that would be deleted', query:`CONSTRUCT { ${T} } WHERE { ${P} }` });
    return out;
  }

  if (debuggingConsoleEnabled) {console.info('[makePreviewConstructs] No supported preview pattern matched.')};
  return out;
};

function isUpdateQuery(q) {
  if (debuggingConsoleEnabled) {console.info('[isUpdateQuery] Checking if query is UPDATE...');}
  const s = String(q).trim().replace(/^\s*#.*$/mg,''); // strip leading comments
  // SPARQL Update keywords (very coarse but effective)
  return /^(INSERT|DELETE|WITH|LOAD|CLEAR|CREATE|DROP|COPY|MOVE|ADD)\b/i.test(s);
}

/**
 * Classify a SPARQL string into 'UPDATE' | 'READ' | 'UNKNOWN'
 * Pure function: does not read external state or mutate.
 * @param {string} q - SPARQL text
 * @returns {'UPDATE'|'READ'|'UNKNOWN'}
 */
const getQueryKind = (q) => {
  try {
    let s = String(q ?? '');

    // strip full-line comments
    s = s.replace(/^\s*#.*$/mg, '');

    // remove leading PREFIX/BASE declarations (any number of them)
    // e.g., PREFIX x: <…>  /  BASE <…>
    s = s.replace(/^(?:\s*(?:PREFIX\s+\w+:\s*<[^>]+>|BASE\s*<[^>]+>))+?/img, '').trim();

    if (!s) return 'UNKNOWN';

    // now check the first keyword
    if (/^(INSERT|DELETE|WITH|LOAD|CLEAR|CREATE|DROP|COPY|MOVE|ADD)\b/i.test(s)) return 'UPDATE';
    if (/^(SELECT|ASK|CONSTRUCT|DESCRIBE)\b/i.test(s)) return 'READ';

    return 'UNKNOWN';
  } catch (e) {
    if (debuggingConsoleEnabled) {console.error('[getQueryKind] Failed to classify query:', e);}
    return 'UNKNOWN';
  }
};

// Flush Active workspace
async function flushActiveWorkspace() {
  const ok = confirm('This will delete ALL Active Workspace data (IndexedDB) and clear localStorage. Continue?');
  if (!ok) return;

  try {
    await wipeActiveWorkspace();           // your existing function

    // Immediately set both status buttons to OFF (no DB access)
    instantIdleWorkspaceStatus();
    instantIdleSparqlStatus();

    // Optional but safe: refresh later (returns 0/0 and "No SPARQL…" after wipe)
    queueMicrotask(() => {
      try { refreshWorkspaceStatus?.(); } catch {}
      try { refreshSparqlStatus?.(); } catch {}
      try { renderGraphList?.(); } catch {}
    });

    if (debuggingConsoleEnabled) console.info('[flush-active-workspace] Workspace data cleared.');
    alert('Workspace data cleared.');
  } catch (e) {
    if (debuggingConsoleEnabled) console.error('[flush-active-workspace] Failed to clear workspace:', e);
    alert('Something went wrong while clearing. See console for details.');
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
      const mime = detectRdfMimeByName(file.name);

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
  if (errors.length === 0 && typeof renderGraphList === 'function') {
    await renderGraphList(); // default graph doesn’t appear here by design
  }
};

/**
 * Detect an RDF MIME type from a filename extension.
 * Pure; logs warning for unknown.
 * @param {string} filename
 * @returns {string} rdflib.js MIME
 */
function detectRdfMimeByName(filename='') {
  const ext = String(filename).toLowerCase().split('.').pop();
  switch (ext) {
    case 'ttl': return 'text/turtle';
    case 'nt': return 'application/n-triples';
    case 'n3': return 'text/n3';
    case 'jsonld': return 'application/ld+json';
    case 'rdf':
    case 'owl': return 'application/rdf+xml';
    case 'trig': return 'application/trig';
    default:
      if (debuggingConsoleEnabled) {console.warn(`[detectRdfMimeByName] Unknown extension ".${ext}", defaulting to Turtle`);}
      return 'text/turtle';
  }
}

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
  await new Promise((res, rej) => $rdf.parse(text, g, baseIRI, mime, err => err ? rej(err) : res()));
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
  return `${String(base).replace(/\/+$/,'')}/${timestampUTC()}/${uuid()}`;
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
async function stashGraphToIndexedDB(
  graph,
  mode = 'default',
  graphIRI = null,
  autoBase = 'urn:graph:auto',
  opts = {}
) {
  const { dedupe = true, replace = false } = opts;
  if (!graph) throw new Error('No graph provided');

  const iri = (mode === 'named') ? (graphIRI || makeNamedGraphIRI(autoBase)) : null;
  const graphSym = iri ? $rdf.namedNode(iri) : undefined;

  // Prepare statements for the target graph (assign .graph = graphSym for named)
  let prepared = graph.statements.map(st =>
    new $rdf.Statement(st.subject, st.predicate, st.object, graphSym)
  );

  // Optional: batch de-dup to avoid inserting exact duplicates
  if (dedupe) {
    const seen = new Set();
    // rdflib Statement#toNT() yields N-Triples; with .graph set, it’s effectively N-Quads
    prepared = prepared.filter(st => {
      const key = st.toNT();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  // Optional: targeted "replace" for named graph (no full DB load)
  if (replace && iri) {
    // implement (or call) a clearNamedGraph(iri) helper that deletes rows where row.graph === iri
    // await clearNamedGraph(iri);
    // If you don't have it yet, you can add a filtered delete in indexeddb-triplestore.js
  }

  // Append to IDB (no read/merge step)
  await storeTriplesInNamedGraph(prepared);

  // Notify UI so buttons update immediately
  try {
    window?.dispatchEvent(new CustomEvent('triples-changed', {
      detail: { db: 'inferenceDB', store: 'triples', type: 'put' , graphIRI: graphIRI || '(default)'}
    }));
  } catch {}

  const count = prepared.length;
  if (debuggingConsoleEnabled) {
    console.info(`[stashGraphToIndexedDB] Saved ${count} triple(s) into ${iri || '(default graph)'}${replace ? ' (replace)' : ''}`);
  }
  return { count, graphIRI: iri || '(default graph)' };
}

/**
 * Canonical (pre-listed) URL → fetch → parse → stash to default/named.
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
  const mime = detectRdfMimeByName(url);
  const parsed = await parseRdfTextToGraph(text, mime);
  return await stashGraphToIndexedDB(parsed, targetMode, graphIRI, 'urn:graph:canonical');
}

/**
 * Local file → read → parse → stash to default/named.
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
  const mime = detectRdfMimeByName(file.name);
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

// Make bridge functions available globally when not using modules
window.parseIntoNamedGraph = parseIntoNamedGraph;
window.storeTriplesInNamedGraph = storeTriplesInNamedGraph;
window.queryFromNamedGraph = queryFromNamedGraph;
window.getAllGraphNames = getAllGraphNames;
window.clearGraph = clearGraph;
window.applyUpdateWithComunica = applyUpdateWithComunica;
window.loadGraphFromIndexedDB  = loadGraphFromIndexedDB;
window.stashGraphToIndexedDB = stashGraphToIndexedDB;
window.queryAllNamedGraphs     = queryAllNamedGraphs;
window.formulaToRdfjsStore = formulaToRdfjsStore;