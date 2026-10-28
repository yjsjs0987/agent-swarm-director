/**
 * Secret redaction utility.
 * Replaces sensitive patterns with [REDACTED].
 */

const REDACTED = "[REDACTED]";

const TS_TYPES_OR_KEYWORDS = new Set([
  "string",
  "number",
  "boolean",
  "any",
  "unknown",
  "never",
  "void",
  "null",
  "undefined",
  "true",
  "false",
  "object",
  "symbol",
  "bigint",
]);

function isLikelyCodeIdentifierOrType(val: string): boolean {
  const clean = val.replace(/[;,)\]]+$/, "").trim();
  if (!clean || clean === REDACTED) return true;
  if (TS_TYPES_OR_KEYWORDS.has(clean.toLowerCase())) return true;
  // Property chains or function calls like req.headers.token, user.password, getToken()
  if (/[.()[\]{}]/.test(clean)) return true;
  return false;
}

/**
 * Redact secrets from input text (used for logs and session summaries).
 * Patterns covered:
 * - AWS keys: AKIA[0-9A-Z]{16} and ASIA[0-9A-Z]{16}
 * - JWT tokens: eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+
 * - PEM private key blocks: -----BEGIN [A-Z ]*PRIVATE KEY-----...-----END [A-Z ]*PRIVATE KEY-----
 * - OpenAI/Anthropic-style: sk-[A-Za-z0-9_-]{16,}
 * - GitHub: ghp_[A-Za-z0-9]{20,}
 * - Google: AIza[0-9A-Za-z_-]{35}
 * - Generic assignments: password, secret, token, api_key key-value assignments
 */
export function redactSecrets(input: string): string {
  let result = input;

  // AWS Access Key IDs (AKIA/ASIA)
  result = result.replace(/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, REDACTED);

  // JWT tokens (three base64url parts separated by dots)
  result = result.replace(
    /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
    REDACTED
  );

  // PEM private key blocks (multi-line)
  result = result.replace(
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    REDACTED
  );

  // OpenAI/Anthropic-style keys (sk-...)
  result = result.replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, REDACTED);

  // GitHub personal access tokens (ghp_...)
  result = result.replace(/\bghp_[A-Za-z0-9]{20,}\b/g, REDACTED);

  // Google API keys (AIza...)
  result = result.replace(/\bAIza[0-9A-Za-z_-]{35}\b/g, REDACTED);

  const quotedPatterns = [
    /(\bpassword["']?\s*[:=]\s*)(["'])([^"']+)\2/gi,
    /(\bsecret["']?\s*[:=]\s*)(["'])([^"']+)\2/gi,
    /(\btoken["']?\s*[:=]\s*)(["'])([^"']+)\2/gi,
    /(\bapi[_-]?key["']?\s*[:=]\s*)(["'])([^"']+)\2/gi,
  ];

  for (const pattern of quotedPatterns) {
    result = result.replace(pattern, (match, prefix, quote, value) => {
      if (value === REDACTED) return match;
      return `${prefix}${quote}${REDACTED}${quote}`;
    });
  }

  const unquotedPatterns = [
    /(\bpassword\s*[:=]\s*)([^"'\s,};)]+)/gi,
    /(\bsecret\s*[:=]\s*)([^"'\s,};)]+)/gi,
    /(\btoken\s*[:=]\s*)([^"'\s,};)]+)/gi,
    /(\bapi[_-]?key\s*[:=]\s*)([^"'\s,};)]+)/gi,
  ];

  for (const pattern of unquotedPatterns) {
    result = result.replace(pattern, (match, prefix, value) => {
      if (isLikelyCodeIdentifierOrType(value)) return match;
      return `${prefix}${REDACTED}`;
    });
  }

  return result;
}

/**
 * High-confidence secret detector for source code files during workspace verification.
 * Avoids false-positive rollbacks on normal TypeScript/JavaScript code (e.g. `token: string`,
 * `const token = req.token`, or short test placeholders).
 */
export function hasLeakedSecrets(content: string): boolean {
  if (/\b(AKIA|ASIA)[0-9A-Z]{16}\b/.test(content)) return true;
  if (/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/.test(content)) {
    return true;
  }
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(content)) return true;
  if (/\bsk-[A-Za-z0-9_-]{16,}\b/.test(content)) return true;
  if (/\bghp_[A-Za-z0-9]{20,}\b/.test(content)) return true;
  if (/\bAIza[0-9A-Za-z_-]{35}\b/.test(content)) return true;

  return false;
}
