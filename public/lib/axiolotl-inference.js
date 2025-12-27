// axiolotl-inference.js

// Dependencies
  // comunica-indexeddb-bridge.js
    //  applyUpdateWithComunica,
    //  loadGraphFromIndexedDB,
    //  saveGraphToIndexedDB
  // rdflib.js
    // $rdf
  // semantic-core.js
    // downloadText(filename, text, mime)  

/**
 * Extract selected inference rule IDs from checked checkboxes.
 * @returns {string[]} List of rule identifiers
 */
function getSelectedRulesFromCheckboxes() {
  return Array.from(document.querySelectorAll('input[name="inference-rule"]:checked'))
    .map(el => el.value);
}

// Build adjacency maps from the RDF/JS store (across all graphs)
function mapFromQuads(store, predIRI) {
  const M = new Map();
  for (const q of store.getQuads(null, predIRI, null, null)) {
    const a = q.subject.value, b = q.object.value;
    if (!M.has(a)) M.set(a, new Set());
    M.get(a).add(b);
  }
  return M;
}

// Generic transitive-closure over a directed acyclic-ish relation (rdfs:subClassOf, rdfs:subPropertyOf)
function transitiveClosure(edges) {
  const closure = new Map();
  for (const [child, parents] of edges) {
    const seenLocal = new Set();
    const stack = [...parents];
    while (stack.length) {
      const p = stack.pop();
      if (seenLocal.has(p)) continue;
      seenLocal.add(p);
      const pp = edges.get(p);
      if (pp) pp.forEach(x => stack.push(x));
    }
    closure.set(child, seenLocal);
  }
  return closure;
}

// TBox IRIs
const RDFS_SC = 'http://www.w3.org/2000/01/rdf-schema#subClassOf';
const RDFS_SP = 'http://www.w3.org/2000/01/rdf-schema#subPropertyOf';
const OWL_INV = 'http://www.w3.org/2002/07/owl#inverseOf';
const OWL_SYM = 'http://www.w3.org/2002/07/owl#SymmetricProperty';
const OWL_TRANS = 'http://www.w3.org/2002/07/owl#TransitiveProperty';
const RDFS_DOMAIN = 'http://www.w3.org/2000/01/rdf-schema#domain';
const RDFS_RANGE  = 'http://www.w3.org/2000/01/rdf-schema#range';
const RDF_TYPE    = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

