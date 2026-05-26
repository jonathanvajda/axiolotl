// axiolotl-inconsistency.js
// Additive helpers for ontology inconsistency checks and hydration queries.

const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
const OWL = 'http://www.w3.org/2002/07/owl#';
const AXI = 'http://example.org/axiolotl/inconsistency#';
const HYD = 'http://example.org/hydration/';

const COMMON_PREFIXES = `
PREFIX rdf:  <${RDF}>
PREFIX rdfs: <${RDFS}>
PREFIX owl:  <${OWL}>
PREFIX xsd:  <http://www.w3.org/2001/XMLSchema#>
PREFIX axi:  <${AXI}>
PREFIX hyd:  <${HYD}>
`;

const DEFAULT_QUERY_OPTIONS = Object.freeze({
  scope: 'union',
  graphIri: null,
  resultForm: 'select',
});

let browserComunicaEngine = null;

/**
 * @typedef {'default'|'named'|'union'} AxiolotlGraphScope
 * @typedef {'select'|'ask'|'construct'} AxiolotlResultForm
 * @typedef {{ scope?: AxiolotlGraphScope, graphIri?: string|null, resultForm?: AxiolotlResultForm }} AxiolotlQueryOptions
 * @typedef {{ id: string, label: string, family: string, owlProfile: string, support: string, notes: string }} AxiolotlCoverageItem
 * @typedef {{ id: string, label: string, description: string, family: string, supported: boolean, select: Function, construct?: Function, ask?: Function }} AxiolotlQueryDefinition
 */

/**
 * Return a normalized options object for inconsistency and hydration queries.
 * @param {AxiolotlQueryOptions} [options]
 * @returns {Required<AxiolotlQueryOptions>}
 */
export function normalizeQueryOptions(options = {}) {
  const scope = options.scope || DEFAULT_QUERY_OPTIONS.scope;
  if (!['default', 'named', 'union'].includes(scope)) {
    throw new Error(`Unsupported graph scope: ${scope}`);
  }

  const resultForm = options.resultForm || DEFAULT_QUERY_OPTIONS.resultForm;
  if (!['select', 'ask', 'construct'].includes(resultForm)) {
    throw new Error(`Unsupported result form: ${resultForm}`);
  }

  if (scope === 'named' && !options.graphIri) {
    throw new Error('Named graph scope requires graphIri.');
  }

  return {
    scope,
    graphIri: options.graphIri || null,
    resultForm,
  };
}

/**
 * Wrap a SPARQL group so it evaluates against the requested graph scope.
 * @param {string} body
 * @param {AxiolotlQueryOptions} [options]
 * @returns {string}
 */
export function scopedWhere(body, options = {}) {
  const normalized = normalizeQueryOptions(options);
  const trimmed = body.trim();

  if (normalized.scope === 'default') return trimmed;
  if (normalized.scope === 'named') return `GRAPH <${escapeIri(normalized.graphIri)}> {\n${indent(trimmed)}\n}`;

  return `{\n${indent(trimmed)}\n}\nUNION\n{\n  GRAPH ?axiolotlGraph {\n${indent(trimmed, 4)}\n  }\n}`;
}

/**
 * Return true when a value is a registered inconsistency query id.
 * @param {string} id
 * @returns {boolean}
 */
export function hasInconsistencyQuery(id) {
  return Object.prototype.hasOwnProperty.call(INCONSISTENCY_QUERIES, id);
}

/**
 * List the registered inconsistency query definitions.
 * @returns {AxiolotlQueryDefinition[]}
 */
export function listInconsistencyQueries() {
  return Object.values(INCONSISTENCY_QUERIES);
}

/**
 * Build a SPARQL query for a registered inconsistency check.
 * @param {string} id
 * @param {AxiolotlQueryOptions} [options]
 * @returns {string}
 */
