import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
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


jest.unstable_mockModule('./comunica-indexeddb-bridge.js', () => ({
  loadGraphFromIndexedDB: jest.fn(), stashGraphToIndexedDB: jest.fn(),
}));
jest.unstable_mockModule('./semantic-core.js', () => ({ debuggingConsoleEnabled: false }));
globalThis.N3 = context.N3;
globalThis.Comunica = context.Comunica;
globalThis.document = { getElementById: () => null };
const { runRuleOnce } = await import('./axiolotl-inference.js');

for (const rule of ['hasvalueclass', 'somevaluesfromclass']) {
  test.each([
    ['subclass-control', false],
    ['equivalent-positive', true],
    ['reverse-equivalent-positive', true],
  ])(rule + ' / %s recognizes only sufficient class conditions', async (variant, expected) => {
    const ttl = readFileSync(new URL('../test-fixtures/materialization/class-recognition/' + rule + '-' + variant + '.ttl', import.meta.url), 'utf8');
    const store = new context.N3.Store(new context.N3.Parser().parse(ttl));
    const quads = await runRuleOnce(rule, store);
    expect(quads.some(q => q.subject.value === 'https://example.org/class-recognition/x'
      && q.predicate.value === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'
      && q.object.value === 'https://example.org/class-recognition/C')).toBe(expected);
  });
}