/**
 * Applies a set of inference rules repeatedly until no new triples are added.
 * @param {string[]} rules - List of rule identifiers to apply (e.g. ["inverse", "subclassof"])
 * @returns {Promise<{ overlayGraph: $rdf.Formula, metrics: Record<string, number> }>} New triples and their counts
 * Event-driven: new ABox assertions immediately trigger subclass/subproperty,
 * inverse/symmetric, and domain/range expansions using precomputed TBox closures.
*/
// axiolotl-inference.js
async function inferUntilStable(rules) {
  if (debuggingConsoleEnabled) {console.info('[inferUntilStable] Starting inference over rules:', rules)};

  // ---- 0) Load graphs and set up dedupe ----
  const baseGraph = await loadGraphFromIndexedDB();
  const seen = new Set(baseGraph.statements.map(s => s.toNT()));

  // We'll keep the overlay as N3 quads during inference (fast), and convert to rdflib at the end
  const overlayStore = new N3.Store();

  // Single shared RDF/JS store for Comunica; keep it in sync as we add
  const rdfjsStore = formulaToRdfjsStore(baseGraph);
  const { DataFactory } = N3;
  const { namedNode, blankNode, literal, quad, defaultGraph } = DataFactory;

  // Helpers to convert rdflib Statement -> N3 Term (used in enqueue)
  const toNamed   = iri => namedNode(iri);
  const toSubject = s => (s.termType === 'NamedNode' ? namedNode(s.value) : blankNode(s.id || s.value));
  const toObject  = o => (
    o.termType === 'NamedNode' ? namedNode(o.value) :
    o.termType === 'BlankNode' ? blankNode(o.id || o.value) :
    (o.language ? literal(o.value, o.language)
                : o.datatype ? literal(o.value, namedNode(o.datatype.value))
                             : literal(o.value))
  );

  // Build once:
  const subClassEdges = mapFromQuads(rdfjsStore, RDFS_SC);
  const subPropEdges  = mapFromQuads(rdfjsStore, RDFS_SP);

  const classSupers = transitiveClosure(subClassEdges);   // Map<class -> Set<allSuperClasses>>
  const propSupers  = transitiveClosure(subPropEdges);    // Map<prop  -> Set<allSuperProps>>

  // Also cache convenience maps/sets:
  const domainMap = mapFromQuads(rdfjsStore, RDFS_DOMAIN); // Map<prop -> Set<class>>
  const rangeMap  = mapFromQuads(rdfjsStore, RDFS_RANGE);  // Map<prop -> Set<class>>

  // Symmetric/inverse/transitive properties:
  const symmetricProps  = new Set(rdfjsStore.getQuads(null, RDF_TYPE, OWL_SYM, null).map(q => q.subject.value));
  const transitiveProps = new Set(rdfjsStore.getQuads(null, RDF_TYPE, OWL_TRANS, null).map(q => q.subject.value));
  // Make inverseOf two-way:
  const inversePairs = new Map(); // Map<p -> Set<inv>>
  for (const q of rdfjsStore.getQuads(null, OWL_INV, null, null)) {
    const p = q.subject.value, inv = q.object.value;
    if (!inversePairs.has(p)) inversePairs.set(p, new Set());
    if (!inversePairs.has(inv)) inversePairs.set(inv, new Set());
    inversePairs.get(p).add(inv);
    inversePairs.get(inv).add(p);
  }

  for (const q of rdfjsStore.getQuads(null, OWL_INV, null, null)) {
    const p = q.subject.value, inv = q.object.value;
    if (!inversePairs.has(p))  inversePairs.set(p,  new Set());
    if (!inversePairs.has(inv))inversePairs.set(inv,new Set());
    inversePairs.get(p).add(inv);
    inversePairs.get(inv).add(p);
  }

  // ---- 2) Work queues and enqueue logic ----
  const workTypes = []; // rdflib Statements: ?s rdf:type ?c
  const workProps = []; // rdflib Statements: ?s ?p ?o  (p != rdf:type)

  const enqueue = (stmts) => {
    for (const s of stmts) {
      const nt = s.toNT();
      if (seen.has(nt)) continue;

      // Add to base graph (so future SPARQL sees it)
      baseGraph.add(s.subject, s.predicate, s.object);
      seen.add(nt);

      // Add to overlay store
      const q = quad(toSubject(s.subject), toNamed(s.predicate.value), toObject(s.object), defaultGraph());
      overlayStore.addQuad(q);

      // Keep shared RDF/JS store in sync (so next CONSTRUCT sees it)
      rdfjsStore.addQuad(q);

      // Route to appropriate queue
      if (s.predicate.value === RDF_TYPE) workTypes.push(s);
      else workProps.push(s);
    }
  };

  // Expansion helpers (JS, fast)
  // expandTypesWithClosure(newTypes)
  function expandTypesWithClosure(newTypes){
    const out = [];
    let _skipped = 0;
    for (const s of newTypes){
      const c = s.object.value;
      const supers = classSupers.get(c);
      if (!supers) continue;
      for (const sup of supers){
        if (typeof isAbsoluteIri === 'function' && !isAbsoluteIri(sup)) { _skipped++; continue; }
        out.push($rdf.st(s.subject, $rdf.sym(RDF_TYPE), $rdf.sym(sup)));
      }
    }
    if (typeof debuggingConsoleEnabled !== 'undefined' && debuggingConsoleEnabled && _skipped){
      console.warn(`[expandTypesWithClosure] Skipped ${_skipped} non-IRI super-classes`);
    }
    return out;
  };

  /**
   * Expand new property assertions via subPropertyOf closure (pure).
   * Adds warning if any super-properties are not absolute IRIs.
   */
  function expandPropsWithClosure(newProps) {
    const out = [];
    let _skippedNonIriSuperProps = 0;

    for (const s of newProps) {
      const p = s.predicate.value;
      const supers = propSupers.get(p);
      if (!supers) continue;

      for (const sup of supers) {
        if (typeof isAbsoluteIri === 'function' && !isAbsoluteIri(sup)) {
          _skippedNonIriSuperProps++;
          continue;
        }
        out.push($rdf.st(s.subject, $rdf.sym(sup), s.object));
      }
    }

    if (typeof debuggingConsoleEnabled !== 'undefined' &&
        debuggingConsoleEnabled && _skippedNonIriSuperProps) {
      console.warn(
        `[expandPropsWithClosure] Skipped ${_skippedNonIriSuperProps} non-IRI super-properties`
      );
    }

    return out;
  }

  const applyInverseAndSymmetric = (newProps) => {
    const out = [];
    for (const s of newProps) {
      const p = s.predicate.value;
      if (symmetricProps.has(p)) {
        out.push($rdf.st(s.object, $rdf.sym(p), s.subject));
      }
      const invs = inversePairs.get(p);
      if (invs) for (const inv of invs) {
        out.push($rdf.st(s.object, $rdf.sym(inv), s.subject));
      }
    }
    return out;
  };

  // applyDomainRange(newProps)
function applyDomainRange(newProps){
  const out = [];
  let _skipDom = 0, _skipRng = 0;
  for (const s of newProps){
    const p = s.predicate.value;
    const Ds = domainMap.get(p);
    if (Ds) for (const d of Ds){
     if (typeof isAbsoluteIri === 'function' && !isAbsoluteIri(d)) { _skipDom++; continue; }
      out.push($rdf.st(s.subject, $rdf.sym(RDF_TYPE), $rdf.sym(d)));
    }
    const Rs = rangeMap.get(p);
    if (Rs) for (const r of Rs){
     if (typeof isAbsoluteIri === 'function' && !isAbsoluteIri(r)) { _skipRng++; continue; }
      out.push($rdf.st(s.object,  $rdf.sym(RDF_TYPE), $rdf.sym(r)));
    }
  }
  if (typeof debuggingConsoleEnabled !== 'undefined' && debuggingConsoleEnabled){
    if (typeof debuggingConsoleEnabled !== 'undefined' &&
        debuggingConsoleEnabled && _skipDom) {console.warn(`[applyDomainRange] Skipped ${_skipDom} domain classes that were not IRIs`);}
    if (typeof debuggingConsoleEnabled !== 'undefined' &&
        debuggingConsoleEnabled && _skipRng) {console.warn(`[applyDomainRange] Skipped ${_skipRng} range classes that were not IRIs`);}
  }
  return out;
}

  // Optional: Transitive properties (incremental)
  const applyTransitiveProps = (newPropsBatch) => {
    const out = [];
    for (const s of newPropsBatch) {
      const p = s.predicate.value;
      if (!transitiveProps.has(p)) continue;
      // x p y & y p z -> x p z
      for (const yz of rdfjsStore.getQuads(s.object, p, null, null)) {
        out.push($rdf.st(s.subject, $rdf.sym(p), $rdf.sym(yz.object.value)));
      }
      // w p x & x p y -> w p y
      for (const wx of rdfjsStore.getQuads(null, p, s.subject, null)) {
        out.push($rdf.st($rdf.sym(wx.subject.value), $rdf.sym(p), s.object));
      }
    }
    return out;
  };

  const processQueues = () => {
    let progressed = false;
    while (workTypes.length || workProps.length) {
      if (workTypes.length) {
        const batch = workTypes.splice(0, workTypes.length);
        const extra = expandTypesWithClosure(batch);
        if (extra.length) { enqueue(extra); progressed = true; }
      }
      if (workProps.length) {
        const batch = workProps.splice(0, workProps.length);
        const extra1 = expandPropsWithClosure(batch);
        const extra2 = applyInverseAndSymmetric(batch);
        const extra3 = applyDomainRange(batch);
        const extra4 = applyTransitiveProps(batch); // optional
        if (extra1.length) { enqueue(extra1); progressed = true; }
        if (extra2.length) { enqueue(extra2); progressed = true; }
        if (extra3.length) { enqueue(extra3); progressed = true; }
        if (extra4.length) { enqueue(extra4); progressed = true; }
      }
    }
    return progressed;
  };

  // ---- 3) Main loop: run SPARQL rules, then immediately expand via queues ----
  let totalAdded = 0;
  let changed = true;

  // --- SEED: apply subPropertyOf+ and subClassOf+ over the existing base graph ---

  // Collect existing assertions
  const seedTypes = [];
  const seedProps = [];
  for (const st of baseGraph.statements) {
    if (st.predicate.value === RDF_TYPE) seedTypes.push(st);
    else seedProps.push(st);
  }

  // subPropertyOf+ on all existing property assertions
  const seededPropLifts = expandPropsWithClosure(seedProps); // uses propSupers inside
  const { $new: seedPropUnseen } = selectUnseen(seededPropLifts, seen);
  if (seedPropUnseen.length) {
    // apply effects
    for (const s of seedPropUnseen) {
      baseGraph.add(s.subject, s.predicate, s.object);
      overlayStore.addQuad(
        asRdfjsSubject(s.subject.value,   s.subject.termType),
        asRdfjsPredicate(s.predicate.value, s.predicate.termType),
        asRdfjsObject(
          s.object.termType === 'Literal' ? s.object.value : s.object.value,
          s.object.termType,
          // rdflib uses .lang or .language; normalize to one
          (s.object.lang || s.object.language) || undefined,
          s.object.datatype ? s.object.datatype.value : undefined
        ),
        N3.DataFactory.defaultGraph()
      );
      rdfjsStore.addQuad(
        asRdfjsSubject(s.subject.value,   s.subject.termType),
        asRdfjsPredicate(s.predicate.value, s.predicate.termType),
        asRdfjsObject(
          s.object.termType === 'Literal' ? s.object.value : s.object.value,
          s.object.termType,
          (s.object.lang || s.object.language) || undefined,
          s.object.datatype ? s.object.datatype.value : undefined
        ),
        N3.DataFactory.defaultGraph()
      );
      seen.add(s.toNT());
    }
    console.info(`[inferUntilStable] Seeded subPropertyOf+ lifted ${seedPropUnseen.length} triples`);
  }

  // subClassOf+ on all existing rdf:type assertions
  const seededTypeLifts = expandTypesWithClosure(seedTypes); // uses classSupers inside
  const { $new: seedTypeUnseen } = selectUnseen(seededTypeLifts, seen);
  if (seedTypeUnseen.length) {
    for (const s of seedTypeUnseen) {
      baseGraph.add(s.subject, s.predicate, s.object);
      overlayStore.addQuad(
        asRdfjsSubject(s.subject.value,   s.subject.termType),
        asRdfjsPredicate(s.predicate.value, s.predicate.termType),
        asRdfjsObject(
          s.object.termType === 'Literal' ? s.object.value : s.object.value,
          s.object.termType,
          // rdflib uses .lang or .language; normalize to one
          (s.object.lang || s.object.language) || undefined,
          s.object.datatype ? s.object.datatype.value : undefined
        ),
        N3.DataFactory.defaultGraph()
      );
      rdfjsStore.addQuad(
        asRdfjsSubject(s.subject.value,   s.subject.termType),
        asRdfjsPredicate(s.predicate.value, s.predicate.termType),
        asRdfjsObject(
          s.object.termType === 'Literal' ? s.object.value : s.object.value,
          s.object.termType,
          (s.object.lang || s.object.language) || undefined,
          s.object.datatype ? s.object.datatype.value : undefined
        ),
        N3.DataFactory.defaultGraph()
      );
      seen.add(s.toNT());
    }
    console.info(`[inferUntilStable] Seeded subClassOf+ lifted ${seedTypeUnseen.length} triples`);
  }


  while (changed) {
    changed = false;

    const rulesFiltered = rules.filter(r => r !== 'subclassof' && r !== 'subpropertyof');
    if (rules.length !== rulesFiltered.length) {
       console.info(`[inferUntilStable] Skipping SPARQL for subclassof/subpropertyof (handled by JS closures)`);
      }
    for (const rule of rulesFiltered) {
      const constructQuery = getConstructQueryForRule(rule);
      if (!constructQuery) continue;

      // Run the rule with Comunica over the shared store
      const newStmts = await runRuleOnce(rule, baseGraph, rdfjsStore);

      // Batch de-dup (cheap) then enqueue only unseen
      const batch = [];
      const batchNT = new Set();
      for (const s of newStmts) {
        const nt = s.toNT();
        if (!batchNT.has(nt)) { batchNT.add(nt); batch.push(s); }
      }
      const beforeSeenSize = seen.size;
      enqueue(batch);

      // Process expansions driven by the just-enqueued assertions
      const progressed = processQueues();

      const added = seen.size - beforeSeenSize;
      if (added > 0) {
        totalAdded += added;
        if (debuggingConsoleEnabled) {console.info(`[inferUntilStable] Rule "${rule}" added ${added} triples.`)};
        changed = true;
      }
    }
  }

  // ---- 4) Convert overlayStore -> overlayGraph once (for preview/export) ----
  const overlayGraph = $rdf.graph();
  for (const q of overlayStore.getQuads(null, null, null, null)) {
    const s = q.subject.termType === 'NamedNode' ? $rdf.sym(q.subject.value) : $rdf.blankNode(q.subject.value);
    const p = $rdf.sym(q.predicate.value);
    let o;
    if (q.object.termType === 'NamedNode')      o = $rdf.sym(q.object.value);
    else if (q.object.termType === 'BlankNode') o = $rdf.blankNode(q.object.value);
    else {
      const lang = q.object.language || undefined;
      const dt   = q.object.datatype ? $rdf.sym(q.object.datatype.value) : undefined;
      o = lang ? $rdf.literal(q.object.value, lang)
               : dt ? $rdf.literal(q.object.value, undefined, dt)
                    : $rdf.literal(q.object.value);
    }
    overlayGraph.add(s, p, o);
  }

  if (debuggingConsoleEnabled) {console.info(`[inferUntilStable] Completed inference. Total new triples: ${totalAdded}`)};
  return { overlayGraph, metrics: { totalAdded } };
}

