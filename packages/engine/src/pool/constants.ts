/**
 * Engine-wide runtime constants shared across multiple consumers.
 *
 * This module houses constants that were previously duplicated across files.
 * Each constant is defined once here and imported wherever it is used, so the
 * value is always consistent and the declaration site is unambiguous.
 */

/** Default ceiling on retry/fixer rounds when none is specified. */
export const DEFAULT_MAX_ROUNDS = 3;