export function getInconsistencyQuery(id, options = {}) {
  const definition = INCONSISTENCY_QUERIES[id];
  if (!definition) throw new Error(`Unknown inconsistency query: ${id}`);

  const normalized = normalizeQueryOptions(options);
  const builder = definition[normalized.resultForm];
  if (typeof builder !== 'function') {
    throw new Error(`Query ${id} does not support ${normalized.resultForm}.`);
  }

  return compactSparql(`${COMMON_PREFIXES}\n${builder(normalized)}`);
}

/**
 * Build every SELECT inconsistency query for the requested graph scope.
 * @param {AxiolotlQueryOptions} [options]
 * @returns {{ id: string, label: string, query: string }[]}
 */
export function getAllInconsistencySelectQueries(options = {}) {
  return listInconsistencyQueries()
    .filter(query => query.supported)
    .map(query => ({
      id: query.id,
      label: query.label,
      query: getInconsistencyQuery(query.id, { ...options, resultForm: 'select' }),
    }));
}

/**
 * Run a SELECT inconsistency query with a Comunica engine.
 * @param {string} id
 * @param {any} rdfjsStore
 * @param {{ engine?: any, baseIRI?: string } & AxiolotlQueryOptions} [options]
 * @returns {Promise<{ id: string, rows: Record<string, any>[] }>}
 */
export async function runInconsistencySelect(id, rdfjsStore, options = {}) {
  const queryEngine = resolveComunicaEngine(options.engine);
  if (!queryEngine || !hasSupportedSelectEngineApi(queryEngine)) {
    throw new Error('runInconsistencySelect requires a Comunica engine with queryBindings or query/resultToString.');
  }

  const query = getInconsistencyQuery(id, { ...options, resultForm: 'select' });
  console.info(`[axiolotl-inconsistency] Running ${id}`);

  try {
    const rows = await runSelectWithComunica(queryEngine, query, rdfjsStore, options);
    console.info(`[axiolotl-inconsistency] ${id} returned ${rows.length} row(s).`);
    return { id, rows };
  } catch (error) {
    console.error(`[axiolotl-inconsistency] ${id} failed`, error);
    throw error;
  }
}

/**
 * Run every supported SELECT inconsistency query.
 * @param {any} rdfjsStore
 * @param {{ engine?: any, baseIRI?: string } & AxiolotlQueryOptions} [options]
 * @returns {Promise<{ id: string, rows: Record<string, any>[] }[]>}
 */
export async function runAllInconsistencySelects(rdfjsStore, options = {}) {
  const results = [];
  for (const query of listInconsistencyQueries().filter(item => item.supported)) {
    results.push(await runInconsistencySelect(query.id, rdfjsStore, options));
  }
  return results;
}

/**
 * Apply a registered CONSTRUCT query with axiolotl-inference.js' applyConstructWithComunica.
 * @param {string} id
 * @param {any} rdfjsStore
 * @param {{ applyConstruct?: Function } & AxiolotlQueryOptions} [options]
 * @returns {Promise<any[]>}
 */
export async function constructInconsistencyReport(id, rdfjsStore, options = {}) {
  const applyConstruct = options.applyConstruct || globalThis.applyConstructWithComunica;
  if (typeof applyConstruct !== 'function') {
    throw new Error('constructInconsistencyReport requires applyConstructWithComunica or options.applyConstruct.');
  }

  const query = getInconsistencyQuery(id, { ...options, resultForm: 'construct' });
  return await applyConstruct(query, rdfjsStore);
}

/**
 * List documented support boundaries for the first inconsistency pass.
 * @returns {AxiolotlCoverageItem[]}
 */
export function listInconsistencyCoverage() {
  return COVERAGE.map(item => ({ ...item }));
}

/**
 * Return hydration query ids and descriptions.
 * @returns {{ id: string, label: string, description: string }[]}
 */
export function listHydrationQueries() {
  return Object.values(HYDRATION_QUERIES).map(({ id, label, description }) => ({ id, label, description }));
}

/**
 * Build a registered ontology hydration CONSTRUCT query.
 * @param {string} id
 * @param {{ runIri?: string, deterministicIris?: boolean } & AxiolotlQueryOptions} [options]
 * @returns {string}
 */