/**
 * Run inference (until stable) to produce an overlay graph; optionally persist overlay.
 * Uses your existing inferUntilStable(rules).
 * Side-effects only when persist===true.
 * @param {Object} opt
 * @param {string[]} opt.rules
 * @param {'default'|'named'} [opt.targetMode='default']
 * @param {string|null} [opt.graphIRI=null]
 * @param {boolean} [opt.persist=false]
 * @returns {Promise<{overlayGraph:$rdf.Formula, metrics:Object, count?:number, graphIRI?:string}>}
 */
async function runInferenceOverlay(opt={}) {
  const { rules=[], targetMode='default', graphIRI=null, persist=false } = opt;
  if (typeof inferUntilStable !== 'function') {
    throw new Error('runInferenceOverlay requires inferUntilStable');
  }
  const { overlayGraph, metrics } = await inferUntilStable(rules);
  if (!persist) return { overlayGraph, metrics };

  const res = await stashGraphToIndexedDB(overlayGraph, targetMode, graphIRI, 'urn:graph:inferred');
  return { overlayGraph, metrics, count: res.count, graphIRI: res.graphIRI };
}

/**
 * Create a named graph IRI, appending a timestamp and random suffix for uniqueness.
 * Pure; no side effects.
 * @param {string} base
 * @returns {string}
 */
