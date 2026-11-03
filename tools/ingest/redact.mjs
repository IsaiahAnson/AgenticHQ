const RULES = [
  /\bsk-(?:ant-?)?[A-Za-z0-9_-]*/gi,
  /\bghp_[A-Za-z0-9]*/gi,
  /\bxox(?:a|b|p|r|s)-[A-Za-z0-9-]{8,}\b/gi,
  /\bAKIA[A-Z0-9]{12,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi,
  /\b(?:password|passwd|pwd|passcode|token|secret|api[_-]?key)\s*[:=]\s*[^\s;&]+/gi,
  /\b[A-Fa-f0-9]{32,}\b/g,
  /\b[A-Za-z0-9+/]{32,}={0,2}\b/g,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  /(?<!\w)(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}(?!\w)/g,
];

export function redact(value) {
  let text = String(value ?? '');
  text = text.split(/\r?\n/).map((line) => /secrets\.local\.json|(?:^|[\s"'])\.env(?:[\s"'=]|$)/i.test(line) ? '[redacted]' : line).join('\n');
  for (const rule of RULES) text = text.replace(rule, '[redacted]');
  return text;
}

export function redactObject(value) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(redactObject);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactObject(item)]));
  return value;
}
