import { jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// Use the exact N3 bundle shipped to standalone browsers.
const module = { exports: {} };
const context = { module, exports: module.exports, AbortController, AbortSignal: globalThis.AbortSignal, setTimeout, clearTimeout, queueMicrotask };
context.global = context;
context.self = context;
runInNewContext(readFileSync(new URL('./shared/vendor/n3.min.js', import.meta.url), 'utf8'), context);
const N3 = module.exports;
const { namedNode, defaultGraph } = N3.DataFactory;
let base;
jest.unstable_mockModule('./comunica-indexeddb-bridge.js', () => ({
  loadGraphFromIndexedDB: async () => new N3.Store(base.getQuads(null, null, null, null)),
  stashGraphToIndexedDB: jest.fn(),
}));
jest.unstable_mockModule('./semantic-core.js', () => ({ debuggingConsoleEnabled: false }));
globalThis.N3 = N3;
globalThis.Comunica = { QueryEngine: class {
  queryQuads() { throw new Error('Equality must preserve terms without CONSTRUCT'); }
} };
globalThis.document = { getElementById: () => null };
const { inferUntilStable } = await import('./axiolotl-inference.js');
const EX = 'https://example.org/consistency-fixture/';
const OWL = 'http://www.w3.org/2002/07/owl#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';

test('AllDifferent fixture equality reaches a fixpoint without cloning list cells', async () => {
  const ttl = readFileSync(new URL('../test-fixtures/consistency/allDifferentSameAsConflict/positive.ttl', import.meta.url), 'utf8');
  base = new N3.Store(new N3.Parser().parse(ttl));
  const { overlayGraph, metrics } = await inferUntilStable(['sameas']);
  expect(metrics.passes).toBeLessThan(30);
  const combined = new N3.Store([...base, ...overlayGraph]);
  const blanks = store => new Set([...store].flatMap(q => [q.subject, q.object, q.graph]).filter(t => t.termType === 'BlankNode').map(t => t.value));
  expect(blanks(combined)).toEqual(blanks(base));
  const first = namedNode(RDF + 'first');
  const a = namedNode(EX + 'a');
  const b = namedNode(EX + 'b');
  const originalCells = base.getQuads(null, first, null, null);
  expect(originalCells).toHaveLength(2);
  expect(originalCells[0].subject.equals(originalCells[1].subject)).toBe(false);
  for (const cell of originalCells) {
    expect(combined.countQuads(cell.subject, first, a, null)).toBe(1);
    expect(combined.countQuads(cell.subject, first, b, null)).toBe(1);
  }
  expect(combined.countQuads(a, namedNode(OWL + 'sameAs'), b, defaultGraph())).toBe(1);
  base = combined;
  const second = await inferUntilStable(['sameas']);
  expect(second.metrics.totalAdded).toBe(0);
});