async function saveOverlayToIndexedDB(overlayGraph, { mode, graphIRI }) {
  if (!overlayGraph) throw new Error('No overlay graph to save.');
  const storeGraph = await loadGraphFromIndexedDB();
  const graphSym = (mode === 'named' && graphIRI) ? $rdf.sym(graphIRI) : undefined;

  overlayGraph.statements.forEach(s => {
    storeGraph.add(s.subject, s.predicate, s.object, graphSym);
  });

  await saveGraphToIndexedDB(storeGraph);
  return { count: overlayGraph.statements.length, graphIRI: graphSym?.value ?? '(default graph)' };
}

/**
 * De-duplicate a batch and then remove any statements already in the global `seen` set.
 * Pure function.
 * @param {Array<$rdf.Statement>} stmts  – list of candidate statements
 * @param {Set<string>} seenNT           – global NT strings already present
 * @returns {{ $new: Array<$rdf.Statement>, batchUnique: number }}
 */
function selectUnseen(stmts, seenNT) {
  const batchSet = new Set();
  const uniq = [];

  for (const s of stmts) {
    const nt = s.toNT();
    if (batchSet.has(nt)) continue;   // de-dupe inside the batch
    batchSet.add(nt);
    if (!seenNT.has(nt)) uniq.push(s); // skip ones already known globally
  }

  return { $new: uniq, batchUnique: batchSet.size };
}

