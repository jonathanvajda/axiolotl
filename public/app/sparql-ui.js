/**
 * @file sparql-ui.js
 * @description Axiolotl DOM adapter for SPARQL Pattern Visualizer modules.
 */

import { logEvent, logError } from "./sparql-pattern-visualizer/log.js";
import { parseSparqlToAst } from "./sparql-pattern-visualizer/core_parse.js";
import { buildGraphModel } from "./sparql-pattern-visualizer/core_graph.js";

let hasRenderedDiagram = false;

function notify(message, type = "info") {
  if (typeof window.showToast === "function") {
    window.showToast(message, type);
    return;
  }

  const method = type === "error" ? "error" : "log";
  console[method](message);
}

function setDiagramVisible(isVisible) {
  const panel = document.getElementById("query-diagram");
  const toggleBtn = document.getElementById("svizToggleDiagramBtn");

  if (panel) panel.hidden = !isVisible;
  if (toggleBtn) {
    toggleBtn.hidden = !hasRenderedDiagram;
    toggleBtn.textContent = isVisible ? "Hide Diagram" : "Show Diagram";
    toggleBtn.setAttribute("aria-expanded", String(isVisible));
  }
}

function renderPrefixLegend(prefixes, isEnabled) {
  const el = document.getElementById("svizPrefixes");
  if (!el) return;

  el.innerHTML = "";
  if (!isEnabled) return;

  const entries = Object.entries(prefixes || {}).sort((a, b) => a[0].localeCompare(b[0]));
  if (entries.length === 0) {
    el.textContent = "No PREFIX declarations found.";
    return;
  }

  for (const [k, v] of entries) {
    const row = document.createElement("div");
    row.className = "sviz-prefix-item";

    const key = document.createElement("div");
    key.className = "sviz-prefix-key";
    key.textContent = k === "" ? ":" : `${k}:`;

    const val = document.createElement("div");
    val.className = "sviz-prefix-val";
    val.textContent = v;

    row.appendChild(key);
    row.appendChild(val);
    el.appendChild(row);
  }
}

function toCytoscapeElements(graphModel) {
  const nodes = (graphModel.nodes || []).map(n => ({ data: n }));
  const edges = (graphModel.edges || []).map(e => ({ data: e }));
  return [...nodes, ...edges];
}

function getCytoscapeStyles() {
  return [
    {
      selector: "node",
      style: {
        "label": "data(label)",
        "text-wrap": "wrap",
        "text-max-width": 140,
        "font-size": 10,
        "border-width": 1,
        "border-color": "#999",
        "background-color": "#eee",
        "shape": "ellipse"
      }
    },
    { selector: 'node[category = "class"]', style: { "background-color": "#ffeaa7", "shape": "ellipse" } },
    { selector: 'node[category = "individual"]', style: { "background-color": "#d6b3ff", "shape": "diamond" } },
    { selector: 'node[kind = "literal"]', style: { "background-color": "#dff9fb", "shape": "round-rectangle" } },
    { selector: 'node[kind = "variable"]', style: { "background-color": "#f1f2f6", "shape": "round-rectangle" } },
    { selector: 'node[isSelectedVar]', style: { "border-width": 4, "border-color": "#f1c40f" } },
    {
      selector: "edge",
      style: {
        "label": "data(label)",
        "font-size": 9,
        "text-rotation": "autorotate",
        "curve-style": "bezier",
        "target-arrow-shape": "triangle",
        "line-color": "#888",
        "target-arrow-color": "#888",
        "width": 2
      }
    },
    { selector: 'edge[category = "objectProp"]', style: { "line-color": "#3498db", "target-arrow-color": "#3498db" } },
    { selector: 'edge[category = "datatypeProp"]', style: { "line-color": "#2ecc71", "target-arrow-color": "#2ecc71" } },
    { selector: 'edge[category = "annotationProp"]', style: { "line-color": "#e67e22", "target-arrow-color": "#e67e22" } },
    { selector: 'edge[category = "rdfType"]', style: { "line-color": "#7f8c8d", "target-arrow-color": "#7f8c8d" } }
  ];
}

function renderDiagram(graphModel) {
  const container = document.getElementById("svizDiagram");
  if (!container) return;

  if (!window.cytoscape) {
    notify("Cytoscape not found. Did you load app/vendor/cytoscape.min.js?", "error");
    return;
  }

  hasRenderedDiagram = true;
  setDiagramVisible(true);
  container.innerHTML = "";

  const cy = window.cytoscape({
    container,
    elements: toCytoscapeElements(graphModel),
    style: getCytoscapeStyles(),
    layout: { name: "cose", animate: false },
    wheelSensitivity: 0.2
  });

  cy.fit(undefined, 24);
}

function updateMeta(graphModel) {
  const qt = document.getElementById("svizQueryType");
  const tc = document.getElementById("svizTripleCount");
  if (qt) qt.textContent = String(graphModel.queryType ?? "-");
  if (tc) tc.textContent = String(graphModel.whereTripleCount ?? 0);
}

function composeAxiolotlQuery() {
  const queryText = document.getElementById("sparql-query")?.value ?? "";
  const prefixes = typeof window.getActivePrefixes === "function" ? window.getActivePrefixes() : [];

  if (typeof window.buildQuery === "function") {
    return window.buildQuery(prefixes, queryText);
  }

  const prefixHeader = prefixes
    .map(pfx => window.commonSPARQLPrefixes?.[pfx])
    .filter(Boolean)
    .join("\n");

  return `${prefixHeader}\n${queryText}`;
}

function handleRenderRequest() {
  const showPrefixes = !!document.getElementById("svizShowPrefixes")?.checked;
  const attachFilters = !!document.getElementById("svizAttachFilters")?.checked;

  try {
    const queryText = composeAxiolotlQuery();
    logEvent("axiolotl.render.start", { showPrefixes, attachFilters });

    const ast = parseSparqlToAst(queryText);
    const graphModel = buildGraphModel(ast, { attachFilters });

    renderDiagram(graphModel);
    renderPrefixLegend(graphModel.prefixes, showPrefixes);
    updateMeta(graphModel);

    notify("Diagram updated.", "success");
    logEvent("axiolotl.render.success", {
      nodes: graphModel.nodes.length,
      edges: graphModel.edges.length
    });
  } catch (err) {
    logError("axiolotl.render.failed", err, {});
    notify(`Diagram render failed: ${err?.message ?? err}`, "error");
  }
}

function init() {
  document.getElementById("svizRenderBtn")
    ?.addEventListener("click", handleRenderRequest);

  document.getElementById("svizToggleDiagramBtn")
    ?.addEventListener("click", () => {
      const panel = document.getElementById("query-diagram");
      setDiagramVisible(!!panel?.hidden);
    });

  document.getElementById("run-query")
    ?.addEventListener("click", () => {
      if (hasRenderedDiagram) setDiagramVisible(false);
    }, { capture: true });

  setDiagramVisible(false);
}

if (typeof window !== "undefined") {
  window.addEventListener("DOMContentLoaded", init);
}
