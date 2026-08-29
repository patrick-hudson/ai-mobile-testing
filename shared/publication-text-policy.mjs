import { Buffer } from 'node:buffer';
import { failContract } from './canonical-contract.mjs';

const ANSI_OSC = /\u001b\][^\u0007]*(?:\u0007|\u001b\\)/gu;
const ANSI_CSI = /\u001b\[[0-?]*[ -/]*[@-~]/gu;
const ANSI_ESCAPE = /\u001b[@-_]/gu;
const BASE64_TOKEN = /(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{16,}={0,2}(?![A-Za-z0-9+/_=-])/gu;
const SECRET_CANARIES = Object.freeze([
  /\b(?:authorization|proxy-authorization)\s*:\s*(?:bearer|basic)\s+[^\s,;]{8,}/iu,
  /\b(?:cookie|set-cookie)\s*:\s*[^\s,;]{8,}/iu,
  /\b(?:x-api-key|api[-_ ]?key|anthropic_api_key|openai_api_key)\s*(?::|=)\s*["']?[^\s"',;]{8,}/iu,
  /\bbearer\s+[A-Za-z0-9._~+\/-]{12,}={0,2}/iu,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{12,}/iu,
]);

function decodedUrl(value) {
  const variants = [];
  let current = value;
  for (let count = 0; count < 2; count += 1) {
    try {
      const decoded = decodeURIComponent(current);
      if (decoded === current) break;
      variants.push(decoded);
      current = decoded;
    } catch {
      break;
    }
  }
  return variants;
}

function decodedBase64(value) {
  const variants = [];
  for (const match of value.matchAll(BASE64_TOKEN)) {
    const token = match[0];
    try {
      const normalized = token.replace(/-/gu, '+').replace(/_/gu, '/');
      const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
      const decoded = Buffer.from(padded, 'base64').toString('utf8');
      if (!decoded || decoded.includes('\uFFFD')) continue;
      const readable = [...decoded].filter((character) => character === '\n' || character === '\r'
        || character === '\t' || (character.codePointAt(0) >= 0x20 && character.codePointAt(0) !== 0x7f)).length;
      if (readable / [...decoded].length >= 0.9) variants.push(decoded);
    } catch {
      // Invalid base64-like prose is not itself sensitive.
    }
  }
  return variants;
}

function inspectionVariants(value) {
  const variants = new Set([value]);
  for (const decoded of decodedUrl(value)) variants.add(decoded);
  for (const candidate of [...variants]) {
    for (const decoded of decodedBase64(candidate)) {
      variants.add(decoded);
      for (const urlDecoded of decodedUrl(decoded)) variants.add(urlDecoded);
    }
  }
  return [...variants].flatMap((candidate) => [candidate, candidate.replace(/[\r\n\t]+/gu, ' ')]);
}

function containsSecretCanary(value) {
  return inspectionVariants(value).some((candidate) => SECRET_CANARIES.some((pattern) => pattern.test(candidate)));
}

function sanitizeControls(value) {
  const withoutTerminalControls = value
    .replace(ANSI_OSC, '')
    .replace(ANSI_CSI, '')
    .replace(ANSI_ESCAPE, '')
    .replace(/\r\n?/gu, '\n')
    .replace(/\t/gu, ' ');
  return [...withoutTerminalControls]
    .filter((character) => character === '\n' || !/[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}]/u.test(character))
    .join('')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
}

export function sealPublicationText(value, { maximum = 2_048 } = {}) {
  if (typeof value !== 'string' || !Number.isSafeInteger(maximum) || maximum < 1) {
    failContract('PUBLICATION_TEXT_REJECTED', 'Publication text did not satisfy the safe publication policy.');
  }
  if (containsSecretCanary(value)) {
    failContract('PUBLICATION_TEXT_REJECTED', 'Publication text did not satisfy the safe publication policy.');
  }
  const sanitized = sanitizeControls(value);
  if (!sanitized || sanitized.length > maximum || containsSecretCanary(sanitized)) {
    failContract('PUBLICATION_TEXT_REJECTED', 'Publication text did not satisfy the safe publication policy.');
  }
  return sanitized;
}
