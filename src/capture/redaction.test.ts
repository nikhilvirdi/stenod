/**
 * Phase 4.5 — Secret Redaction (Filesystem) Tests
 *
 * SSOT §10 / WORKPLAN Phase 4.5 "Done when" checklist:
 *   [x] Known secret-shaped test strings are redacted, not stored raw
 *   [x] Ordinary code content passes through unmodified
 */

import { describe, it, expect } from 'vitest';
import { redactSecrets, REDACTED_PLACEHOLDER } from './redaction.js';

describe('capture/redaction — Phase 4.5', () => {
  // ── Cloud key patterns ───────────────────────────────────────────────────

  it('redacts an AWS access key id', () => {
    const raw = 'const key = "AKIAABCDEFGHIJKLMNOP";';
    const result = redactSecrets(raw);
    expect(result).not.toContain('AKIAABCDEFGHIJKLMNOP');
    expect(result).toContain(REDACTED_PLACEHOLDER);
  });

  it('redacts a Google API key', () => {
    const raw = 'GOOGLE_API_KEY=AIzaSyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY';
    const result = redactSecrets(raw);
    expect(result).not.toContain('AIzaSyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY');
    expect(result).toContain(REDACTED_PLACEHOLDER);
  });

  it('redacts a GitHub personal access token', () => {
    const raw = 'export const token = "ghp_1234567890abcdefghijklmnopqrstuvwxyz"';
    const result = redactSecrets(raw);
    expect(result).not.toContain('ghp_1234567890abcdefghijklmnopqrstuvwxyz');
    expect(result).toContain(REDACTED_PLACEHOLDER);
  });

  it('redacts a Slack token', () => {
    const fakeKey = 'xoxb-' + 'F'.repeat(30);
    const raw = `slack_token = "${fakeKey}"`;
    const result = redactSecrets(raw);
    expect(result).not.toContain(fakeKey);
    expect(result).toContain(REDACTED_PLACEHOLDER);
  });

  it('redacts a Stripe live secret key', () => {
    const fakeKey = 'sk_' + 'live_' + '0'.repeat(24);
    const raw = `stripe.setKey('${fakeKey}')`;
    const result = redactSecrets(raw);
    expect(result).not.toContain(fakeKey);
    expect(result).toContain(REDACTED_PLACEHOLDER);
  });

  // ── Bearer tokens ────────────────────────────────────────────────────────

  it('redacts an Authorization: Bearer header value', () => {
    const raw = "headers: { Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.abcdefg.hijklmn' }";
    const result = redactSecrets(raw);
    expect(result).not.toContain('eyJhbGciOiJIUzI1NiJ9.abcdefg.hijklmn');
    expect(result).toContain(REDACTED_PLACEHOLDER);
    expect(result).toContain('Authorization:');
  });

  // ── Generic key=/secret= assignments ────────────────────────────────────

  it('redacts a generic secretKey assignment, keeping the identifier visible', () => {
    const raw = 'const secretKey = "hunter2";';
    const result = redactSecrets(raw);
    expect(result).toBe(`const secretKey = "${REDACTED_PLACEHOLDER}";`);
  });

  it('redacts a generic password field in object-literal/YAML style', () => {
    const raw = "password: 'sw0rdfish'";
    const result = redactSecrets(raw);
    expect(result).toBe(`password: '${REDACTED_PLACEHOLDER}'`);
  });

  it('redacts a shell-style API_SECRET assignment', () => {
    const raw = 'API_SECRET=topsecret123';
    const result = redactSecrets(raw);
    expect(result).toBe(`API_SECRET=${REDACTED_PLACEHOLDER}`);
  });

  it('does not treat an equality comparison as an assignment', () => {
    const raw = 'if (token === session.token) { return true; }';
    const result = redactSecrets(raw);
    expect(result).toBe(raw);
  });

  // ── Ordinary code passes through unmodified ─────────────────────────────

  it('leaves ordinary code completely unmodified', () => {
    const raw = [
      'function add(a, b) {',
      '  return a + b;',
      '}',
      '',
      'const greeting = "hello world";',
      'const numbers = [1, 2, 3].map((n) => n * 2);',
      'export class Widget {',
      '  render() { return null; }',
      '}',
    ].join('\n');

    expect(redactSecrets(raw)).toBe(raw);
  });

  // ── Fixture with both a secret and normal code side by side ────────────

  it('redacts the secret in a mixed fixture while leaving surrounding code intact', () => {
    const raw = [
      'const apiKey = "AKIAABCDEFGHIJKLMNOP";',
      '',
      'function greet(name) {',
      '  return `Hello, ${name}!`;',
      '}',
    ].join('\n');

    const result = redactSecrets(raw);

    expect(result).not.toContain('AKIAABCDEFGHIJKLMNOP');
    expect(result).toContain(REDACTED_PLACEHOLDER);
    expect(result).toContain('function greet(name) {');
    expect(result).toContain('return `Hello, ${name}!`;');
  });
});
