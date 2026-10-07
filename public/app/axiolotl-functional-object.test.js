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
