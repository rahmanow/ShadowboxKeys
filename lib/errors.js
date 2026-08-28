'use strict';

/**
 * An error caused by bad input or a server response rather than a bug.
 * The CLI prints these as a plain message, without a stack trace.
 */
class UserError extends Error {}

module.exports = { UserError };