export function getHydrationConstructQuery(id, options = {}) {
  const definition = HYDRATION_QUERIES[id];
  if (!definition) throw new Error(`Unknown hydration query: ${id}`);
  const normalized = normalizeQueryOptions({ ...options, resultForm: 'construct' });
  return compactSparql(`${COMMON_PREFIXES}\n${definition.construct({ ...normalized, ...options })}`);
}

/**
 * Apply a hydration CONSTRUCT query with axiolotl-inference.js' applyConstructWithComunica.
 * @param {string} id
 * @param {any} rdfjsStore
 * @param {{ applyConstruct?: Function, runIri?: string, deterministicIris?: boolean } & AxiolotlQueryOptions} [options]
 * @returns {Promise<any[]>}
 */
export async function applyHydrationConstruct(id, rdfjsStore, options = {}) {
  const applyConstruct = options.applyConstruct || globalThis.applyConstructWithComunica;
  if (typeof applyConstruct !== 'function') {
    throw new Error('applyHydrationConstruct requires applyConstructWithComunica or options.applyConstruct.');
  }

  const query = getHydrationConstructQuery(id, options);
  return await applyConstruct(query, rdfjsStore);
}

const INCONSISTENCY_QUERIES = Object.freeze({
  disjointWithTypeOverlap: makeQueryDefinition({
    id: 'disjointWithTypeOverlap',
    label: 'owl:disjointWith type overlap',
    family: 'class-disjointness',
    description: 'Find individuals typed as both sides of an owl:disjointWith pair.',
    variables: ['x', 'A', 'B'],
    where: options => `
      ${scopedWhere('?A owl:disjointWith ?B .\n?x rdf:type ?A, ?B .', options)}
    `,
  }),

  allDisjointClassesTypeOverlap: makeQueryDefinition({
    id: 'allDisjointClassesTypeOverlap',
    label: 'owl:AllDisjointClasses type overlap',
    family: 'class-disjointness',
    description: 'Find individuals typed as multiple members of an owl:AllDisjointClasses list.',
    variables: ['x', 'set', 'A', 'B'],
    where: options => `
      ${scopedWhere(`
        ?set rdf:type owl:AllDisjointClasses .
        ?set owl:members/rdf:rest*/rdf:first ?A .
        ?set owl:members/rdf:rest*/rdf:first ?B .
        ?x rdf:type ?A, ?B .
      `, options)}
      FILTER(?A != ?B)
    `,
  }),

  complementOfTypeOverlap: makeQueryDefinition({
    id: 'complementOfTypeOverlap',
    label: 'owl:complementOf type overlap',
    family: 'class-complement',
    description: 'Find individuals typed as a class and its complement.',
    variables: ['x', 'A', 'B'],
    where: options => `
      {
        ${scopedWhere('?A owl:complementOf ?B .\n?x rdf:type ?A, ?B .', options)}
      }
      UNION
      {
        ${scopedWhere('?B owl:complementOf ?A .\n?x rdf:type ?A, ?B .', options)}
      }
    `,
  }),

  datatypeFunctionalPropertyConflict: makeQueryDefinition({
    id: 'datatypeFunctionalPropertyConflict',
    label: 'Datatype functional property conflict',
    family: 'property-cardinality',
    description: 'Find literal values that violate an owl:FunctionalProperty assertion.',
    variables: ['x', 'p', 'v1', 'v2'],
    where: options => `
      ${scopedWhere(`
        ?p rdf:type owl:FunctionalProperty .
        ?x ?p ?v1 .
        ?x ?p ?v2 .
      `, options)}
      FILTER(isLiteral(?v1) && isLiteral(?v2) && ?v1 != ?v2)
    `,
  }),

  objectFunctionalPropertyDifferentFromConflict: makeQueryDefinition({
    id: 'objectFunctionalPropertyDifferentFromConflict',
    label: 'Object functional property differentFrom conflict',
    family: 'property-cardinality',
    description: 'Find object values that violate a functional property via owl:differentFrom.',
    variables: ['x', 'p', 'y1', 'y2'],
    where: options => `
      ${scopedWhere(`
        ?p rdf:type owl:FunctionalProperty .
        ?x ?p ?y1 .
        ?x ?p ?y2 .
        ?y1 owl:differentFrom ?y2 .
      `, options)}
    `,
  }),

  negativePropertyAssertionConflict: makeQueryDefinition({
    id: 'negativePropertyAssertionConflict',
    label: 'Negative property assertion conflict',
    family: 'negative-assertion',
    description: 'Find asserted triples that contradict owl:NegativePropertyAssertion nodes.',
    variables: ['x', 'p', 'y', 'npa'],
    where: options => `
      ${scopedWhere(`
        ?x ?p ?y .
        ?npa rdf:type owl:NegativePropertyAssertion ;
             owl:sourceIndividual ?x ;
             owl:assertionProperty ?p ;
             owl:targetIndividual ?y .
      `, options)}
    `,
  }),

  allDifferentSameAsConflict: makeQueryDefinition({
    id: 'allDifferentSameAsConflict',
    label: 'owl:AllDifferent sameAs conflict',
    family: 'individual-identity',
    description: 'Find members of owl:AllDifferent that are also linked with owl:sameAs.',
    variables: ['set', 'a', 'b'],
    where: options => `
      ${scopedWhere(`
        ?set rdf:type owl:AllDifferent ;
             owl:distinctMembers/rdf:rest*/rdf:first ?a ;
             owl:distinctMembers/rdf:rest*/rdf:first ?b .
        ?a owl:sameAs ?b .
      `, options)}
      FILTER(?a != ?b)
    `,
  }),

  allDisjointPropertiesSharedPair: makeQueryDefinition({
    id: 'allDisjointPropertiesSharedPair',
    label: 'owl:AllDisjointProperties shared pair',
    family: 'property-disjointness',
    description: 'Find subject/object pairs connected by two members of an owl:AllDisjointProperties list.',
    variables: ['set', 'p1', 'p2', 's', 'o'],
    where: options => `
      ${scopedWhere(`
        ?set rdf:type owl:AllDisjointProperties ;
             owl:members/rdf:rest*/rdf:first ?p1 ;
             owl:members/rdf:rest*/rdf:first ?p2 .
        ?s ?p1 ?o .
        ?s ?p2 ?o .
      `, options)}
      FILTER(?p1 != ?p2)
    `,
  }),

  disjointUnionMissingMemberHeuristic: makeQueryDefinition({
    id: 'disjointUnionMissingMemberHeuristic',
    label: 'owl:disjointUnionOf missing member heuristic',
    family: 'class-disjointness',
    description: 'Heuristic: find instances of a disjoint union class lacking any known union member type.',
    variables: ['x', 'A', 'L'],
    where: options => `
      ${scopedWhere('?A owl:disjointUnionOf ?L .\n?x rdf:type ?A .', options)}
      FILTER NOT EXISTS {
        ${scopedWhere('?L rdf:rest*/rdf:first ?Bi .\n?x rdf:type ?Bi .', options)}
      }
    `,
  }),

  allValuesFromMissingTypeHeuristic: makeQueryDefinition({
    id: 'allValuesFromMissingTypeHeuristic',
    label: 'owl:allValuesFrom missing type heuristic',
    family: 'restriction-heuristic',
    description: 'Heuristic: find values of an allValuesFrom restriction with no known filler type.',
    variables: ['x', 'p', 'y', 'C', 'R'],
    where: options => `
      ${scopedWhere(`
        ?R rdf:type owl:Restriction ;
           owl:onProperty ?p ;
           owl:allValuesFrom ?C .
      `, options)}
      {
        ${scopedWhere('?A rdfs:subClassOf ?R .\n?x rdf:type ?A .', options)}
      }
      UNION
      {
        ${scopedWhere('?x rdf:type ?R .', options)}
      }
      ${scopedWhere('?x ?p ?y .', options)}
      FILTER NOT EXISTS {
        ${scopedWhere('?y rdf:type ?C .', options)}
      }
    `,
  }),

  singlePropertyHasKeyDifferentFromConflict: makeQueryDefinition({
    id: 'singlePropertyHasKeyDifferentFromConflict',
    label: 'Single-property owl:hasKey differentFrom conflict',
    family: 'key-identity',
    description: 'Find same-key individuals that are explicitly owl:differentFrom. Single-property keys only.',
    variables: ['A', 'x1', 'x2', 'k', 'v'],
    where: options => `
      ${scopedWhere('?A owl:hasKey ?keyList .\n?keyList rdf:first ?k .\n?keyList rdf:rest rdf:nil .', options)}
      ${scopedWhere('?x1 rdf:type ?A .\n?x2 rdf:type ?A .\n?x1 ?k ?v .\n?x2 ?k ?v .\n?x1 owl:differentFrom ?x2 .', options)}
      FILTER(?x1 != ?x2)
    `,
  }),
});

