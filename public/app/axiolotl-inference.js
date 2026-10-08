import { datatypeComparisonExtensions } from './datatype-value-comparison.js';
// axiolotl-inference.js

// Dependencies: semantic-core.js and shared RDF/namespace utilities.
import {
  COMMON_NAMESPACE_IRIS,
  namespacePrefixMapFromRegistry
} from './shared/namespace-registry/index.js';
import {
  canUseTermAsGraph,
  canUseTermAsObject,
  canUseTermAsPredicate,
  canUseTermAsSubject,
  hasBlankNodeTermInQuad,
  isBlankNodeTerm,
  isAbsoluteIri
} from './shared/ontology-utils/index.js';
import {
  loadGraphFromIndexedDB,
  stashGraphToIndexedDB
} from './comunica-indexeddb-bridge.js';
import { debuggingConsoleEnabled } from './semantic-core.js';

const PREFIXES = namespacePrefixMapFromRegistry();
const engine = new Comunica.QueryEngine();

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

const INFERENCE_RULE_ORDER = Object.freeze([
  'subpropertyof',
  'equivalentproperty',
  'inverse',
  'symmetric',
  'transitive',
  'propertychain',
  'domain',
  'range',
  'subclassof',
  'equivalentclass',
  'intersectionof',
  'hasvalue',
  'hasvalueclass',
  'allvaluesfrom',
  'somevaluesfromclass',
  'functional',
  'inversefunctional',
  'sameas',
]);

function orderInferenceRules(rules) {
  const selected = new Set(rules);
  const ordered = INFERENCE_RULE_ORDER.filter(rule => selected.has(rule));
  for (const rule of rules) {
    if (!INFERENCE_RULE_ORDER.includes(rule) && !ordered.includes(rule)) {
      ordered.push(rule);
    }
  }
  return ordered;
}

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

function inferenceInfo(message) {
  if (debuggingConsoleEnabled) console.info(message);
  appendInferenceConsoleLine(message);
}

function inferenceWarn(message) {
  if (debuggingConsoleEnabled) console.warn(message);
  appendInferenceConsoleLine(`WARN: ${message}`);
}

