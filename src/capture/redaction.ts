/**
 * Phase 4.5 — Secret Redaction (Filesystem)
 *
 * SSOT §10: "Two-layer secret protection — never watching secret-adjacent
 * paths (primary, strongest), regex redaction as a backstop (secondary,
 * heuristic, stated honestly as imperfect)." This module is that backstop.
 * The primary layer is Phase 4.1's .env exclusion — this never replaces it.
 *
 * WORKPLAN Build: "regex pass for common secret shapes (cloud key patterns,
 * bearer tokens, generic key=/secret= assignments) applied to file content
 * before it reaches graph_nodes.content."
 *
 * Deliberately content-agnostic (not filesystem-specific): Phase 5.5's own
 * Build line says to reuse "the same redaction pass from Phase 4.5" for
 * terminal output, so this takes and returns a plain string with no
 * filesystem dependency.
 */

export const REDACTED_PLACEHOLDER = '[REDACTED]';

/**
 * Recognizable cloud-provider/vendor token shapes, where the entire match
 * *is* the secret (no surrounding "key=" structure to preserve).
 */
const WHOLE_TOKEN_PATTERNS: readonly RegExp[] = [
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API key
  /\bgh[pousr]_[A-Za-z0-9]{36}\b/g, // GitHub token (classic PAT/app tokens)
  /\bxox[baprs]-[0-9A-Za-z-]{10,48}\b/g, // Slack token
  /\bsk_live_[0-9A-Za-z]{24,}\b/g, // Stripe secret key
  /\bpk_live_[0-9A-Za-z]{24,}\b/g, // Stripe publishable key (live)
  /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/g, // Authorization: Bearer <token>
];

/**
 * Generic `key=value` / `secret: value` style assignments. Matches an
 * identifier that contains secret/token/password/api-key, followed by an
 * assignment separator, and redacts only the value — the identifier stays
 * visible so redacted content still reads as recognizable code.
 *
 * The separator deliberately excludes `==`/`===` (via the `=(?!=)` negative
 * lookahead) so equality comparisons like `if (token === expected)` are not
 * mistaken for an assignment and left untouched.
 *
 * Known imperfection (accepted per SSOT §10's "stated honestly as
 * imperfect"): an identifier that merely *contains* one of these words as a
 * substring (e.g. a hypothetical `secretary` field) would also match. This
 * is a heuristic backstop, not the primary protection — erring toward
 * over-redaction is the safer failure mode for a secret scanner.
 */
const GENERIC_ASSIGNMENT_PATTERN =
  /\b([\w.$-]*(?:secret|token|password|passwd|pwd|api[_-]?key)[\w.$-]*)(\s*(?::|=(?!=))\s*)(['"]?)([^\s'",;]+)\3/gi;

/**
 * Redacts common secret shapes from `content`, returning a new string.
 * Ordinary code that doesn't match any of the patterns above passes
 * through byte-for-byte unmodified.
 */
export function redactSecrets(content: string): string {
  let result = content;

  for (const pattern of WHOLE_TOKEN_PATTERNS) {
    result = result.replace(pattern, REDACTED_PLACEHOLDER);
  }

  result = result.replace(
    GENERIC_ASSIGNMENT_PATTERN,
    (_match, ident: string, separator: string, quote: string) =>
      `${ident}${separator}${quote}${REDACTED_PLACEHOLDER}${quote}`,
  );

  return result;
}