function pad2(n){ return String(n).padStart(2,'0'); }

/**
 * Return a stable UTC timestamp: YYYYMMDDThhmmssZ
 */
function timestampUTC() {
  const d = new Date();
  const pad = n => String(n).padStart(2,'0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth()+1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

/**
 * Return a UUID (uses crypto.randomUUID if available).
 * Pure; no side effects.
 */
function uuid() {
  if (crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random()*16|0, v = (c === 'x') ? r : ((r & 0x3) | 0x8);
    return v.toString(16);
  });
}

async function insertOverlayIntoEndpoint(overlayGraph, endpointUrl, { mode, graphIRI }) {
  if (!overlayGraph) throw new Error('Nothing to insert. Run inference first.');
  if (!endpointUrl) throw new Error('Missing endpoint URL.');

  const nt = $rdf.serialize(null, overlayGraph, 'http://example.org/', 'application/n-triples').trim();
  const open = (mode === 'named' && graphIRI) ? `GRAPH <${graphIRI}> {` : '';
  const close = (mode === 'named' && graphIRI) ? `}` : '';

  const update = `INSERT DATA { ${open}\n${nt}\n${close} }`;

  const res = await fetch(endpointUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/sparql-update', ...endpointAuthHeaders },
    body: update
  });

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Endpoint responded ${res.status}: ${t || res.statusText}`);
  }
  return true;
}

/**
 * Returns a SPARQL CONSTRUCT string for a given rule name.
 * Each rule is a single CONSTRUCT query (no semicolons between queries).
 * Uses MINUS to return only triples not already present.
 * @param {string} rule - Rule identifier
 * @returns {string} SPARQL CONSTRUCT query
 */
function getConstructQueryForRule(rule) {
  const PREFIXES = `
    PREFIX rdf:  <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
    PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
    PREFIX owl:  <http://www.w3.org/2002/07/owl#>
  `;

  const RULES = {
    // Inverse properties: produce either ?y ?inverse ?x or ?y ?p ?x depending on branch.
    // We normalize to (?S ?P ?O) via BIND and construct once.
    inverse: `
      CONSTRUCT { ?S ?P ?O }
      WHERE {
        {
          ?x ?p ?y .
          ?p owl:inverseOf ?inverse .
          BIND(?y AS ?S) BIND(?inverse AS ?P) BIND(?x AS ?O)
        }
        UNION
        {
          ?x ?inverse ?y .
          ?p owl:inverseOf ?inverse .
          BIND(?y AS ?S) BIND(?p AS ?P) BIND(?x AS ?O)
        }
        FILTER NOT EXISTS {
          { ?S ?P ?O }
          UNION
          { GRAPH ?g { ?S ?P ?O } }
        }
      }
    `,

    subpropertyof: `
      CONSTRUCT { ?x ?super ?y }
      WHERE {
        ?x ?p ?y .
        ?p rdfs:subPropertyOf+ ?super .
        FILTER(?p != ?super)
        FILTER NOT EXISTS {
          { ?x ?super ?y }
          UNION
          { GRAPH ?g { ?x ?super ?y } }
        }
      }
    `,

    subclassof: `
      CONSTRUCT { ?x rdf:type ?superClass }
      WHERE {
        ?x rdf:type ?class .
        ?class rdfs:subClassOf+ ?superClass .
        FILTER(?class != ?superClass)
        FILTER NOT EXISTS {
          { ?x rdf:type ?superClass }
          UNION
          { GRAPH ?g { ?x rdf:type ?superClass } }
        }
      }
    `,

    domain: `
      CONSTRUCT { ?x rdf:type ?domain }
      WHERE {
        ?x ?p ?y .
        ?p rdfs:domain ?domain .
        FILTER NOT EXISTS {
          { ?x rdf:type ?domain }
          UNION
          { GRAPH ?g { ?x rdf:type ?domain } }
        }
      }
    `,

    range: `
      CONSTRUCT { ?y rdf:type ?range }
      WHERE {
        ?x ?p ?y .
        ?p rdfs:range ?range .
        FILTER NOT EXISTS {
          { ?y rdf:type ?range }
          UNION
          { GRAPH ?g { ?y rdf:type ?range } }
        }
      }
    `,

    transitive: `
      CONSTRUCT { ?x ?p ?z }
      WHERE {
        ?x ?p ?y .
        ?y ?p ?z .
        ?p a owl:TransitiveProperty .
        FILTER NOT EXISTS {
          { ?x ?p ?z }
          UNION
          { GRAPH ?g { ?x ?p ?z } }
        }
      }
    `,
    symmetric: `
      CONSTRUCT { ?y ?p ?x }
      WHERE {
        ?x ?p ?y .
        ?p a owl:SymmetricProperty .
        FILTER NOT EXISTS {
          { ?y ?p ?x }
          UNION
          { GRAPH ?g { ?y ?p ?x } }
        }
      }
    `,
  };

  return PREFIXES + (RULES[rule] || '');
}

/**
 * Runs one inference rule once and returns only the newly inferred statements.
 * Prefers CONSTRUCT (applyConstructWithComunica) and falls back to UPDATE if needed.
 * @param {string} rule
 * @param {$rdf.Formula} baseGraph
 * @returns {Promise<$rdf.Statement[]>}
 */
async function runRuleOnce(rule, baseGraph, rdfjsStore) {
  // Preferred path: CONSTRUCT
  if (typeof applyConstructWithComunica === 'function') {
    const q = getConstructQueryForRule(rule);
    const g = await applyConstructWithComunica(q, rdfjsStore);
    return g.statements;
  }

  // Fallback path: UPDATE on a copy of the graph, then diff
  if (typeof applyUpdateWithComunica === 'function' && typeof getRuleQuery === 'function') {
    const before = new Set(baseGraph.statements.map(s => s.toNT()));
    await applyUpdateWithComunica(getRuleQuery(rule), baseGraph);
    return baseGraph.statements.filter(s => !before.has(s.toNT()));
  }

  throw new Error('No inference runner available (need applyConstructWithComunica or applyUpdateWithComunica).');
}

/** 
* Convert rdflib.js graph to an RDF/JS source for Comunica.
* @param {$rdf.Formula} formula - rdflib.js graph
* @returns {RDF.Source} RDF/JS source for Comunica
**/

async function applyConstructWithComunica(constructQuery, rdfjsStore) {
  const comunica = engine;

  const quadStream = await comunica.queryQuads(constructQuery, {
    sources: [{ type: 'rdfjsSource', value: rdfjsStore }],
    baseIRI: 'http://example.org/',
     // Ask Comunica to de-duplicate CONSTRUCT output at the engine level
    distinctConstruct: true,
  });

// Convert RDFJS quads directly into an rdflib graph (no parsing from text)
  const temp = $rdf.graph();

  return new Promise((resolve, reject) => {
    quadStream.on('data', q => {
      // subject
      const s = (q.subject.termType === 'NamedNode')
        ? $rdf.sym(q.subject.value)
        : $rdf.blankNode(q.subject.value);

      // predicate (always a NamedNode)
      const p = $rdf.sym(q.predicate.value);

      // object
      let o;
      if (q.object.termType === 'NamedNode') {
        o = $rdf.sym(q.object.value);
      } else if (q.object.termType === 'BlankNode') {
        o = $rdf.blankNode(q.object.value);
      } else {
        // Literal
        const lang = q.object.language || undefined;
        const dt   = q.object.datatype ? $rdf.sym(q.object.datatype.value) : undefined;
        o = lang ? $rdf.literal(q.object.value, lang)
                 : dt   ? $rdf.literal(q.object.value, undefined, dt)
                        : $rdf.literal(q.object.value);
      }

      // graph (undefined means default graph)
      const g = (q.graph.termType === 'DefaultGraph') ? undefined : $rdf.sym(q.graph.value);

      temp.add(s, p, o, g);
    });
    quadStream.on('end', () => {
      if (debuggingConsoleEnabled) {console.info(`[applyConstructWithComunica] Constructed ${temp.statements.length} statements.`)};
      resolve(temp);
    });

    quadStream.on('error', reject);
  });
}

window.applyConstructWithComunica = applyConstructWithComunica;