const HYDRATION_QUERIES = Object.freeze({
  namedClassInstances: {
    id: 'namedClassInstances',
    label: 'Hydrate named class instances',
    description: 'Create one synthetic instance for each named owl:Class.',
    construct: options => {
      const nodeExpr = hydrationNodeExpression('?A', options);
      const runExpr = hydrationRunExpression(options);
      return `
        CONSTRUCT {
          ?x rdf:type ?A ;
             hyd:hydratedFromClass ?A ;
             hyd:hydrationRun ?run .
        }
        WHERE {
          ${scopedWhere(`
            ?A rdf:type owl:Class .
            FILTER(isIRI(?A))
            FILTER(?A != owl:Thing && ?A != owl:Nothing)
          `, options)}
          BIND(${nodeExpr} AS ?x)
          BIND(${runExpr} AS ?run)
        }
      `;
    },
  },

  subclassAndExistentialWitnesses: {
    id: 'subclassAndExistentialWitnesses',
    label: 'Hydrate subclass and someValuesFrom witnesses',
    description: 'For each named class, create a synthetic instance, named superclass types, and shallow existential witnesses.',
    construct: options => {
      const nodeExpr = hydrationNodeExpression('?A', options);
      return `
        CONSTRUCT {
          ?x rdf:type ?A .
          ?x rdf:type ?Super .
          ?x ?p ?y .
          ?y rdf:type ?Filler .
          ?y rdf:type ?Part .
          ?y ?p2 ?z .
          ?z rdf:type ?Filler2 .
          ?x hyd:hydratedFromClass ?A .
          ?y hyd:hydrationRole hyd:ExistentialWitness ;
             hyd:witnessForRestriction ?R .
          ?z hyd:hydrationRole hyd:NestedExistentialWitness ;
             hyd:witnessForRestriction ?Part .
        }
        WHERE {
          ${scopedWhere(`
            ?A rdf:type owl:Class .
            FILTER(isIRI(?A))
            FILTER(?A != owl:Thing && ?A != owl:Nothing)
          `, options)}
          BIND(${nodeExpr} AS ?x)

          OPTIONAL {
            ${scopedWhere('?A rdfs:subClassOf ?Super .\nFILTER(isIRI(?Super))\nFILTER(?Super != owl:Thing && ?Super != owl:Nothing)', options)}
          }

          OPTIONAL {
            ${scopedWhere(`
              ?A rdfs:subClassOf ?R .
              ?R rdf:type owl:Restriction ;
                 owl:onProperty ?p ;
                 owl:someValuesFrom ?Filler .
            `, options)}
            BIND(IRI(CONCAT("${HYD}witness/", ENCODE_FOR_URI(STR(?A)), "/", ENCODE_FOR_URI(STR(?p)), "/", ENCODE_FOR_URI(STR(?Filler)))) AS ?y)

            OPTIONAL {
              FILTER(isIRI(?Filler))
            }

            OPTIONAL {
              ${scopedWhere('?Filler owl:intersectionOf/rdf:rest*/rdf:first ?Part .', options)}

              OPTIONAL {
                FILTER(isIRI(?Part))
              }

              OPTIONAL {
                ${scopedWhere(`
                  ?Part rdf:type owl:Restriction ;
                        owl:onProperty ?p2 ;
                        owl:someValuesFrom ?Filler2 .
                `, options)}
                BIND(IRI(CONCAT("${HYD}witness/", ENCODE_FOR_URI(STR(?A)), "/", ENCODE_FOR_URI(STR(?p)), "/", ENCODE_FOR_URI(STR(?Part)), "/", ENCODE_FOR_URI(STR(?p2)), "/", ENCODE_FOR_URI(STR(?Filler2)))) AS ?z)
              }
            }
          }
        }
      `;
    },
  },
});

