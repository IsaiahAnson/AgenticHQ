import assert from 'node:assert/strict';
import test from 'node:test';
import { redact, redactObject } from '../tools/ingest/redact.mjs';

test('redacts credentials and authorization headers', () => {
  /* the fake keys are split so secret scanners don't flag this file */
  const input = ['sk-' + 'ant-example123456', 'gh' + 'p_abcdefgh12345678', 'xo' + 'xb-12345678-secret', 'AK' + 'IAABCDEFGHIJKLMNOP', 'Bearer abc.def-ghi'].join(' ');
  const output = redact(input);
  assert.equal(/sk-ant|ghp_|xoxb-|AKIA|Bearer /i.test(output), false);
  assert.match(output, /\[redacted\]/);
});

test('redacts assignments, contact details, and secret-bearing lines', () => {
  const output = redact('password=hunter2 token = abc123\nsam@example.com (212) 555-1212\nread .env value=oops\nkeep this');
  assert.equal(/hunter2|abc123|example\.com|555-1212|oops/.test(output), false);
  assert.match(output, /keep this/);
});

test('redacts colon-style sign-ins from exported password lists', () => {
  const output = redact('Account 1:\n  Username: someone\n  Password: Hunter2xyz99\n  pwd: Zz9!q api_key: abc999');
  assert.equal(/Hunter2xyz99|Zz9!q|abc999/.test(output), false);
  assert.match(output, /Account 1:/);
});

test('redacts nested values without changing non-strings', () => {
  assert.deepEqual(redactObject({ value: 'a@example.com', count: 2, items: ['ghp_abcdefgh12345678'] }), { value: '[redacted]', count: 2, items: ['[redacted]'] });
});
