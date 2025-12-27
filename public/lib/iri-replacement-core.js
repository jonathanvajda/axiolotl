/* eslint-disable no-useless-escape */
/**
 * Core IRI transformation utilities (pure, UI-agnostic).
 *
 * These functions intentionally **do not** import rdflib.js/comunica directly.
 * Instead, they accept an adapter: { parse(text,mime,baseIRI), serialize(graph,mime,baseIRI) }
 * so you can inject rdflib-based implementations at runtime or stubs in tests.
 *
 * They reuse your project’s helpers where available:
 * - normalizeIriString, isAbsoluteIri  (from comunica-indexeddb-bridge.js)
 * - detectRdfMimeByName, commonMIMEType (from semantic-core.js)
 *
 * If those aren’t in scope when testing, you can pass shims via options.
 *
 * Author: you + ChatGPT
 */

// Toggle debug logs globally (no UI toasts here)
export let debuggingConsoleEnabled = false;

/** Debug helper (side-effect: console only; safe for pure fns’ optional logging) */
const dbg = (fn, ...args) => {
  if (!debuggingConsoleEnabled) return;
  try {
    // preview large args without crashing on circulars
    const safe = (v) => {
      if (typeof v === 'string') return v.length > 400 ? v.slice(0, 400) + '…' : v;
      try { return JSON.stringify(v).slice(0, 400); } catch { return String(v); }
    };
    console.info(`[${fn}]`, ...args.map(safe));
  } catch {}
};

/** Lightweight event log accumulator for pure runs */
export const makeEventLog = () => {
  const entries = [];
  return {
    push: (level, msg, meta) => entries.push({ ts: Date.now(), level, msg, ...(meta ? { meta } : {}) }),
    entries: () => entries.slice(),
  };
};

// -----------------------------
// 1) Mapping CSV / TSV parsing
// -----------------------------

/**
 * Parse a CSV/TSV mapping file into Map<oldIRI, newIRI>.
 * Header must contain columns "old iri" and "new iri" (case-insensitive).
 * Angle brackets in cells are tolerated and stripped.
 *
 * @param {string} text - CSV/TSV text
 * @param {Object} [opt]
 * @param {string} [opt.delimiter] - ',' or '\t'. If omitted, auto-detect.
 * @param {(s:string)=>string} [opt.normalizeIriString] - optional override; defaults to a local normalizer
 * @returns {{map: Map<string,string>, warnings: string[]}}
 */
export const parseIriMappingCsv = (text, opt = {}) => {
  const log = [];
  const pushWarn = (m) => log.push(m);

  const autoDelim = /(?:^|\n)[^,\t"]+(?:,|\t)/.test(text) ? (text.includes('\t') ? '\t' : ',') : ',';
  const delimiter = opt.delimiter || autoDelim;

  // tolerant normalizer (falls back if your global helper isn’t available)
  const normalize =
    opt.normalizeIriString ||
    (globalThis.normalizeIriString
      ? globalThis.normalizeIriString
      : (s) => {
          if (typeof s !== 'string') return s;
          let t = s.trim();
          if (t.startsWith('<') && t.endsWith('>')) t = t.slice(1, -1).trim();
          return t;
        });

  const lines = String(text || '').split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length === 0) return { map: new Map(), warnings: ['Empty mapping file'] };

  const header = lines[0].split(delimiter).map(h => h.trim().toLowerCase());
  const oldIdx = header.indexOf('old iri');
  const newIdx = header.indexOf('new iri');
  if (oldIdx < 0 || newIdx < 0) {
    pushWarn('Header must contain "old iri" and "new iri" columns');
    return { map: new Map(), warnings: log };
  }

  const m = new Map();
  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim()) continue;
    const cols = raw.split(delimiter);
    const oldVal = normalize(cols[oldIdx] ?? '');
    const newVal = normalize(cols[newIdx] ?? '');
    if (!oldVal || !newVal) {
      pushWarn(`Row ${i + 1}: missing old/new IRI; skipped`);
      continue;
    }
    if (m.has(oldVal) && m.get(oldVal) !== newVal) {
      pushWarn(`Row ${i + 1}: conflicting mapping for <${oldVal}> (keeping first)`);
      continue;
    }
    m.set(oldVal, newVal);
  }

  return { map: m, warnings: log };
};

// ----------------------------------------
// 2) Input kind + R2RML TTL heuristics
// ----------------------------------------

/**
 * Classify input by name and (optionally) peek at text for R2RML signals.
 * Returns one of:
 *  - 'sparql'
 *  - 'rdf-triples' | 'rdf-quads'
 *  - 'r2rml-ttl' (subset of Turtle with rr:* terms)
 *  - 'unknown'
 *
 * @param {string} filename
 * @param {string} [peekText] - optional small slice of the content to sniff
 * @param {{ detectRdfMimeByName?: (name:string)=>string }} [opt]
 */