const COVERAGE = Object.freeze([
  coverage('class-disjointness', 'OWL2 EL-ish', 'supported', 'Direct owl:disjointWith and owl:AllDisjointClasses overlaps are checked after available rdf:type materialization.'),
  coverage('class-complement', 'OWL2 DL construct, direct ABox check', 'supported', 'Detects explicit complement type overlap. It does not attempt full class expression satisfiability.'),
  coverage('property-disjointness', 'OWL2 EL-ish', 'supported', 'Detects shared subject/object pairs for owl:AllDisjointProperties.'),
  coverage('individual-identity', 'OWL2 DL construct, direct ABox check', 'supported', 'Detects owl:AllDifferent conflicts with explicit owl:sameAs. It does not compute complete equality closure by itself.'),
  coverage('property-cardinality', 'OWL2 DL construct, direct ABox check', 'partial', 'Detects literal functional conflicts and object functional conflicts when owl:differentFrom is explicit.'),
  coverage('negative-assertion', 'OWL2 DL construct, direct ABox check', 'supported', 'Detects explicitly asserted triples that contradict owl:NegativePropertyAssertion nodes.'),
  coverage('key-identity', 'OWL2 DL construct, direct ABox check', 'partial', 'Single-property owl:hasKey only. Multi-property keys need additional equality joins.'),
  coverage('restriction-heuristic', 'OWL2 DL construct, heuristic', 'partial', 'allValuesFrom missing-type checks are open-world heuristics, not proof of inconsistency.'),
  coverage('implicit-model-hydration', 'OWL2 EL-oriented heuristic', 'partial', 'Hydration creates synthetic witnesses for named classes, named superclasses, and shallow someValuesFrom/intersection patterns.'),
  coverage('full-owl-dl-satisfiability', 'OWL2 DL', 'unsupported', 'No complete tableau reasoning for constructs such as arbitrary allValuesFrom, cardinality, property chains, or complex negation.'),
]);

