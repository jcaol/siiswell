// SPDX-License-Identifier: Apache-2.0
/**
 * @file Fixed labels stored instead of host-supplied free text when ACCEPT_LAST_LINE is not "1". Calm wording; no typed text.
 * Migration 0012 writes the same literals, so keep the two in step.
 * @module shared/labels
 */
/** A relayed agent's status event / task title. */
export const RELAY_LABEL = "Status update";
/** A host "halt" event (stuck agent) other than a usage limit. */
export const STUCK_LABEL = "Agent may be stuck";
/** A host "halt" event for a usage limit. */
export const LIMIT_LABEL = "Usage limit reached";
/** A pending approval, stored instead of its summary (ACCEPT_HOST_TEXT below `full`). */
export const APPROVAL_LABEL = "Approval pending";
/** A host lifecycle event, stored instead of its text (ACCEPT_HOST_TEXT minimal / none). */
export const LIFECYCLE_LABEL = "Lifecycle update";