export const detectInputKind = (filename, peekText = '', opt = {}) => {
  const detectMime =
    opt.detectRdfMimeByName ||
    (globalThis.detectRdfMimeByName
      ? globalThis.detectRdfMimeByName
      : (name) => {
          const ext = String(name).toLowerCase().split('.').pop();
          switch (ext) {
            case 'ttl': return 'text/turtle';
            case 'nt': return 'application/n-triples';
            case 'nq': return 'application/n-quads';
            case 'trig': return 'application/trig';
            case 'rdf':
            case 'owl': return 'application/rdf+xml';
            case 'jsonld': return 'application/ld+json';
            case 'rq':
            case 'sparql': return 'application/sparql-query';
            default: return 'text/turtle';
          }
        });

  const mime = detectMime(filename);
  if (mime === 'application/sparql-query') return 'sparql';

  // Determine triples vs quads from MIME
  if (mime === 'application/n-quads' || mime === 'application/trig') {
    return 'rdf-quads';
  }
  if (mime === 'application/n-triples' || mime === 'text/turtle' || mime === 'application/rdf+xml' || mime === 'application/ld+json') {
    // Further check for R2RML TTL
    if (mime === 'text/turtle' && isLikelyR2RML(peekText)) return 'r2rml-ttl';
    return 'rdf-triples';
  }
  return 'unknown';
};

/**
 * Heuristic: does a Turtle blob look like R2RML (rr:TriplesMap, rr:template, etc.)?
 * This is conservative and purely textual.
 *
 * @param {string} turtle
 */
export const isLikelyR2RML = (turtle) => {
  const s = String(turtle || '');
  // common rr: terms + typical prefixes in real R2RML files
  return /\brr\s*:\s*(TriplesMap|subjectMap|predicateObjectMap|objectMap|template)\b/.test(s) ||
         /<http:\/\/www\.w3\.org\/ns\/r2rml#(TriplesMap|subjectMap|predicateObjectMap|objectMap|template)>/.test(s);
};

// -----------------------------------------------------
// 3) Adapter-driven RDF parse/serialize (triples/quads)
// -----------------------------------------------------

/**
 * Convert triples-based RDF (TTL/RDFXML/JSON-LD/NT) → N-Triples (string).
 * Pure wrt app state; depends on provided adapter.
 *
 * @param {string} text
 * @param {string} inputMime
 * @param {{ parse:(text:string,mime:string,baseIRI:string)=>Promise<any>, serialize:(graph:any,mime:string,baseIRI:string)=>string }} adapter
 * @param {string} [baseIRI='http://example.org/']
 */
export const toNTriples = async (text, inputMime, adapter, baseIRI='http://example.org/') => {
  dbg('toNTriples', { inputMime, size: text?.length });
  const g = await adapter.parse(text, inputMime, baseIRI);
  return adapter.serialize(g, 'application/n-triples', baseIRI);
};

/**
 * Convert quads-based RDF (TriG/N-Quads/JSON-LD w/ graphs) → N-Quads (string).
 * Note: JSON-LD may or may not include named graphs depending on input.
 *
 * @param {string} text
 * @param {string} inputMime
 * @param {{ parse:(text:string,mime:string,baseIRI:string)=>Promise<any>, serialize:(graph:any,mime:string,baseIRI:string)=>string }} adapter
 * @param {string} [baseIRI='http://example.org/']
 */
export const toNQuads = async (text, inputMime, adapter, baseIRI='http://example.org/') => {
  dbg('toNQuads', { inputMime, size: text?.length });
  const g = await adapter.parse(text, inputMime, baseIRI);
  return adapter.serialize(g, 'application/n-quads', baseIRI);
};

// -----------------------------------------------------
// 4) IRI replacement primitives (angles & literals)
// -----------------------------------------------------

// Matches angle-bracket IRIs: <scheme:...> (greedy until '>')
const ANGLE_IRI_RE = /<([^>\s]+)>/g;

// Very tolerant literal match for "…", '…' (handles escaped quotes); non-global on purpose in parser
const LITERAL_RE = /("([^"\\]|\\.)*"|'([^'\\]|\\.)*')/g;

/**
 * Replace IRIs that appear as angle-bracket IRIs, e.g., <http://old>.
 * Does **not** touch literals. Fully streaming-safe (string in/out).
 *
 * @param {string} text
 * @param {Map<string,string>} iriMap - keys/values are **normalized** absolute IRIs
 */
export const replaceAngleIris = (text, iriMap) => {
  if (!text || iriMap.size === 0) return text;
  return text.replace(ANGLE_IRI_RE, (m, iri) => {
    const n = iriMap.get(iri);
    return n ? `<${n}>` : m;
  });
};

