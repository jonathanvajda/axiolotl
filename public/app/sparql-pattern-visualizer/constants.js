/**
 * @file constants.js
 * @description Shared constants and defaults.
 */

export const debuggerConsoleLogEnabled = true;

export const DEFAULT_QUERY = `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
PREFIX foaf: <http://xmlns.com/foaf/0.1/>
PREFIX skos: <http://www.w3.org/2004/02/skos/core#>

SELECT ?p ?name WHERE {
  ?p a foaf:Person .
  ?p foaf:name ?name .
  OPTIONAL { ?p skos:definition ?def . }
  FILTER(isLiteral(?name))
}
`;

/**
 * Known “annotation-ish” predicates that commonly point to literals.
 * (MVP heuristic; can be made configurable.)
 */
export const KNOWN_ANNOTATION_PREDICATE_IRIS = new Set([
  "http://www.w3.org/2000/01/rdf-schema#label",
  "http://www.w3.org/2000/01/rdf-schema#comment",
  "http://purl.org/dc/terms/title",
  "http://purl.org/dc/elements/1.1/title",
  "http://www.w3.org/2004/02/skos/core#prefLabel",
  "http://www.w3.org/2004/02/skos/core#altLabel",
  "http://www.w3.org/2004/02/skos/core#definition"
]);
