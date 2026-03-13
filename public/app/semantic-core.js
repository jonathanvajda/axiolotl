// Dependencies
  // comunica-indexeddb-bridge.js
    //  parseIntoNamedGraph,
    //  loadGraphFromIndexedDB,
    //  stashGraphToIndexedDB
    //  detectRdfMimeByName      (good candidate for moving to semantic-core.js)

// List of functions in this file:
  // debuggingConsoleEnabled
  // showToast
  // toastFromQueryError 
  // toastInfo
  // toastSuccess
  // toastError
  // commonSPARQLPrefixes
  // defaultActivePrefixes
  // readFileAsText
  // commonMIMEType

  // getSelectedOutputMime
  // downloadText


debuggingConsoleEnabled = true; // set to false to disable debug logs

/**
 * Safely logs a variable to the console, limiting the output size for large data.
 * @param {string} functionName - The name of the function being debugged.
 * @param {*} argument - The argument passed to the function.
 * @param {number} [maxLength=500] - The maximum number of characters to preview.
 */
function safeConsoleLog(functionName, argument, maxLength = 500) {
    if (typeof argument === 'string') {
        // Handle large strings
        const preview = argument.length > maxLength
            ? argument.substring(0, maxLength) + '...'
            : argument;
        console.info(`[${functionName}] Argument: "${preview}" (Type: string, Length: ${argument.length})`);
    } else if (typeof argument === 'object' && argument !== null) {
        // Handle objects (including arrays)
        try {
            const str = JSON.stringify(argument, null, 2); // Stringify with 2-space indentation
            const preview = str.length > maxLength
                ? str.substring(0, maxLength) + '...'
                : str;
            console.info(`[${functionName}] Argument Preview: ${preview} (Type: ${Array.isArray(argument) ? 'array' : 'object'})`);
        } catch (e) {
            // Fallback for circular references or complex objects that can't be stringified
            console.info(`[${functionName}] Argument:`, argument, `(Cannot stringify - logging directly)`);
        }
    } else {
        // Handle primitives (number, boolean, undefined, null, function, symbol)
        console.info(`[${functionName}] Argument:`, argument, `(Type: ${typeof argument})`);
    }
}

/** @param {string} name @param {any[]} args */
function __logStart(name, args = []) {
  if (!debuggingConsoleEnabled) return;
  try {
    // Use your safeConsoleLog for each argument preview
    if (typeof safeConsoleLog === 'function') {
      if (args.length === 0) safeConsoleLog(name, '[no-args]');
      else args.forEach(a => safeConsoleLog(name, a, 500));
    } else {
      console.info(`[${name}] start`, ...args);
    }
  } catch {}
}

/** @param {string} name @param {any} summary */
function __logSuccess(name, summary) {
  if (!debuggingConsoleEnabled) return;
  try {
    if (typeof safeConsoleLog === 'function') {
      safeConsoleLog(`${name} ok`, summary, 500);
    } else {
      console.info(`[${name}] ok`, summary);
    }
  } catch {}
}

/** @param {string} name @param {any} err */
function __logError(name, err) {
  try {
    // Surface to your UI log as well
    transformationLogWarn?.(`${name} failed: ${err?.message || err}`);
  } catch {}
  if (!debuggingConsoleEnabled) return;
  try {
    if (typeof safeConsoleLog === 'function') {
      safeConsoleLog(`${name} error`, (err?.stack || err?.message || err), 800);
    } else {
      console.error(`[${name}] error`, err);
    }
  } catch {}
}

/**
 * Wrap any function to auto-log start/success/error.
 * Works for sync and async functions (Promises).
 * @template {(...a:any[])=>any} F
 * @param {string} name
 * @param {F} fn
 * @returns {F}
 */
function withDebug(name, fn) {
  return /** @type {F} */ (function (...args) {
    __logStart(name, args);
    try {
      const out = fn.apply(this, args);
      if (out && typeof out.then === 'function') {
        return out.then(
          (val) => { __logSuccess(name, '[async resolved]'); return val; },
          (e)    => { __logError(name, e); throw e; }
        );
      }
      __logSuccess(name, '[sync returned]');
      return out;
    } catch (e) {
      __logError(name, e);
      throw e;
    }
  });
}

// Simple toast notification system
function showToast(message, type = 'info', { timeout = 3500 } = {}) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.setAttribute('aria-live', 'polite');
    container.setAttribute('aria-atomic', 'true');
    document.body.appendChild(container);
  }

  // Optional: cap the queue to avoid a flood
  const MAX_TOASTS = 8;
  while (container.children.length >= MAX_TOASTS) {
    container.firstElementChild?.remove();
  }

  const div = document.createElement('div');
  div.className = `toast toast--${type}`;
  div.setAttribute('role', type === 'error' ? 'alert' : 'status'); // a11y
  div.tabIndex = 0; // focusable for screenreaders / keyboard

  const icon = type === 'success' ? '✓' : type === 'error' ? '✕' : 'ℹ︎';
  // Build nodes safely (avoid injecting HTML from message)
  const iconSpan = document.createElement('span');
  iconSpan.className = 'toast__icon';
  iconSpan.textContent = icon;

  const msgDiv = document.createElement('div');
  msgDiv.textContent = message;

  div.appendChild(iconSpan);
  div.appendChild(msgDiv);
  container.appendChild(div);

  let hideTimer = null;
  const startHide = () => {
    hideTimer = setTimeout(() => {
      div.classList.add('hide');
      setTimeout(() => div.remove(), 250);
    }, timeout);
  };
  const stopHide = () => { if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; } };

  // auto-dismiss, but pause on hover/focus
  startHide();
  div.addEventListener('mouseenter', stopHide);
  div.addEventListener('mouseleave', startHide);
  div.addEventListener('focusin',   stopHide);
  div.addEventListener('focusout',  startHide);
  div.addEventListener('click',     () => { stopHide(); div.classList.add('hide'); setTimeout(() => div.remove(), 200); });
}