function makeQueryDefinition(input) {
  return Object.freeze({
    id: input.id,
    label: input.label,
    description: input.description,
    family: input.family,
    supported: input.supported !== false,
    select: options => `SELECT DISTINCT ${input.variables.map(name => `?${name}`).join(' ')} WHERE {\n${indent(input.where(options))}\n}`,
    ask: options => `ASK WHERE {\n${indent(input.where(options))}\n}`,
    construct: options => makeViolationConstruct(input, options),
  });
}

function makeViolationConstruct(input, options) {
  const bindings = input.variables
    .map(name => `?violation axi:binding_${name} ?${name} .`)
    .join('\n  ');

  return `
    CONSTRUCT {
      ?violation rdf:type axi:InconsistencyViolation ;
                 axi:violationKind "${input.id}" ;
                 rdfs:label "${escapeString(input.label)}" ;
                 axi:severity "error" .
      ${bindings}
    }
    WHERE {
      ${indent(input.where(options))}
      BIND(IRI(CONCAT("${AXI}violation/", "${input.id}", "/", STRUUID())) AS ?violation)
    }
  `;
}

function coverage(family, owlProfile, support, notes) {
  return { id: family, label: family, family, owlProfile, support, notes };
}

function hydrationNodeExpression(classVariable, options) {
  if (options.deterministicIris === false) return 'IRI(CONCAT("urn:uuid:", STRUUID()))';
  return `IRI(CONCAT("${HYD}node/", ENCODE_FOR_URI(STR(${classVariable}))))`;
}

