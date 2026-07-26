/**
 * @file Transitional browser surface for classic Axiolotl scripts.
 *
 * The application still loads several non-module scripts that exchange helpers
 * through globals. This bridge keeps that runtime contract while sourcing the
 * MIME and parser behavior from the promoted ESM modules.
 */
import {
  getFilenameExtension,
  getPreferredExtensionForMimeType,
  getSupportedMimeTypeForFilename,
  normalizeSupportedMimeType
} from './mime-registry.js';
import { getN3ParserFormatForMimeType } from './rdf-parser-formats.js';
import {
  downloadTextFile,
  getAcceptExtensions,
  guessRdfMimeTypeFromText
} from './browser-file-actions.js';

globalThis.FormatRegistry = {
  ...(globalThis.FormatRegistry || {}),
  downloadTextFile,
  getAcceptExtensions,
  getFilenameExtension,
  getN3ParserFormatForMimeType,
  getPreferredExtensionForMimeType,
  getSupportedMimeTypeForFilename,
  guessRdfMimeTypeFromText,
  normalizeSupportedMimeType
};