/**
 * Replace IRI substrings that appear **inside string literals** only.
 * (for rr:template strings, annotations, SPARQL strings, etc.)
 * Keeps delimiters and escapes intact.
 *
 * @param {string} text
 * @param {Map<string,string>} iriMap
 */
export const replaceIrisInsideLiterals = (text, iriMap) => {
  if (!text || iriMap.size === 0) return text;

  // Walk the string, swapping only inside matched literal spans
  let out = '';
  let lastIndex = 0;
  let m;
  while ((m = LITERAL_RE.exec(text)) !== null) {
    const [full, /*cap*/] = m;
    const start = m.index;
    const end = start + full.length;

    // copy non-literal gap unchanged
    out += text.slice(lastIndex, start);

    // process the literal body only (without quotes)
    const quote = full[0];
    const body = full.slice(1, -1); // raw with escapes

    let replaced = body;
    // naive but effective: try all mappings as literal substring replacements
    iriMap.forEach((newIri, oldIri) => {
      if (oldIri && newIri && replaced.includes(oldIri)) {
        replaced = replaced.split(oldIri).join(newIri);
      }
    });

    out += quote + replaced + quote;
    lastIndex = end;
  }

  // tail
  out += text.slice(lastIndex);
  return out;
};

/**
 * High-level textual replacement policy for RDF syntax families:
 * - First pass: replace <IRI> tokens everywhere.
 * - Optional second pass (enabled via opt): replace old IRI substrings *inside literals*.
 *
 * @param {string} text
 * @param {Map<string,string>} iriMap
 * @param {{ insideLiterals?: boolean }} [opt]
 */
export const replaceIrisTextual = (text, iriMap, opt = {}) => {
  const withAngles = replaceAngleIris(text, iriMap);
  if (!opt.insideLiterals) return withAngles;
  return replaceIrisInsideLiterals(withAngles, iriMap);
};

// -----------------------------------------------------
// 5) File-level transforms (RDF & SPARQL)
// -----------------------------------------------------

/**
 * Transform a single **RDF** file’s text:
 * 1) normalize to N-Triples or N-Quads (based on kind)
 * 2) apply IRI replacements (angles-only, then optional in-literals)
 * 3) re-serialize to requested MIME (or original family)
 *
 * @param {{ name:string, text:string }} input
 * @param {{
 *    mapping: Map<string,string>,
 *    adapter: { parse:Function, serialize:Function },
 *    baseIRI?: string,
 *    detectRdfMimeByName?: (n:string)=>string,
 *    targetMime?: string,       // if omitted, keeps same family (triples/quads)
 *    replaceInsideLiterals?: boolean
 * }} opts
 * @returns {{ updatedText:string, suggestedName:string, logs:Array }}
 */
export const transformRdfFile = async (input, opts) => {
  const logs = makeEventLog();
  const { name, text } = input || {};
  if (!name || !text) throw new Error('transformRdfFile: missing name or text');

  const detectMime = opts.detectRdfMimeByName || globalThis.detectRdfMimeByName;
  if (!detectMime) throw new Error('transformRdfFile: detectRdfMimeByName not provided');

  const mimeIn = detectMime(name);
  const kind = (mimeIn === 'application/n-quads' || mimeIn === 'application/trig') ? 'rdf-quads' : 'rdf-triples';
  const baseIRI = opts.baseIRI || 'http://example.org/';
  const { mapping, adapter } = opts;
  if (!mapping || !(mapping instanceof Map)) throw new Error('transformRdfFile: mapping must be a Map');
  if (!adapter || typeof adapter.parse !== 'function' || typeof adapter.serialize !== 'function') {
    throw new Error('transformRdfFile: adapter.parse/serialize required');
  }

  logs.push('info', `Detected ${kind} (${mimeIn}) for ${name}`);
  // 1) normalize
  let canonical;
  if (kind === 'rdf-quads') {
    canonical = await toNQuads(text, mimeIn, adapter, baseIRI);
  } else {
    canonical = await toNTriples(text, mimeIn, adapter, baseIRI);
  }
  logs.push('info', `Normalized to ${kind === 'rdf-quads' ? 'N-Quads' : 'N-Triples'}`, { bytes: canonical.length });

  // 2) replace
  const replaced = replaceIrisTextual(canonical, mapping, { insideLiterals: !!opts.replaceInsideLiterals });
  const replacementsMade = (canonical !== replaced);
  logs.push('info', `Applied mapping`, { changed: replacementsMade });

  // 3) re-serialize to target (or keep canonical)
  const targetMime = opts.targetMime || (kind === 'rdf-quads' ? 'application/n-quads' : 'application/n-triples');
  let updatedText;

  if (targetMime === 'application/n-triples' || targetMime === 'application/n-quads') {
    // already in that line format
    updatedText = replaced;
  } else {
    // parse replaced canonical -> serialize into target
    const parsed = await adapter.parse(replaced, kind === 'rdf-quads' ? 'application/n-quads' : 'application/n-triples', baseIRI);
    updatedText = adapter.serialize(parsed, targetMime, baseIRI);
  }

  // compute suggested filename
  const dot = name.lastIndexOf('.');
  const stem = dot >= 0 ? name.slice(0, dot) : name;
  const ext = dot >= 0 ? name.slice(dot + 1) : '';
  const suggestedName = `${stem}_updated.${ext || 'ttl'}`;

  return { updatedText, suggestedName, logs: logs.entries() };
};

