const browserGlobals = {
  Blob: 'readonly',
  BroadcastChannel: 'readonly',
  MutationObserver: 'readonly',
  Node: 'readonly',
  btoa: 'readonly',
  caches: 'readonly',
  requestAnimationFrame: 'readonly',
  structuredClone: 'readonly',
  AbortController: 'readonly',
  DataTransfer: 'readonly',
  HTMLInputElement: 'readonly',
  HTMLSelectElement: 'readonly',
  HTMLTextAreaElement: 'readonly',
  Response: 'readonly',
  TextDecoder: 'readonly',
  TextEncoder: 'readonly',
  customElements: 'readonly',
  getComputedStyle: 'readonly',
  global: 'readonly',
  require: 'readonly',
  setImmediate: 'readonly',
  CustomEvent: 'readonly',
  DOMParser: 'readonly',
  Event: 'readonly',
  File: 'readonly',
  FileReader: 'readonly',
  FormData: 'readonly',
  HTMLElement: 'readonly',
  IDBDatabase: 'readonly',
  IDBFactory: 'readonly',
  IDBObjectStore: 'readonly',
  IDBRequest: 'readonly',
  IDBTransaction: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  XMLSerializer: 'readonly',
  alert: 'readonly',
  clearInterval: 'readonly',
  clearTimeout: 'readonly',
  confirm: 'readonly',
  console: 'readonly',
  crypto: 'readonly',
  document: 'readonly',
  fetch: 'readonly',
  globalThis: 'readonly',
  indexedDB: 'readonly',
  localStorage: 'readonly',
  location: 'readonly',
  navigator: 'readonly',
  performance: 'readonly',
  queueMicrotask: 'readonly',
  self: 'readonly',
  setInterval: 'readonly',
  setTimeout: 'readonly',
  window: 'readonly'
};

const vendorGlobals = {
  Comunica: 'readonly',
  N3: 'readonly',
  Tabulator: 'readonly',
  XLSX: 'readonly',
  idb: 'readonly',
  jsonld: 'readonly',
  $rdf: 'readonly'
};

const testGlobals = {
  afterAll: 'readonly',
  afterEach: 'readonly',
  beforeAll: 'readonly',
  beforeEach: 'readonly',
  describe: 'readonly',
  expect: 'readonly',
  jest: 'readonly',
  test: 'readonly'
};

export default [
  {
    ignores: [
      'node_modules/**',
      'public/app/shared/vendor/**',
      '**/*.min.js'
    ]
  },  {
    files: ['**/*.{js,mjs}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...browserGlobals,
        ...vendorGlobals,
        process: 'readonly'
      }
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }]
    }
  },
  {
    files: ['**/*.test.js', '**/__tests__/**/*.js'],
    languageOptions: {
      globals: testGlobals
    }
  }
];