function hydrationRunExpression(options) {
  if (options.runIri) return `<${escapeIri(options.runIri)}>`;
  return 'IRI(CONCAT("urn:uuid:", STRUUID()))';
}

async function collectBindings(bindingsStream) {
  return await new Promise((resolve, reject) => {
    const rows = [];
    bindingsStream.on('data', bindings => rows.push(bindingsToObject(bindings)));
    bindingsStream.on('end', () => resolve(rows));
    bindingsStream.on('error', reject);
  });
}

function hasSupportedSelectEngineApi(queryEngine) {
  return typeof queryEngine.queryBindings === 'function' ||
    (typeof queryEngine.query === 'function' && typeof queryEngine.resultToString === 'function');
}

function resolveComunicaEngine(engineCandidate) {
  if (engineCandidate) return engineCandidate;
  if (globalThis.engine) return globalThis.engine;

  if (browserComunicaEngine) return browserComunicaEngine;

  if (globalThis.Comunica && typeof globalThis.Comunica.QueryEngine === 'function') {
    browserComunicaEngine = new globalThis.Comunica.QueryEngine();
    return browserComunicaEngine;
  }

  return null;
}

async function runSelectWithComunica(queryEngine, query, rdfjsStore, options) {
  const queryOptions = {
    sources: [{ type: 'rdfjsSource', value: rdfjsStore }],
    baseIRI: options.baseIRI || 'http://example.org/',
  };

  if (typeof queryEngine.queryBindings === 'function') {
    const bindingsStream = await queryEngine.queryBindings(query, queryOptions);
    return await collectBindings(bindingsStream);
  }

  const result = await queryEngine.query(query, queryOptions);
  const asJson = await queryEngine.resultToString(result, 'application/sparql-results+json');
  const jsonText = await collectTextStream(asJson.data);
  const parsed = JSON.parse(jsonText || '{}');
  return parsed.results?.bindings || [];
}

async function collectTextStream(stream) {
  return await new Promise((resolve, reject) => {
    let text = '';
    stream.on('data', chunk => {
      text += String(chunk);
    });
    stream.on('end', () => resolve(text));
    stream.on('error', reject);
  });
}

function bindingsToObject(bindings) {
  if (bindings && typeof bindings.entries === 'function') {
    return Object.fromEntries(Array.from(bindings.entries()).map(([key, value]) => [String(key), value]));
  }

  if (bindings && typeof bindings.forEach === 'function') {
    const row = {};
    bindings.forEach((value, key) => {
      row[String(key).replace(/^\?/, '')] = value;
    });
    return row;
  }

  return {};
}

function compactSparql(query) {
  return query
    .split('\n')
    .map(line => line.replace(/\s+$/u, ''))
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim() + '\n';
}

function indent(text, spaces = 2) {
  const padding = ' '.repeat(spaces);
  return String(text)
    .trim()
    .split('\n')
    .map(line => `${padding}${line}`)
    .join('\n');
}

function escapeIri(value) {
  return String(value).replace(/[<>"{}|^`\\]/gu, encodeURIComponent);
}

function escapeString(value) {
  return String(value).replace(/\\/gu, '\\\\').replace(/"/gu, '\\"');
}

const api = Object.freeze({
  normalizeQueryOptions,
  scopedWhere,
  hasInconsistencyQuery,
  listInconsistencyQueries,
  getInconsistencyQuery,
  getAllInconsistencySelectQueries,
  runInconsistencySelect,
  runAllInconsistencySelects,
  constructInconsistencyReport,
  listInconsistencyCoverage,
  listHydrationQueries,
  getHydrationConstructQuery,
  applyHydrationConstruct,
});

if (typeof globalThis !== 'undefined') {
  globalThis.AxiolotlInconsistency = api;
}
