/**
 * @file constants.js
 * @description Shared constants and defaults.
 */
import {
  COMMON_NAMESPACE_IRIS,
  namespacePrefixMapFromRegistry
} from "../shared/namespace-registry/index.js";

export const debuggerConsoleLogEnabled = true;

const PREFIXES = namespacePrefixMapFromRegistry();

export const DEFAULT_QUERY = `PREFIX rdf: <${PREFIXES.rdf}>
PREFIX foaf: <http://xmlns.com/foaf/0.1/>
PREFIX skos: <${PREFIXES.skos}>

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
  COMMON_NAMESPACE_IRIS.rdfs.label,
  COMMON_NAMESPACE_IRIS.rdfs.comment,
  COMMON_NAMESPACE_IRIS.dcterms.title,
  "http://purl.org/dc/elements/1.1/title",
  COMMON_NAMESPACE_IRIS.skos.prefLabel,
  COMMON_NAMESPACE_IRIS.skos.altLabel,
  COMMON_NAMESPACE_IRIS.skos.definition
]);
