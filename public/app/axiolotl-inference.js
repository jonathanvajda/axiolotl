// axiolotl-inference.js

// Dependencies
  // comunica-indexeddb-bridge.js
    //  applyUpdateWithComunica
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
  const { namedNode } = N3.DataFactory;
  const M = new Map();

  for (const q of store.getQuads(null, namedNode(predIRI), null, null)) {
    const a = q.subject.value;
    const b = q.object.value;
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
 * Clears the Inference Engine console
 */
function clearInferenceConsole() {
  const box = document.getElementById('inference-console');
  if (box) box.value = '';
}

function appendInferenceConsoleLine(message) {
  const box = document.getElementById('inference-console');
  if (!box) return;
  box.value += `${message}\n`;
  box.scrollTop = box.scrollHeight;
}

function setInferenceBusy(isBusy) {
  const spinner = document.getElementById('inference-spinner');
  if (!spinner) return;

  spinner.classList.toggle('is-busy', !!isBusy);
}

window.appendInferenceConsoleLine = appendInferenceConsoleLine;
window.clearInferenceConsole = clearInferenceConsole;
window.setInferenceBusy = setInferenceBusy;

function inferenceInfo(message) {
  if (debuggingConsoleEnabled) console.info(message);
  if (typeof window !== 'undefined' && typeof window.appendInferenceConsoleLine === 'function') {
    window.appendInferenceConsoleLine(message);
  }
}

function inferenceWarn(message) {
  if (debuggingConsoleEnabled) console.warn(message);
  if (typeof window !== 'undefined' && typeof window.appendInferenceConsoleLine === 'function') {
    window.appendInferenceConsoleLine(`WARN: ${message}`);
  }
}

function inferenceError(message) {
  if (debuggingConsoleEnabled) console.error(message);
  if (typeof window !== 'undefined' && typeof window.appendInferenceConsoleLine === 'function') {
    window.appendInferenceConsoleLine(`ERROR: ${message}`);
  }
}

// set up the key:value structure
function quadKey(q) {
  return [
    q.subject.termType, q.subject.value,
    q.predicate.termType, q.predicate.value,
    q.object.termType, q.object.value,
    q.object.language || '',
    q.object.datatype?.value || '',
    q.graph.termType, q.graph.value || ''
  ].join('¦');
}

function quadHasBlankNode(q) {
  return q.subject.termType === 'BlankNode' ||
         q.object.termType === 'BlankNode' ||
         q.graph.termType === 'BlankNode';
}

function looseQuadKey(q) {
  const subj =
    q.subject.termType === 'BlankNode'
      ? 'BlankNode:_'
      : `${q.subject.termType}:${q.subject.value}`;

  const obj =
    q.object.termType === 'BlankNode'
      ? 'BlankNode:_'
      : `${q.object.termType}:${q.object.value}:${q.object.language || ''}:${q.object.datatype?.value || ''}`;

  const graph =
    q.graph.termType === 'BlankNode'
      ? 'BlankNode:_'
      : `${q.graph.termType}:${q.graph.value || ''}`;

  return [
    subj,
    `${q.predicate.termType}:${q.predicate.value}`,
    obj,
    graph
  ].join('¦');
}

function canBeSubject(term) {
  return !!term && (term.termType === 'NamedNode' || term.termType === 'BlankNode');
}
/**
 * Applies a set of inference rules repeatedly until no new triples are added.
 * @param {string[]} rules - List of rule identifiers to apply (e.g. ["inverse", "subclassof"])
 * @returns {quad} quas 
 * Event-driven: new ABox assertions immediately trigger subclass/subproperty,
 * inverse/symmetric, and domain/range expansions using precomputed TBox closures.
*/
// axiolotl-inference.js
async function inferUntilStable(rules) {
  if (debuggingConsoleEnabled) {
    console.info('[inferUntilStable] Starting inference over rules:', rules);
  }

  const { DataFactory, Store } = N3;
  const { namedNode, quad } = DataFactory;

  // ---- 0) Load dataset and set up dedupe ----
  const baseStore = await loadGraphFromIndexedDB();
  const rdfjsStore = baseStore;              // mutate in place as closure/rules add quads
  const overlayStore = new Store();          // only newly inferred quads
  const seen = new Set(rdfjsStore.getQuads(null, null, null, null).map(quadKey));

  // ---- 1) Precompute TBox closures/maps ----
  const subClassEdges = mapFromQuads(rdfjsStore, RDFS_SC);
  const subPropEdges  = mapFromQuads(rdfjsStore, RDFS_SP);

  const classSupers = transitiveClosure(subClassEdges); // Map<class -> Set<allSuperClasses>>
  const propSupers  = transitiveClosure(subPropEdges);  // Map<prop  -> Set<allSuperProps>>

  const domainMap = mapFromQuads(rdfjsStore, RDFS_DOMAIN); // Map<prop -> Set<class>>
  const rangeMap  = mapFromQuads(rdfjsStore, RDFS_RANGE);  // Map<prop -> Set<class>>

  const symmetricProps = new Set(
    rdfjsStore
      .getQuads(null, namedNode(RDF_TYPE), namedNode(OWL_SYM), null)
      .map(q => q.subject.value)
  );

  const transitiveProps = new Set(
    rdfjsStore
      .getQuads(null, namedNode(RDF_TYPE), namedNode(OWL_TRANS), null)
      .map(q => q.subject.value)
  );

  // Make owl:inverseOf two-way
  const inversePairs = new Map(); // Map<p -> Set<inv>>
  for (const q of rdfjsStore.getQuads(null, namedNode(OWL_INV), null, null)) {
    const p = q.subject.value;
    const inv = q.object.value;

    if (!inversePairs.has(p)) inversePairs.set(p, new Set());
    if (!inversePairs.has(inv)) inversePairs.set(inv, new Set());

    inversePairs.get(p).add(inv);
    inversePairs.get(inv).add(p);
  }

  // ---- 2) Work queues and enqueue logic ----
  const workTypes = rdfjsStore.getQuads(null, namedNode(RDF_TYPE), null, null).slice();
  const workProps = rdfjsStore
    .getQuads(null, null, null, null)
    .filter(q => q.predicate.value !== RDF_TYPE);

  function enqueue(quads) {
    for (const q of quads) {
      const key = quadKey(q);
      if (seen.has(key)) continue;

      rdfjsStore.addQuad(q);
      overlayStore.addQuad(q);
      seen.add(key);

      if (q.predicate.value === RDF_TYPE) workTypes.push(q);
      else workProps.push(q);
    }
  }

  function expandTypesWithClosure(newTypes) {
    const out = [];
    let skipped = 0;

    for (const q of newTypes) {
      const c = q.object.value;
      const supers = classSupers.get(c);
      if (!supers) continue;

      for (const sup of supers) {
        if (typeof isAbsoluteIri === 'function' && !isAbsoluteIri(sup)) {
          skipped++;
          continue;
        }

        out.push(quad(
          q.subject,
          namedNode(RDF_TYPE),
          namedNode(sup),
          q.graph
        ));
      }
    }

    if (debuggingConsoleEnabled && skipped) {
      console.warn(`[expandTypesWithClosure] Skipped ${skipped} non-IRI super-classes`);
    }

    return out;
  }

  function expandPropsWithClosure(newProps) {
    const out = [];
    let skipped = 0;

    for (const q of newProps) {
      const p = q.predicate.value;
      const supers = propSupers.get(p);
      if (!supers) continue;

      for (const sup of supers) {
        if (typeof isAbsoluteIri === 'function' && !isAbsoluteIri(sup)) {
          skipped++;
          continue;
        }

        out.push(quad(
          q.subject,
          namedNode(sup),
          q.object,
          q.graph
        ));
      }
    }

    if (debuggingConsoleEnabled && skipped) {
      console.warn(`[expandPropsWithClosure] Skipped ${skipped} non-IRI super-properties`);
    }

    return out;
  }

  function applyInverseAndSymmetric(newProps) {
    const out = [];

    for (const q of newProps) {
      const p = q.predicate.value;

      if (!canBeSubject(q.object)) continue;

      if (symmetricProps.has(p)) {
        out.push(quad(
          q.object,
          namedNode(p),
          q.subject,
          q.graph
        ));
      }

      const invs = inversePairs.get(p);
      if (invs) {
        for (const inv of invs) {
          out.push(quad(
            q.object,
            namedNode(inv),
            q.subject,
            q.graph
          ));
        }
      }
    }

    return out;
  }

  function applyDomainRange(newProps) {
    const out = [];
    let skipDom = 0;
    let skipRng = 0;

    for (const q of newProps) {
      const p = q.predicate.value;

      const Ds = domainMap.get(p);
      if (Ds) {
        for (const d of Ds) {
          if (typeof isAbsoluteIri === 'function' && !isAbsoluteIri(d)) {
            skipDom++;
            continue;
          }

          out.push(quad(
            q.subject,
            namedNode(RDF_TYPE),
            namedNode(d),
            q.graph
          ));
        }
      }

      const Rs = rangeMap.get(p);
      if (Rs && canBeSubject(q.object)) {
        for (const r of Rs) {
          if (typeof isAbsoluteIri === 'function' && !isAbsoluteIri(r)) {
            skipRng++;
            continue;
          }

          out.push(quad(
            q.object,
            namedNode(RDF_TYPE),
            namedNode(r),
            q.graph
          ));
        }
      }
    }

    if (debuggingConsoleEnabled && skipDom) {
      console.warn(`[applyDomainRange] Skipped ${skipDom} domain classes that were not IRIs`);
    }
    if (debuggingConsoleEnabled && skipRng) {
      console.warn(`[applyDomainRange] Skipped ${skipRng} range classes that were not IRIs`);
    }

    return out;
  }

  function applyTransitiveProps(newPropsBatch) {
    const out = [];

    for (const q of newPropsBatch) {
      const p = q.predicate.value;
      if (!transitiveProps.has(p)) continue;

      const pred = namedNode(p);

      // x p y & y p z -> x p z
      if (canBeSubject(q.object)) {
        for (const yz of rdfjsStore.getQuads(q.object, pred, null, q.graph)) {
          out.push(quad(
            q.subject,
            pred,
            yz.object,
            q.graph
          ));
        }
      }

      // w p x & x p y -> w p y
      for (const wx of rdfjsStore.getQuads(null, pred, q.subject, q.graph)) {
        out.push(quad(
          wx.subject,
          pred,
          q.object,
          q.graph
        ));
      }
    }

    return out;
  }

  function processQueues() {
    let progressed = false;

    while (workTypes.length || workProps.length) {
      if (workTypes.length) {
        const batch = workTypes.splice(0, workTypes.length);
        const extra = expandTypesWithClosure(batch);
        if (extra.length) {
          enqueue(extra);
          progressed = true;
        }
      }

      if (workProps.length) {
        const batch = workProps.splice(0, workProps.length);
        const extra1 = expandPropsWithClosure(batch);
        const extra2 = applyInverseAndSymmetric(batch);
        const extra3 = applyDomainRange(batch);
        const extra4 = applyTransitiveProps(batch);

        if (extra1.length) { enqueue(extra1); progressed = true; }
        if (extra2.length) { enqueue(extra2); progressed = true; }
        if (extra3.length) { enqueue(extra3); progressed = true; }
        if (extra4.length) { enqueue(extra4); progressed = true; }
      }
    }

    return progressed;
  }

  // ---- 3) Seed closures from existing dataset ----
  let totalAdded = 0;
  let pass = 0;
  const MAX_PASSES = 20;

  const seedSeenBefore = seen.size;
  processQueues();
  const seedAdded = seen.size - seedSeenBefore;
  totalAdded += seedAdded;

  inferenceInfo(`[inferUntilStable] Seed closures added ${seedAdded} triples.`);

  const rulesFiltered = rules.filter(r => r !== 'subclassof' && r !== 'subpropertyof');
  if (rules.length !== rulesFiltered.length) {
    inferenceInfo('[inferUntilStable] SPARQL disabled for subclassof/subpropertyof; using JS closures instead.');
  }

  let changed = true;

  while (changed) {
    pass += 1;
    if (pass > MAX_PASSES) {
      throw new Error(`[inferUntilStable] Aborted after ${MAX_PASSES} passes. Likely non-stable loop.`);
    }

    changed = false;
    let passAdded = 0;

    inferenceInfo(`[inferUntilStable] Starting pass ${pass}...`);

    for (const rule of rulesFiltered) {
      const constructQuery = getConstructQueryForRule(rule);
      if (!constructQuery) continue;

      const newQuads = await runRuleOnce(rule, rdfjsStore);

      const blankCount = newQuads.filter(quadHasBlankNode).length;
      const looseCount = new Set(newQuads.map(looseQuadKey)).size;

      inferenceInfo(
        `[inferUntilStable] Pass ${pass}, rule "${rule}": raw=${newQuads.length}, withBlank=${blankCount}, looseUnique=${looseCount}`
      );

      const batch = [];
      const batchSeen = new Set();
      for (const q of newQuads) {
        const key = quadKey(q);
        if (batchSeen.has(key)) continue;
        batchSeen.add(key);
        batch.push(q);
      }

      const beforeDirect = seen.size;
      enqueue(batch);
      const directAdded = seen.size - beforeDirect;

      const beforeClosure = seen.size;
      processQueues();
      const propagatedAdded = seen.size - beforeClosure;

      const totalRuleAdded = directAdded + propagatedAdded;

      inferenceInfo(
        `[inferUntilStable] Pass ${pass}, rule "${rule}": direct=${directAdded}, propagated=${propagatedAdded}, total=${totalRuleAdded}`
      );

      if (totalRuleAdded > 0) {
        passAdded += totalRuleAdded;
        totalAdded += totalRuleAdded;
        changed = true;
      }
    }

    if (passAdded > 0) {
      inferenceInfo(`[inferUntilStable] Completed pass ${pass}: added ${passAdded} triples.`);
    } else {
      inferenceInfo(`[inferUntilStable] Completed pass ${pass}: no new triples. Stable.`);
    }
  }

  const overlayCount = overlayStore.getQuads(null, null, null, null).length;

  inferenceInfo(
    `[inferUntilStable] Completed inference. Passes=${pass}, total new triples=${totalAdded}, overlay triples=${overlayCount}`
  );

  return {
    overlayGraph: overlayStore,
    metrics: { totalAdded, passes: pass, overlayCount }
  };
}

/**
 * Run inference (until stable) to produce an overlay dataset; optionally persist overlay.
 * @param {Object} opt
 * @param {string[]} opt.rules
 * @param {'default'|'named'} [opt.targetMode='default']
 * @param {string|null} [opt.graphIRI=null]
 * @param {boolean} [opt.persist=false]
 * @returns {Promise<{overlayGraph:N3.Store, metrics:Object, count?:number, graphIRI?:string}>}
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
 * De-duplicate a batch and remove quads already present in the global `seen` set.
 * @param {Array<any>} quads
 * @param {Set<string>} seenKeys
 * @returns {{ $new: Array<any>, batchUnique: number }}
 */
function selectUnseen(quads, seenKeys) {
  const batchSet = new Set();
  const uniq = [];

  for (const q of quads) {
    const key = quadKey(q);
    if (batchSet.has(key)) continue;
    batchSet.add(key);
    if (!seenKeys.has(key)) uniq.push(q);
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

  const { Writer, DataFactory } = N3;
  const { quad, defaultGraph } = DataFactory;

  // Flatten to triples for INSERT DATA; target graph is controlled by mode/graphIRI.
  const flattened = overlayGraph
    .getQuads(null, null, null, null)
    .map(q => quad(q.subject, q.predicate, q.object, defaultGraph()));

  const nt = await new Promise((resolve, reject) => {
    const writer = new Writer({ format: 'N-Triples' });
    writer.addQuads(flattened);
    writer.end((error, result) => {
      if (error) reject(error);
      else resolve((result || '').trim());
    });
  });

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
 * Runs one inference rule once and returns newly inferred quads.
 * @param {string} rule
 * @param {N3.Store} rdfjsStore
 * @returns {Promise<Array<any>>}
 */
async function runRuleOnce(rule, rdfjsStore) {
  const q = getConstructQueryForRule(rule);
  if (!q) return [];
  return await applyConstructWithComunica(q, rdfjsStore);
}

/**
 * Applies a SPARQL CONSTRUCT query into the rdfjsStore
 * @param {*} constructQuery 
 * @param {*} rdfjsStore 
 * @returns 
 */
async function applyConstructWithComunica(constructQuery, rdfjsStore) {
  const quadStream = await engine.queryQuads(constructQuery, {
    sources: [{ type: 'rdfjsSource', value: rdfjsStore }],
    baseIRI: 'http://example.org/',
    distinctConstruct: true,
  });

  return await new Promise((resolve, reject) => {
    const quads = [];
    quadStream.on('data', q => quads.push(q));
    quadStream.on('end', () => resolve(quads));
    quadStream.on('error', reject);
  });
}

window.applyConstructWithComunica = applyConstructWithComunica;
