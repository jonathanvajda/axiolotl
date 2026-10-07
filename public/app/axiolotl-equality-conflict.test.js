import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { runInconsistencySelect } from './axiolotl-inconsistency.js';
import { formatConsistencyReport } from './consistency-report.js';
import { jest } from '@jest/globals';

const context = {
  crypto: webcrypto,
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


let dataset;
jest.unstable_mockModule('./comunica-indexeddb-bridge.js', () => ({
  loadGraphFromIndexedDB: async () => new context.N3.Store([...dataset]), stashGraphToIndexedDB: jest.fn(),
}));
jest.unstable_mockModule('./semantic-core.js', () => ({ debuggingConsoleEnabled: false }));
globalThis.N3 = context.N3;
globalThis.Comunica = context.Comunica;
globalThis.document = { getElementById: () => null };
const { inferUntilStable } = await import('./axiolotl-inference.js');

const fixtures = [["positive", [], true, true], ["reverse-different-from", [], true, true], ["reverse-same-as", [], true, true], ["aliased-inequality", [], true, true], ["all-different", [], true, true], ["aliased-all-different", [], true, true], ["control", [], false, false], ["equality-control", [], false, false], ["unrelated-all-different-control", [], false, false], ["self-inequality", [], true, true], ["after-materialization", ["functional", "sameas"], false, true], ["after-inverse-functional", ["inversefunctional", "sameas"], false, true], ["all-different-after-materialization", ["functional", "sameas"], false, true]];
test.each(fixtures)('equality conflict %s has expected findings before/after inference', async (file, rules, before, after) => {
  const id = 'sameAsKnownDifferentConflict';
  const ttl = readFileSync(new URL('../test-fixtures/consistency/' + id + '/' + file + '.ttl', import.meta.url), 'utf8');
  dataset = new context.N3.Store(new context.N3.Parser().parse(ttl));
  const initial = await runInconsistencySelect(id, dataset, { engine, scope: 'default' });
  expect(initial.rows.length > 0).toBe(before);
  let overlay;
  if (rules.length) {
    const result = await inferUntilStable(rules);
    expect(result.metrics.passes).toBeLessThan(30);
    overlay = result.overlayGraph;
    dataset.addQuads([...overlay]);
  }
  const final = await runInconsistencySelect(id, dataset, { engine, scope: 'default', phase: 'after-materialization', materializedStore: overlay });
  expect(final.rows.length > 0).toBe(after);
  for (const finding of final.findings) {
    expect(finding.kind).toBe('violation');
    expect(finding.bindings.a).toBeDefined();
    expect(finding.bindings.b).toBeDefined();
    expect(finding.bindings.inequalitySource).toBeDefined();
    expect(finding.evidence.length).toBeGreaterThan(0);
  }
  if (after) expect(formatConsistencyReport([final])).toContain('?inequalitySource =');
});


test('broad fixture exposes direct and inverse-functional identity contradictions', async () => {
  const ttl = readFileSync(new URL('../../docs/owl-inconsistency-instance-fixture.ttl', import.meta.url), 'utf8');
  dataset = new context.N3.Store(new context.N3.Parser().parse(ttl));
  const result = await inferUntilStable(['functional', 'inversefunctional', 'sameas']);
  dataset.addQuads([...result.overlayGraph]);
  const findings = await runInconsistencySelect('sameAsKnownDifferentConflict', dataset, { engine, scope: 'default' });
  const prefix = 'https://example.org/inconsistency-fixture/';
  expect(findings.rows.some(row => row.a.value === prefix + 'sameDifferentA' && row.b.value === prefix + 'sameDifferentB')).toBe(true);
  expect(findings.rows.some(row => row.a.value === prefix + 'olivia' && row.b.value === prefix + 'peter')).toBe(true);
});