// Show user-friendly toast from a query error object/message
function toastFromQueryError(err) {
  const msg = (err && (err.userMessage || err.message || String(err))) || 'Unknown error';

  // Normalize common issues
  if (/Unknown prefix/i.test(msg)) {
    return showToast('Query failed: an unknown PREFIX was used.', 'error');
  }
  if (/Parse error on line (\d+)/i.test(msg)) {
    const line = msg.match(/Parse error on line (\d+)/i)[1];
    return showToast(`Query parse error (line ${line}). Check syntax near that line.`, 'error');
  }
  if (/Cannot resolve relative IRI.*no base IRI/i.test(msg)) {
    return showToast('Query failed: relative IRI used but no BASE IRI was set.', 'error');
  }
  // Comunica “serialize/mediator” style
  if (/mediated over all rejecting actors/i.test(msg)) {
    return showToast('Query failed: unsupported result format in this build.', 'error');
  }

  // Default
  return showToast(`Query failed: ${msg}`, 'error');
}

// Convenience wrappers for different toast types
const toastInfo    = (m, t=3500) => showToast(m, 'info',    { timeout: t });
const toastSuccess = (m, t=3500) => showToast(m, 'success', { timeout: t });
const toastError   = (m, t=4500) => showToast(m, 'error',   { timeout: t });


/** 
 * Defines common prefixes in SPARQL
 */
  const commonSPARQLPrefixes = {
    "rdf": "PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>",
    "rdfs": "PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>",
    "owl": "PREFIX owl: <http://www.w3.org/2002/07/owl#>",
    "xsd": "PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>",
    "skos": "PREFIX skos: <http://www.w3.org/2004/02/skos/core#>",
    "dc": "PREFIX dc: <http://purl.org/dc/elements/1.1/>",
    "dcterms": "PREFIX dcterms: <http://purl.org/dc/terms/>",
    "obo": "PREFIX obo: <http://purl.obolibrary.org/obo/>",
    "cco2": "PREFIX cco2: <https://www.commoncoreontologies.org/>",
    "cceo": "PREFIX cceo: <http://www.ontologyrepository.com/CommonCoreOntologies/>",
    "geo": "PREFIX geo: <http://www.w3.org/2003/01/geo/wgs84_pos#>",
    "geojson": "PREFIX geojson: <https://purl.org/geojson/vocab#>",
    "foaf": "PREFIX foaf: <http://xmlns.com/foaf/0.1/>",
    "prov": "PREFIX prov: <http://www.w3.org/ns/prov#>",
    "dcat": "PREFIX dcat: <http://www.w3.org/ns/dcat#>",
    "vcard": "PREFIX vcard: <http://www.w3.org/2006/vcard/ns#>",
    "wd": "PREFIX wd: <http://www.wikidata.org/entity/>",
    "bd": "PREFIX bd: <http://www.bigdata.com/rdf#>"
  }

/**
 * Read a File as text.
 * Pure w.r.t. app state; side-effect is FileReader I/O only.
 * @param {File} file
 * @returns {Promise<string>}
 */
function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsText(file);
  });
}

/**
 * Reads file content and loads it into IndexedDB under its own graph name.
 * @param {File} file
 */
async function handleFileUpload(file) {
  if (!file) {
    if (debuggingConsoleEnabled) {console.warn('[handleFileUpload] No file provided.');}
    return;
  }
  const store = $rdf.graph();

  try {
    const content = await readFileAsText(file);
    const mimeType = detectRdfMimeByName(file.name);
    const graphIRI = `urn:upload:${encodeURIComponent(file.name)}`;

    await parseIntoNamedGraph(content, store, graphIRI, mimeType);

    if (debuggingConsoleEnabled) {console.info(`[handleFileUpload] Parsed ${file.name} as ${mimeType}`);}
  } catch (error) {
    if (debuggingConsoleEnabled) {console.error('[handleFileUpload] Failed:', error);}
  }
}

// Drop-down id="output-format" has values: Turtle, n-Triples, JSON-LD, RDF/XML
const commonMIMEType = {
  'Turtle':    'text/turtle',
  'n-Triples': 'application/n-triples',
  'JSON-LD':   'application/ld+json',
  'RDF/XML':   'application/rdf+xml',
  'N-Quads':   'application/n-quads',
  'TriG':      'application/trig',
  'SPARQL Results JSON': 'application/sparql-results+json',
  'SPARQL Results XML':  'application/sparql-results+xml',
  'SPARQL Update':      'application/sparql-update',
  'SPARQL Query':       'application/sparql-query',
};

// Utility to get selected output MIME type from dropdown
function getSelectedOutputMime() {
  const sel = document.getElementById('output-format');
  const label = sel?.value || 'Turtle';
  return commonMIMEType[label] || 'text/turtle';
}

/**
 * Download text as a file (e.g. Turtle or N-Triples).
 * @param {string} filename
 * @param {string} text
 * @param {string} mime
 * @returns {string}
 */
function downloadText(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}