function inferenceError(message) {
  if (debuggingConsoleEnabled) console.error(message);
  appendInferenceConsoleLine(`ERROR: ${message}`);
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

function looseQuadKey(q) {
  const subj =
    isBlankNodeTerm(q.subject)
      ? 'BlankNode:_'
      : `${q.subject.termType}:${q.subject.value}`;

  const obj =
    isBlankNodeTerm(q.object)
      ? 'BlankNode:_'
      : `${q.object.termType}:${q.object.value}:${q.object.language || ''}:${q.object.datatype?.value || ''}`;

  const graph =
    isBlankNodeTerm(q.graph)
      ? 'BlankNode:_'
      : `${q.graph.termType}:${q.graph.value || ''}`;

  return [
    subj,
    `${q.predicate.termType}:${q.predicate.value}`,
    obj,
    graph
  ].join('¦');
}

function isSerializableInferenceQuad(q) {
  return !!q
    && canUseTermAsSubject(q.subject)
    && canUseTermAsPredicate(q.predicate)
    && canUseTermAsObject(q.object)
    && canUseTermAsGraph(q.graph);
}

function selectSerializableInferenceQuads(quads, context = 'inference') {
  let skipped = 0;
  const selected = [];

  for (const q of quads || []) {
    if (isSerializableInferenceQuad(q)) selected.push(q);
    else skipped++;
  }

  if (skipped) {
    inferenceWarn(`[${context}] Skipped ${skipped} invalid constructed quad${skipped === 1 ? '' : 's'} before overlay serialization.`);
  }

  return selected;
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
  const orderedRules = orderInferenceRules(rules);
  if (debuggingConsoleEnabled) {
    console.info('[inferUntilStable] Starting inference over rules:', orderedRules);
  }

  const { DataFactory, Store } = N3;
  const { namedNode, quad } = DataFactory;

  // ---- 0) Load dataset and set up dedupe ----
  const baseStore = await loadGraphFromIndexedDB();
  const rdfjsStore = baseStore;              // mutate in place as closure/rules add quads
  const overlayStore = new Store();          // only newly inferred quads
  const seen = new Set(rdfjsStore.getQuads(null, null, null, null).map(quadKey));

  // ---- 1) Precompute TBox closures/maps ----
  const subClassEdges = mapFromQuads(rdfjsStore, COMMON_NAMESPACE_IRIS.rdfs.subClassOf);
  const subPropEdges  = mapFromQuads(rdfjsStore, COMMON_NAMESPACE_IRIS.rdfs.subPropertyOf);

  const classSupers = transitiveClosure(subClassEdges); // Map<class -> Set<allSuperClasses>>
  const propSupers  = transitiveClosure(subPropEdges);  // Map<prop  -> Set<allSuperProps>>

  const domainMap = mapFromQuads(rdfjsStore, COMMON_NAMESPACE_IRIS.rdfs.domain); // Map<prop -> Set<class>>
  const rangeMap  = mapFromQuads(rdfjsStore, COMMON_NAMESPACE_IRIS.rdfs.range);  // Map<prop -> Set<class>>

  const symmetricProps = new Set(
    rdfjsStore
      .getQuads(null, namedNode(COMMON_NAMESPACE_IRIS.rdf.type), namedNode(COMMON_NAMESPACE_IRIS.owl.SymmetricProperty), null)
      .map(q => q.subject.value)
  );

  const transitiveProps = new Set(
    rdfjsStore
      .getQuads(null, namedNode(COMMON_NAMESPACE_IRIS.rdf.type), namedNode(COMMON_NAMESPACE_IRIS.owl.TransitiveProperty), null)
      .map(q => q.subject.value)
  );

  // Make owl:inverseOf two-way
  const inversePairs = new Map(); // Map<p -> Set<inv>>
  for (const q of rdfjsStore.getQuads(null, namedNode(COMMON_NAMESPACE_IRIS.owl.inverseOf), null, null)) {
    const p = q.subject.value;
    const inv = q.object.value;

    if (!inversePairs.has(p)) inversePairs.set(p, new Set());
    if (!inversePairs.has(inv)) inversePairs.set(inv, new Set());

    inversePairs.get(p).add(inv);
    inversePairs.get(inv).add(p);
  }

  // ---- 2) Work queues and enqueue logic ----
  const workTypes = rdfjsStore.getQuads(null, namedNode(COMMON_NAMESPACE_IRIS.rdf.type), null, null).slice();
  const workProps = rdfjsStore
    .getQuads(null, null, null, null)
    .filter(q => q.predicate.value !== COMMON_NAMESPACE_IRIS.rdf.type);

  function enqueue(quads) {
    for (const q of quads) {
      const key = quadKey(q);
      if (seen.has(key)) continue;

      rdfjsStore.addQuad(q);
      overlayStore.addQuad(q);
      seen.add(key);

      if (q.predicate.value === COMMON_NAMESPACE_IRIS.rdf.type) workTypes.push(q);
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
          namedNode(COMMON_NAMESPACE_IRIS.rdf.type),
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

      if (!canUseTermAsSubject(q.object)) continue;

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
            namedNode(COMMON_NAMESPACE_IRIS.rdf.type),
            namedNode(d),
            q.graph
          ));
        }
      }

      const Rs = rangeMap.get(p);
      if (Rs && canUseTermAsSubject(q.object)) {
        for (const r of Rs) {
          if (typeof isAbsoluteIri === 'function' && !isAbsoluteIri(r)) {
            skipRng++;
            continue;
          }

          out.push(quad(
            q.object,
            namedNode(COMMON_NAMESPACE_IRIS.rdf.type),
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
      if (canUseTermAsSubject(q.object)) {
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
  const MAX_PASSES = 30;

  const seedSeenBefore = seen.size;
  processQueues();
  const seedAdded = seen.size - seedSeenBefore;
  totalAdded += seedAdded;

  inferenceInfo(`[inferUntilStable] Seed closures added ${seedAdded} triples.`);

  const rulesFiltered = orderedRules.filter(r => r !== 'subclassof' && r !== 'subpropertyof');
  if (orderedRules.length !== rulesFiltered.length) {
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

      const blankCount = newQuads.filter(hasBlankNodeTermInQuad).length;
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

/**
 * Returns a SPARQL CONSTRUCT string for a given rule name.
 * Each rule is a single CONSTRUCT query (no semicolons between queries).
 * Uses MINUS to return only triples not already present.
 * @param {string} rule - Rule identifier
 * @returns {string} SPARQL CONSTRUCT query
 */
function getConstructQueryForRule(rule) {
  const prefixDeclarations = `
    PREFIX rdf:  <${PREFIXES.rdf}>
    PREFIX rdfs: <${PREFIXES.rdfs}>
    PREFIX owl:  <${PREFIXES.owl}>
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
          FILTER(isIRI(?y) || isBlank(?y))
          BIND(?y AS ?S) BIND(?inverse AS ?P) BIND(?x AS ?O)
        }
        UNION
        {
          ?x ?inverse ?y .
          ?p owl:inverseOf ?inverse .
          FILTER(isIRI(?y) || isBlank(?y))
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
        FILTER(isIRI(?y) || isBlank(?y))
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
        FILTER(isIRI(?y) || isBlank(?y))
        FILTER NOT EXISTS {
          { ?y ?p ?x }
          UNION
          { GRAPH ?g { ?y ?p ?x } }
        }
      }
    `,

    equivalentclass: `
      CONSTRUCT { ?x rdf:type ?equivalentClass }
      WHERE {
        ?class owl:equivalentClass ?equivalentClass .
        ?x rdf:type ?class .
        FILTER(?class != ?equivalentClass)
        FILTER(isIRI(?equivalentClass))
        FILTER NOT EXISTS {
          { ?x rdf:type ?equivalentClass }
          UNION
          { GRAPH ?g { ?x rdf:type ?equivalentClass } }
        }
      }
    `,

    equivalentproperty: `
      CONSTRUCT { ?x ?equivalentProperty ?y }
      WHERE {
        ?property owl:equivalentProperty ?equivalentProperty .
        ?x ?property ?y .
        FILTER(?property != ?equivalentProperty)
        FILTER(isIRI(?equivalentProperty))
        FILTER NOT EXISTS {
          { ?x ?equivalentProperty ?y }
          UNION
          { GRAPH ?g { ?x ?equivalentProperty ?y } }
        }
      }
    `,

    sameas: `
      CONSTRUCT { ?S ?P ?O }
      WHERE {
        {
          ?x owl:sameAs ?y .
          BIND(?y AS ?S) BIND(owl:sameAs AS ?P) BIND(?x AS ?O)
        }
        UNION
        {
          ?x owl:sameAs ?y .
          ?y owl:sameAs ?z .
          BIND(?x AS ?S) BIND(owl:sameAs AS ?P) BIND(?z AS ?O)
        }
        UNION
        {
          ?x owl:sameAs ?y .
          ?x ?p ?o .
          BIND(?y AS ?S) BIND(?p AS ?P) BIND(?o AS ?O)
        }
        UNION
        {
          ?x owl:sameAs ?y .
          ?s ?p ?x .
          BIND(?s AS ?S) BIND(?p AS ?P) BIND(?y AS ?O)
        }
        FILTER NOT EXISTS {
          { ?S ?P ?O }
          UNION
          { GRAPH ?g { ?S ?P ?O } }
        }
      }
    `,

    functional: `
      CONSTRUCT { ?v1 owl:sameAs ?v2 }
      WHERE {
        ?p rdf:type owl:FunctionalProperty .
        ?x ?p ?v1 .
        ?x ?p ?v2 .
        FILTER(?v1 != ?v2)
        FILTER(!isLiteral(?v1) && !isLiteral(?v2))
        FILTER NOT EXISTS {
          { ?v1 owl:sameAs ?v2 }
          UNION
          { GRAPH ?g { ?v1 owl:sameAs ?v2 } }
        }
      }
    `,

    inversefunctional: `
      CONSTRUCT { ?x1 owl:sameAs ?x2 }
      WHERE {
        ?p rdf:type owl:InverseFunctionalProperty .
        ?x1 ?p ?y .
        ?x2 ?p ?y .
        FILTER(?x1 != ?x2)
        FILTER NOT EXISTS {
          { ?x1 owl:sameAs ?x2 }
          UNION
          { GRAPH ?g { ?x1 owl:sameAs ?x2 } }
        }
      }
    `,

    hasvalue: `
      CONSTRUCT { ?x ?p ?v }
      WHERE {
        ?class rdfs:subClassOf ?restriction .
        ?restriction rdf:type owl:Restriction ;
                     owl:onProperty ?p ;
                     owl:hasValue ?v .
        ?x rdf:type ?class .
        FILTER NOT EXISTS {
          { ?x ?p ?v }
          UNION
          { GRAPH ?g { ?x ?p ?v } }
        }
      }
    `,

    hasvalueclass: `
      CONSTRUCT { ?x rdf:type ?class }
      WHERE {
        ?class (owl:equivalentClass|^owl:equivalentClass) ?restriction .
        FILTER(isIRI(?class))
        ?restriction rdf:type owl:Restriction ;
                     owl:onProperty ?p ;
                     owl:hasValue ?v .
        ?x ?p ?v .
        FILTER NOT EXISTS {
          { ?x rdf:type ?class }
          UNION
          { GRAPH ?g { ?x rdf:type ?class } }
        }
      }
    `,

    allvaluesfrom: `
      CONSTRUCT { ?y rdf:type ?filler }
      WHERE {
        ?class rdfs:subClassOf ?restriction .
        ?restriction rdf:type owl:Restriction ;
                     owl:onProperty ?p ;
                     owl:allValuesFrom ?filler .
        ?x rdf:type ?class .
        ?x ?p ?y .
        FILTER(isIRI(?filler))
        FILTER NOT EXISTS {
          { ?y rdf:type ?filler }
          UNION
          { GRAPH ?g { ?y rdf:type ?filler } }
        }
      }
    `,

    somevaluesfromclass: `
      CONSTRUCT { ?x rdf:type ?class }
      WHERE {
        ?class (owl:equivalentClass|^owl:equivalentClass) ?restriction .
        FILTER(isIRI(?class))
        ?restriction rdf:type owl:Restriction ;
                     owl:onProperty ?p ;
                     owl:someValuesFrom ?filler .
        ?x ?p ?y .
        ?y rdf:type ?filler .
        FILTER NOT EXISTS {
          { ?x rdf:type ?class }
          UNION
          { GRAPH ?g { ?x rdf:type ?class } }
        }
      }
    `,

    intersectionof: `
      CONSTRUCT { ?x rdf:type ?class }
      WHERE {
        ?class owl:intersectionOf ?list .
        ?list rdf:rest*/rdf:first ?member .
        ?x rdf:type ?member .
        FILTER NOT EXISTS {
          ?list rdf:rest*/rdf:first ?required .
          FILTER NOT EXISTS {
            { ?x rdf:type ?required }
            UNION
            { GRAPH ?g1 { ?x rdf:type ?required } }
          }
        }
        FILTER NOT EXISTS {
          { ?x rdf:type ?class }
          UNION
          { GRAPH ?g2 { ?x rdf:type ?class } }
        }
      }
    `,

    propertychain: `
      CONSTRUCT { ?x ?superProperty ?z }
      WHERE {
        ?superProperty owl:propertyChainAxiom ?list .
        ?list rdf:first ?p1 ;
              rdf:rest/rdf:first ?p2 ;
              rdf:rest/rdf:rest rdf:nil .
        ?x ?p1 ?y .
        ?y ?p2 ?z .
        FILTER NOT EXISTS {
          { ?x ?superProperty ?z }
          UNION
          { GRAPH ?g { ?x ?superProperty ?z } }
        }
      }
    `,
  };

  if (!RULES[rule]) {
    if (debuggingConsoleEnabled) {
      console.warn(`[getConstructQueryForRule] Unknown inference rule: ${rule}`);
    }
    return '';
  }

  return prefixDeclarations + RULES[rule];
}

/**
 * Runs one inference rule once and returns newly inferred quads.
 * @param {string} rule
 * @param {N3.Store} rdfjsStore
 * @returns {Promise<Array<any>>}
 */
async function runRuleOnce(rule, rdfjsStore) {
  // Equality substitutes existing terms. Going through CONSTRUCT can rescope
  // source blank nodes, turning list cells into fresh nodes on every pass.
  if (rule === 'sameas') return materializeSameAs(rdfjsStore);
  const q = getConstructQueryForRule(rule);
  if (!q) return [];

  if (!isConstructQueryText(q)) {
    inferenceWarn(`[runRuleOnce] Skipping "${rule}" because it did not generate a CONSTRUCT query.`);
    if (debuggingConsoleEnabled) {
      console.warn('[runRuleOnce] Non-CONSTRUCT query preview:', q.slice(0, 300));
    }
    return [];
  }

  try {
    return await applyConstructWithComunica(q, rdfjsStore);
  } catch (error) {
    inferenceError(`[runRuleOnce] Rule "${rule}" failed: ${error.message || error}`);
    if (debuggingConsoleEnabled) {
      console.error(`[runRuleOnce] Rule "${rule}" query preview:`, q.slice(0, 600), error);
    }
    return [];
  }
}

function materializeSameAs(store) {
  const { namedNode, quad, defaultGraph } = N3.DataFactory;
  const sameAs = namedNode(COMMON_NAMESPACE_IRIS.owl.sameAs);
  const additions = new Map();
  const add = (subject, predicate, object) => {
    const candidate = quad(subject, predicate, object, defaultGraph());
    if (!isSerializableInferenceQuad(candidate)) return;
    if (store.countQuads(subject, predicate, object, null)) return;
    additions.set(quadKey(candidate), candidate);
  };

  // Match the existing rule's default-graph input scope; retain the exact RDF/JS
  // terms, including distinct blank-node identities, in every substitution.
  for (const { subject: x, object: y } of store.getQuads(null, sameAs, null, defaultGraph())) {
    add(y, sameAs, x);
    for (const { object: z } of store.getQuads(y, sameAs, null, defaultGraph())) add(x, sameAs, z);
    for (const { predicate, object } of store.getQuads(x, null, null, defaultGraph())) add(y, predicate, object);
    for (const { subject, predicate } of store.getQuads(null, null, x, defaultGraph())) add(subject, predicate, y);
  }
  return [...additions.values()];
}

function isConstructQueryText(queryText) {
  return /^CONSTRUCT\b/i.test(stripSparqlPrologue(queryText));
}

function stripSparqlPrologue(queryText) {
  let text = String(queryText || '').trimStart();

  while (text) {
    const before = text;
    text = text
      .replace(/^PREFIX\s+[\w-]*:\s*<[^>]+>\s*/i, '')
      .replace(/^BASE\s*<[^>]+>\s*/i, '')
      .trimStart();

    if (text === before) break;
  }

  return text;
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
    extensionFunctions: datatypeComparisonExtensions(),
  });

  const quads = await new Promise((resolve, reject) => {
    const quads = [];
    quadStream.on('data', q => quads.push(q));
    quadStream.on('end', () => resolve(quads));
    quadStream.on('error', reject);
  });

  return selectSerializableInferenceQuads(quads, 'applyConstructWithComunica');
}

export {
  appendInferenceConsoleLine,
  applyConstructWithComunica,
  clearInferenceConsole,
  getConstructQueryForRule,
  getSelectedRulesFromCheckboxes,
  inferUntilStable,
  mapFromQuads,
  runInferenceOverlay,
  runRuleOnce,
  selectSerializableInferenceQuads,
  setInferenceBusy,
  transitiveClosure
};
