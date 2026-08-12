/**
 * @file log.js
 * @description Console logging helpers with a single kill-switch.
 */

import { debuggerConsoleLogEnabled } from "./constants.js";
import { createScopedConsoleLogger } from "../shared/ui-feedback/index.js";

const logger = createScopedConsoleLogger({
  scope: "sviz",
  enabled: debuggerConsoleLogEnabled
});

/**
 * Log an event if logging is enabled.
 * @param {string} eventName
 * @param {any} payload
 */
export function logEvent(eventName, payload) {
  logger.info(eventName, payload ?? "");
}

/**
 * Log an error if logging is enabled.
 * @param {string} eventName
 * @param {Error|any} err
 * @param {any} context
 */
export function logError(eventName, err, context) {
  logger.error(eventName, { error: err, context: context ?? "" });
}
