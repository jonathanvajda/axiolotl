/**
 * @file core_parse.js
 * @description Parse SPARQL text into SPARQL.js AST.
 */

import { logError } from "./log.js";

/**
 * Parse SPARQL query text into a SPARQL.js AST.
 * Requires a browser-bundled `window.sparqljs`.
 * @param {string} queryText
 * @returns {any} SPARQL.js AST
 * @throws {Error}
 */
export function parseSparqlToAst(queryText) {
  try {
    if (!window.sparqljs?.Parser) {
      throw new Error("sparqljs Parser not found on window. Did you load vendor/sparqljs.umd.js?");
    }
    const parser = new window.sparqljs.Parser({ skipValidation: false });
    return parser.parse(String(queryText ?? ""));
  } catch (err) {
    logError("parseSparqlToAst.failed", err, { queryText });
    throw err;
  }
}
