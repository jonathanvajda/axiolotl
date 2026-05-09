/**
 * @file core_terms.js
 * @description Pure helpers for RDF/JS term handling, CURIE compaction, labels, and keys.
 */

/**
 * @typedef {Object} RdfJsTerm
 * @property {string} termType
 * @property {string} value
 * @property {string=} language
 * @property {RdfJsTerm=} datatype
 */

/**
 * Create a stable key for a term for node IDs.
 * @param {RdfJsTerm} term
 * @returns {string}
 */
export function termKey(term) {
  if (!term || typeof term !== "object") return "term:unknown";
  if (term.termType === "Variable") return `var:?${term.value}`;
  if (term.termType === "BlankNode") return `bnode:${term.value}`;
  if (term.termType === "NamedNode") return `iri:${term.value}`;
  if (term.termType === "Literal") {
    const dt = term.datatype?.value ?? "";
    const lang = term.language ?? "";
    return `lit:${term.value}|${lang}|${dt}`;
  }
  return `term:${term.termType}:${term.value}`;
}

/**
 * Choose the best prefix mapping for a given IRI.
 * Prefers the *longest* namespace match to avoid overly-broad prefixes.
 * @param {string} iri
 * @param {Record<string,string>} prefixes
 * @returns {{prefix: string, namespace: string}|null}
 */
export function bestPrefixForIri(iri, prefixes) {
  const entries = Object.entries(prefixes || {});
  let best = null;

  for (const [pfx, ns] of entries) {
    if (typeof ns !== "string") continue;
    if (!iri.startsWith(ns)) continue;
    if (!best || ns.length > best.namespace.length) best = { prefix: pfx, namespace: ns };
  }
  return best;
}

/**
 * Compact an IRI to CURIE form if possible, otherwise return the IRI.
 * @param {string} iri
 * @param {Record<string,string>} prefixes
 * @returns {string}
 */
export function compactIri(iri, prefixes) {
  const best = bestPrefixForIri(iri, prefixes);
  if (!best) return iri;
  const local = iri.slice(best.namespace.length);
  const pfx = best.prefix === "" ? ":" : `${best.prefix}:`;
  return `${pfx}${local}`;
}

/**
 * Create a human-readable label for a term.
 * @param {RdfJsTerm} term
 * @param {Record<string,string>} prefixes
 * @returns {string}
 */
export function termLabel(term, prefixes) {
  if (!term || typeof term !== "object") return "<?>";

  if (term.termType === "Variable") return `?${term.value}`;
  if (term.termType === "BlankNode") return `_:${term.value}`;
  if (term.termType === "NamedNode") return compactIri(term.value, prefixes);

  if (term.termType === "Literal") {
    const lang = term.language ? `@${term.language}` : "";
    const dt = term.datatype?.value ? `^^${compactIri(term.datatype.value, prefixes)}` : "";
    return `"${term.value}"${lang}${dt}`;
  }

  return term.value ?? "<?>"; // fallback
}
