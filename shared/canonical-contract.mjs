import { createHash } from 'node:crypto';

export const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;

export class ContractError extends TypeError {
  constructor(code, message) {
    super(message);
    this.name = 'ContractError';
    this.code = code;
  }
}

export function failContract(code, message) {
  throw new ContractError(code, message);
}

export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonicalValue(value, path) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (Object.keys(value).some((key) => !/^\d+$/.test(key))) {
      failContract('UNSUPPORTED_CANONICAL_VALUE', `${path} contains non-index array properties.`);
    }
    return value.map((entry, index) => canonicalValue(entry, `${path}[${index}]`));
  }
  if (!isRecord(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    failContract('UNSUPPORTED_CANONICAL_VALUE', `${path} contains an unsupported canonical value.`);
  }
  const output = {};
  for (const key of Object.keys(value).sort()) {
    const entry = value[key];
    if (entry === undefined || typeof entry === 'bigint' || typeof entry === 'function' || typeof entry === 'symbol') {
      failContract('UNSUPPORTED_CANONICAL_VALUE', `${path}.${key} contains an unsupported canonical value.`);
    }
    output[key] = canonicalValue(entry, `${path}.${key}`);
  }
  return output;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value, '$'));
}

export function canonicalDigest(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

export function assertSchemaVersion(value, label) {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    failContract('UNSUPPORTED_SCHEMA_VERSION', `${label} must use schemaVersion 1.`);
  }
}

export function assertDigest(value, label) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    failContract('INVALID_DIGEST', `${label} must be a sha256 digest.`);
  }
  return value;
}

export function nonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0) {
    failContract('INVALID_CONTRACT', `${label} must be a non-empty trimmed string.`);
  }
  return value;
}

export function uniqueStrings(value, label, { nonEmpty = false } = {}) {
  if (!Array.isArray(value) || (nonEmpty && value.length === 0)) {
    failContract('INVALID_CONTRACT', `${label} must be ${nonEmpty ? 'a non-empty ' : 'an '}array of strings.`);
  }
  const normalized = value.map((entry) => nonEmptyString(entry, label));
  if (new Set(normalized).size !== normalized.length) {
    failContract('INVALID_CONTRACT', `${label} must not contain duplicates.`);
  }
  return [...normalized].sort();
}

export function exactKeys(value, allowed, label) {
  if (!isRecord(value)) failContract('INVALID_CONTRACT', `${label} must be an object.`);
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) failContract('INVALID_CONTRACT', `${label} contains unsupported fields: ${unknown.sort().join(', ')}.`);
}

export function freezeContract(value) {
  if (Array.isArray(value)) {
    for (const entry of value) freezeContract(entry);
  } else if (isRecord(value)) {
    for (const entry of Object.values(value)) freezeContract(entry);
  }
  return Object.freeze(value);
}
