/**
 * @file core_graph.js
 * @description Build a reusable graph model (nodes/edges + highlights) from a SPARQL.js AST.
 */

import { KNOWN_ANNOTATION_PREDICATE_IRIS } from "./constants.js";
import { termKey, termLabel } from "./core_terms.js";

/**
 * @typedef {Object} GraphNode
 * @property {string} id
 * @property {string} label
 * @property {"variable"|"iri"|"blank"|"literal"} kind
 * @property {"class"|"individual"|"literal"|"variable"|"unknown"} category
 * @property {boolean=} isSelectedVar
 */

/**
 * @typedef {Object} GraphEdge
 * @property {string} id
 * @property {string} source
 * @property {string} target
 * @property {string} label
 * @property {"rdfType"|"objectProp"|"datatypeProp"|"annotationProp"|"path"} category
 * @property {"none"|"insert"|"delete"} effect
 */

/**
 * @typedef {Object} GraphModel
 * @property {string} queryType
 * @property {Record<string,string>} prefixes
 * @property {GraphNode[]} nodes
 * @property {GraphEdge[]} edges
 * @property {number} whereTripleCount
 */

/**
 * Extract variables returned by SELECT (MVP).
 * @param {any} ast
 * @returns {Set<string>} variable keys like "var:?x"
 */
export function extractReturnedVariableKeys(ast) {
  const out = new Set();
  if (!ast || ast.queryType !== "SELECT") return out;
  if (ast.variables === "*" || !Array.isArray(ast.variables)) return out;

  for (const v of ast.variables) {
    // SPARQL.js uses RDF/JS terms; variables are {termType:"Variable", value:"x"}
    if (v?.termType === "Variable") out.add(`var:?${v.value}`);
  }
  return out;
}

/**
 * Flatten WHERE patterns into an array of triple objects (MVP: BGP + OPTIONAL/UNION recursion).
 * @param {any[]} whereArr
 * @returns {any[]} triples with {subject,predicate,object}
 */
export function flattenWhereTriples(whereArr) {
  const triples = [];
  const patterns = Array.isArray(whereArr) ? whereArr : [];

  for (const p of patterns) {
    if (!p || typeof p !== "object") continue;

    if (p.type === "bgp" && Array.isArray(p.triples)) {
      triples.push(...p.triples);
      continue;
    }

    if (p.type === "optional" && Array.isArray(p.patterns)) {
      triples.push(...flattenWhereTriples(p.patterns));
      continue;
    }

    if (p.type === "union" && Array.isArray(p.patterns)) {
      for (const branch of p.patterns) {
        triples.push(...flattenWhereTriples(branch));
      }
      continue;
    }

    if (p.type === "group" && Array.isArray(p.patterns)) {
      triples.push(...flattenWhereTriples(p.patterns));
      continue;
    }

    if (p.type === "graph" && Array.isArray(p.patterns)) {
      triples.push(...flattenWhereTriples(p.patterns));
      continue;
    }
  }

  return triples;
}

/**
 * Infer node category based on rdf:type usage (MVP heuristic).
 * @param {Map<string, GraphNode>} nodesById
 * @param {GraphEdge[]} edges
 */
export function applyTypeHeuristics(nodesById, edges) {
  for (const e of edges) {
    if (e.category !== "rdfType") continue;
    const subj = nodesById.get(e.source);
    const obj = nodesById.get(e.target);
    if (obj && obj.kind === "iri") obj.category = "class";
    if (subj && (subj.kind === "iri" || subj.kind === "variable" || subj.kind === "blank")) {
      if (subj.category === "unknown") subj.category = "individual";
    }
  }
}

/**
 * Determine edge category from predicate/object term types and annotation predicate list.
 * @param {any} predicateTerm
 * @param {any} objectTerm
 * @returns {"rdfType"|"objectProp"|"datatypeProp"|"annotationProp"|"path"}
 */
export function classifyEdge(predicateTerm, objectTerm) {
  const predIri = predicateTerm?.termType === "NamedNode" ? predicateTerm.value : null;

  if (predIri === "http://www.w3.org/1999/02/22-rdf-syntax-ns#type") return "rdfType";

  // Property path objects in SPARQL.js are not NamedNode terms (MVP: treat separately)
  if (predicateTerm && predicateTerm.termType == null && typeof predicateTerm === "object") return "path";

  if (objectTerm?.termType === "Literal") {
    if (predIri && KNOWN_ANNOTATION_PREDICATE_IRIS.has(predIri)) return "annotationProp";
    return "datatypeProp";
  }
  return "objectProp";
}

/**
 * Build GraphModel from a SPARQL.js AST (MVP: WHERE + SELECT highlights).
 * @param {any} ast
 * @returns {GraphModel}
 */
export function buildGraphModel(ast) {
  const prefixes = ast?.prefixes || {};
  const queryType = ast?.queryType || ast?.type || "UNKNOWN";

  const returnedVarKeys = extractReturnedVariableKeys(ast);
  const whereTriples = flattenWhereTriples(ast?.where);

  const nodesById = new Map();
  /** @type {GraphEdge[]} */
  const edges = [];

  const ensureNode = (term) => {
    const id = termKey(term);
    if (nodesById.has(id)) return id;

    let kind = "iri";
    if (term?.termType === "Variable") kind = "variable";
    else if (term?.termType === "BlankNode") kind = "blank";
    else if (term?.termType === "Literal") kind = "literal";
    else if (term?.termType === "NamedNode") kind = "iri";

    const node = {
      id,
      label: termLabel(term, prefixes),
      kind,
      category: kind === "literal" ? "literal" : (kind === "variable" ? "variable" : "unknown"),
      isSelectedVar: returnedVarKeys.has(id)
    };

    nodesById.set(id, node);
    return id;
  };

  for (const t of whereTriples) {
    const s = ensureNode(t.subject);
    const o = ensureNode(t.object);

    const edgeCategory = classifyEdge(t.predicate, t.object);
    const predLabel =
      t.predicate?.termType === "NamedNode"
        ? termLabel(t.predicate, prefixes)
        : (edgeCategory === "path" ? "[path]" : "[predicate]");

    const edgeId = `e:${s}::${predLabel}::${o}::${edges.length}`;

    edges.push({
      id: edgeId,
      source: s,
      target: o,
      label: predLabel,
      category: edgeCategory,
      effect: "none"
    });
  }

  applyTypeHeuristics(nodesById, edges);

  return {
    queryType,
    prefixes,
    nodes: Array.from(nodesById.values()),
    edges,
    whereTripleCount: whereTriples.length
  };
}
