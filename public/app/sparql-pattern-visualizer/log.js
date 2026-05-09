/**
 * @file log.js
 * @description Console logging helpers with a single kill-switch.
 */

import { debuggerConsoleLogEnabled } from "./constants.js";

/**
 * Log an event if logging is enabled.
 * @param {string} eventName
 * @param {any} payload
 */
export function logEvent(eventName, payload) {
  if (!debuggerConsoleLogEnabled) return;
  // eslint-disable-next-line no-console
  console.log(`[sviz] ${eventName}`, payload ?? "");
}

/**
 * Log an error if logging is enabled.
 * @param {string} eventName
 * @param {Error|any} err
 * @param {any} context
 */
export function logError(eventName, err, context) {
  if (!debuggerConsoleLogEnabled) return;
  // eslint-disable-next-line no-console
  console.error(`[sviz] ${eventName}`, err, context ?? "");
}
