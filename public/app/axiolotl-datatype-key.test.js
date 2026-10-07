import { webcrypto } from 'node:crypto';
import { compareDatatypeValues, datatypeComparisonExtensions } from './datatype-value-comparison.js';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { getInconsistencyQuery, runInconsistencySelect } from './axiolotl-inconsistency.js';

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

const cases = [["datatypeFunctionalPropertyConflict", "string-integer-conflict", true, false], ["datatypeFunctionalPropertyConflict", "integer-lexical-control", false, false], ["datatypeFunctionalPropertyConflict", "integer-decimal-control", false, false], ["datatypeFunctionalPropertyConflict", "large-integer-conflict", true, false], ["datatypeFunctionalPropertyConflict", "boolean-lexical-control", false, false], ["datatypeFunctionalPropertyConflict", "unsupported-float", false, true], ["datatypeFunctionalPropertyConflict", "invalid-integer", false, true], ["singlePropertyHasKeyDifferentFromConflict", "numeric-value-collision", true, false], ["singlePropertyHasKeyDifferentFromConflict", "mixed-datatype-control", false, false], ["singlePropertyHasKeyDifferentFromConflict", "anonymous-individual-control", false, false], ["singlePropertyHasKeyDifferentFromConflict", "anonymous-object-value-control", false, false], ["singlePropertyHasKeyDifferentFromConflict", "object-equality-collision", true, false], ["singlePropertyHasKeyDifferentFromConflict", "all-different-collision", true, false], ["singlePropertyHasKeyDifferentFromConflict", "reverse-inequality-collision", true, false], ["singlePropertyHasKeyDifferentFromConflict", "unsupported-key-value", false, true]];
test.each(cases)('%s / %s has expected evidence and coverage status', async (id, file, expected, notice) => {
  const ttl = readFileSync(new URL('../test-fixtures/consistency/' + id + '/' + file + '.ttl', import.meta.url), 'utf8');
  const store = new context.N3.Store(new context.N3.Parser().parse(ttl));
  const result = await runInconsistencySelect(id, store, { engine, scope: 'default' });
  expect(result.rows.length > 0).toBe(expected);
  expect(Boolean(result.notices?.length)).toBe(notice);
});

const XSD = 'http://www.w3.org/2001/XMLSchema#';
const literal = (value, type) => context.N3.DataFactory.literal(value, context.N3.DataFactory.namedNode(XSD + type));
test.each([
  ['0.10', 'decimal', '.1', 'decimal', 'equal'],
  ['-0', 'integer', '0.000', 'decimal', 'equal'],
  ['9007199254740992', 'integer', '9007199254740993', 'integer', 'unequal'],
  ['256', 'unsignedByte', '256', 'integer', 'unsupported'],
  ['-1', 'unsignedInt', '-1', 'integer', 'unsupported'],
  ['1e0', 'decimal', '1', 'integer', 'unsupported'],
  ['FALSE', 'boolean', 'false', 'boolean', 'unsupported'],
  ['true', 'boolean', '1', 'boolean', 'equal'],
  ['true', 'boolean', '1', 'integer', 'unequal'],
  ['1', 'string', '1', 'integer', 'unequal'],
])('exact bounded comparison %s %s / %s %s', (a, at, b, bt, expected) => {
  expect(compareDatatypeValues(literal(a, at), literal(b, bt))).toBe(expected);
});

test('language tags compare case-insensitively without altering text', () => {
  const df = context.N3.DataFactory;
  expect(compareDatatypeValues(df.literal('hello', 'EN'), df.literal('hello', 'en'))).toBe('equal');
  expect(compareDatatypeValues(df.literal('hello', 'en'), df.literal('hello', 'fr'))).toBe('unequal');
});

test.each(['datatypeFunctionalPropertyConflict', 'singlePropertyHasKeyDifferentFromConflict'])('original %s fixtures still work', async id => {
  for (const [file, expected] of [['positive', true], ['control', false]]) {
    const ttl = readFileSync(new URL('../test-fixtures/consistency/' + id + '/' + file + '.ttl', import.meta.url), 'utf8');
    const store = new context.N3.Store(new context.N3.Parser().parse(ttl));
    const result = await runInconsistencySelect(id, store, { engine, scope: 'default' });
    expect(result.rows.length > 0).toBe(expected);
  }
});

test('datatype comparison extension works in generated ASK and CONSTRUCT forms', async () => {
  const id = 'datatypeFunctionalPropertyConflict';
  const ttl = readFileSync(new URL('../test-fixtures/consistency/' + id + '/string-integer-conflict.ttl', import.meta.url), 'utf8');
  const store = new context.N3.Store(new context.N3.Parser().parse(ttl));
  const options = { sources: [{ type: 'rdfjsSource', value: store }], extensionFunctions: datatypeComparisonExtensions() };
  const ask = await engine.queryBoolean(getInconsistencyQuery(id, { scope: 'default', resultForm: 'ask' }), options);
  expect(ask).toBe(true);
  const stream = await engine.queryQuads(getInconsistencyQuery(id, { scope: 'default', resultForm: 'construct' }), options);
  const quads = [];
  await new Promise((resolve, reject) => {
    stream.on('data', quad => quads.push(quad));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  expect(quads.length).toBeGreaterThan(0);
});
