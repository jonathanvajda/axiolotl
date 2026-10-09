// Bounded OWL value comparison. Unknown/invalid values are never guessed.
import { COMMON_NAMESPACE_REGISTRY } from './shared/namespace-registry/index.js';

const XSD = COMMON_NAMESPACE_REGISTRY.xsd.namespaceIri;
const RDF = COMMON_NAMESPACE_REGISTRY.rdf.namespaceIri;
const integerBounds = {
  integer: [null, null], nonPositiveInteger: [null, 0n], negativeInteger: [null, -1n],
  long: [-(2n ** 63n), 2n ** 63n - 1n], int: [-(2n ** 31n), 2n ** 31n - 1n],
  short: [-32768n, 32767n], byte: [-128n, 127n],
  nonNegativeInteger: [0n, null], positiveInteger: [1n, null],
  unsignedLong: [0n, 2n ** 64n - 1n], unsignedInt: [0n, 2n ** 32n - 1n],
  unsignedShort: [0n, 65535n], unsignedByte: [0n, 255n],
};
function valueOf(term) {
  if (term?.termType !== 'Literal') return null;
  const datatype = term.datatype?.value;
  if (datatype === XSD + 'string') return { family: 'string', value: term.value };
  if (datatype === RDF + 'langString' && term.language) {
    return { family: 'language', value: term.value, language: term.language.toLowerCase() };
  }
  if (datatype === XSD + 'boolean') {
    const value = term.value.trim();
    if (!['true', 'false', '1', '0'].includes(value)) return null;
    return { family: 'boolean', value: value === 'true' || value === '1' };
  }
  const type = datatype?.startsWith(XSD) ? datatype.slice(XSD.length) : '';
  const lexical = term.value.trim();
  if (Object.hasOwn(integerBounds, type)) {
    if (!/^[+-]?[0-9]+$/.test(lexical)) return null;
    const value = BigInt(lexical);
    const [min, max] = integerBounds[type];
    if ((min !== null && value < min) || (max !== null && value > max)) return null;
    return { family: 'numeric', numerator: value, denominator: 1n };
  }
  if (type === 'decimal' && /^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)$/.test(lexical)) {
    const negative = lexical.startsWith('-');
    const [whole, fraction = ''] = lexical.replace(/^[+-]/, '').split('.');
    return { family: 'numeric', numerator: BigInt((whole || '0') + fraction) * (negative ? -1n : 1n), denominator: 10n ** BigInt(fraction.length) };
  }
  return null;
}

export function compareDatatypeValues(left, right) {
  const a = valueOf(left), b = valueOf(right);
  if (!a || !b) return 'unsupported';
  if (a.family !== b.family) return 'unequal';
  const equal = a.family === 'numeric'
    ? a.numerator * b.denominator === b.numerator * a.denominator
    : a.value === b.value && a.language === b.language;
  return equal ? 'equal' : 'unequal';
}

function stringTerm(value) {
  const datatype = { termType: 'NamedNode', value: XSD + 'string', equals(other) { return other?.termType === this.termType && other.value === this.value; } };
  return { termType: 'Literal', value, language: '', datatype,
    equals(other) { return other?.termType === 'Literal' && other.value === value && !other.language && datatype.equals(other.datatype); } };
}

export function datatypeComparisonExtensions(onUnsupported = () => {}) {
  return {
    'http://example.org/axiolotl/inconsistency/compareValues': ([left, right]) => {
      const comparison = compareDatatypeValues(left, right);
      if (comparison === 'unsupported') onUnsupported(left, right);
      return stringTerm(comparison);
    },
  };
}