/**
 * Transform a single **SPARQL** file’s text:
 * Policy: replace angle-bracket IRIs + (optionally) in-literal substrings,
 * preserving PREFIX declarations and variables verbatim.
 *
 * @param {{ name:string, text:string }} input
 * @param {{ mapping: Map<string,string>, replaceInsideLiterals?: boolean }} opts
 * @returns {{ updatedText:string, suggestedName:string, logs:Array }}
 */
export const transformSparqlFile = (input, opts) => {
  const logs = makeEventLog();
  const { name, text } = input || {};
  if (!name || !text) throw new Error('transformSparqlFile: missing name or text');
  const { mapping } = opts || {};
  if (!mapping || !(mapping instanceof Map)) throw new Error('transformSparqlFile: mapping must be a Map');

  // Reuse textual replacement policy
  const afterAngles = replaceAngleIris(text, mapping);
  const updatedText = opts?.replaceInsideLiterals ? replaceIrisInsideLiterals(afterAngles, mapping) : afterAngles;

  const suggestedName = name.replace(/(\.rq|\.sparql)?$/i, '') + '_updated.sparql';
  logs.push('info', 'Transformed SPARQL text', { changed: text !== updatedText });

  return { updatedText, suggestedName, logs: logs.entries() };
};

// -----------------------------------------------------
// 6) Batch orchestration
// -----------------------------------------------------

/**
 * Batch transform mixed inputs (RDF, SPARQL, TTL including R2RML).
 * Returns per-file results with status and logs. No side-effects.
 *
 * @param {Array<{name:string,text:string}>} files
 * @param {{
 *   mappingCsvText: string,
 *   adapter: { parse:Function, serialize:Function },
 *   baseIRI?: string,
 *   replaceInsideLiterals?: boolean,
 *   targetMimeByExt?: (ext:string, kind:'rdf-triples'|'rdf-quads'|'sparql'|'r2rml-ttl'|'unknown') => string | undefined,
 *   detectRdfMimeByName?: (n:string)=>string,
 *   normalizeIriString?: (s:string)=>string
 * }} opts
 * @returns {Promise<Array<{name:string, status:'ok'|'failed', suggestedName?:string, updatedText?:string, error?:string, logs:Array}>>}
 */
export const batchTransform = async (files, opts) => {
  const { map: mapping, warnings } = parseIriMappingCsv(opts.mappingCsvText, {
    normalizeIriString: opts.normalizeIriString || globalThis.normalizeIriString,
  });

  const results = [];
  for (const f of files) {
    try {
      const kind = detectInputKind(f.name, f.text.slice(0, 4000), { detectRdfMimeByName: opts.detectRdfMimeByName || globalThis.detectRdfMimeByName });
      if (kind === 'sparql') {
        const r = transformSparqlFile(f, { mapping, replaceInsideLiterals: !!opts.replaceInsideLiterals });
        results.push({ name: f.name, status: 'ok', ...r, logs: [...warnings.map(w => ({level:'warn', msg:w})), ...r.logs] });
        continue;
      }

      // Choose target MIME if provided by policy function
      const ext = f.name.toLowerCase().split('.').pop() || '';
      const targetMime = opts.targetMimeByExt ? opts.targetMimeByExt(ext, kind) : undefined;

      const r = await transformRdfFile(
        f,
        {
          mapping,
          adapter: opts.adapter,
          baseIRI: opts.baseIRI,
          replaceInsideLiterals: !!opts.replaceInsideLiterals || kind === 'r2rml-ttl', // R2RML benefits from in-literal swaps
          detectRdfMimeByName: opts.detectRdfMimeByName || globalThis.detectRdfMimeByName,
          targetMime,
        }
      );
      results.push({ name: f.name, status: 'ok', ...r, logs: [...warnings.map(w => ({level:'warn', msg:w})), ...r.logs] });
    } catch (e) {
      results.push({ name: f?.name || '(unknown)', status: 'failed', error: e?.message || String(e), logs: [{ level:'error', msg:String(e)}] });
    }
  }
  return results;
};
