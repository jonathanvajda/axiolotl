import { formatConsistencyReport, summarizeConsistencyResults } from './consistency-report.js';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { runInconsistencySelect } from './axiolotl-inconsistency.js';

const context = {
  console, AbortController, AbortSignal: globalThis.AbortSignal,
  setTimeout, clearTimeout, setImmediate, clearImmediate: globalThis.clearImmediate, queueMicrotask,
  TextEncoder, TextDecoder, URL, URLSearchParams,
  fetch: globalThis.fetch, Headers: globalThis.Headers,
  Request: globalThis.Request, Response: globalThis.Response,
};
context.self = context;
context.window = context;
context.global = context;
for (const file of ['n3.min.js', 'comunica-browser.js']) {
  runInNewContext(readFileSync(new URL('./shared/vendor/' + file, import.meta.url), 'utf8'), context);
}
const engine = new context.Comunica.QueryEngine();
const id = 'objectFunctionalPropertyDifferentFromConflict';
const folder = '../test-fixtures/consistency/' + id + '/';

test.each([
  ['positive', true], ['control', false],
  ['reverse-inequality', true], ['all-different', true],
  ['aliased-inequality', true], ['aliased-all-different', true],
  ['all-different-control', false], ['same-as-control', false],
])('functional object fixture %s returns expected contradiction evidence', async (file, expected) => {
  const ttl = readFileSync(new URL(folder + file + '.ttl', import.meta.url), 'utf8');
  const store = new context.N3.Store(new context.N3.Parser().parse(ttl));
  const result = await runInconsistencySelect(id, store, { engine, scope: 'default' });
  expect(result.rows.length > 0).toBe(expected);
  for (const row of result.rows) {
    expect(row.x.value).toBe('https://example.org/consistency-fixture/x');
    expect(row.p.value).toBe('https://example.org/consistency-fixture/p');
    expect(new Set([row.y1.value, row.y2.value])).toEqual(new Set([
      'https://example.org/consistency-fixture/a', 'https://example.org/consistency-fixture/b',
    ]));
  }
});


test('warning evidence stays separate from contradiction verdicts', async () => {
  const id = 'allValuesFromMissingTypeHeuristic';
  const ttl = readFileSync(new URL('../test-fixtures/consistency/' + id + '/positive.ttl', import.meta.url), 'utf8');
  const store = new context.N3.Store(new context.N3.Parser().parse(ttl));
  const warning = await runInconsistencySelect(id, store, { engine, scope: 'default', phase: 'asserted' });
  expect(warning.findingKind).toBe('warning');
  expect(warning.findings.length).toBeGreaterThan(0);
  expect(warning.findings[0].evidence.length).toBeGreaterThan(0);
  const summary = summarizeConsistencyResults([warning]);
  expect(summary.violations).toBe(0);
  expect(summary.warnings).toBeGreaterThan(0);
  expect(summary.verdict).toContain('No contradictions detected');
  const report = formatConsistencyReport([warning]);
  expect(report).toContain('Warning rows:');
  expect(report).toContain('Violation rows: 0');
  expect(report).toContain('?y = <https://example.org/consistency-fixture/y>');
  expect(report).toContain('allValuesFrom');
  expect(report).toContain(warning.query);
  expect(report).not.toContain('[object Object]');
});

test('violation evidence distinguishes materialized quads and preserves graph identity', async () => {
  const ttl = readFileSync(new URL(folder + 'positive.ttl', import.meta.url), 'utf8');
  const store = new context.N3.Store(new context.N3.Parser().parse(ttl));
  const overlay = new context.N3.Store(store.getQuads(null, context.N3.DataFactory.namedNode('http://www.w3.org/2002/07/owl#differentFrom'), null, null));
  const violation = await runInconsistencySelect(id, store, { engine, scope: 'default', phase: 'after-materialization', materializedStore: overlay });
  expect(violation.findingKind).toBe('violation');
  expect(violation.findings[0].evidence.some(e => e.origin === 'materialized')).toBe(true);
  expect(violation.findings[0].evidence.some(e => e.origin === 'asserted')).toBe(true);
  const report = formatConsistencyReport([violation]);
  expect(report).toContain('Contradictions detected');
  expect(report).toContain('[materialized; default graph]');
  expect(report).toContain('?y1 =');
  expect(report).toContain('differentFrom');
  const incomplete = { ...violation, rows: [], findings: [], status: 'incomplete', notices: ['Unsupported comparison'] };
  expect(summarizeConsistencyResults([incomplete]).verdict).toContain('check incomplete');
});
