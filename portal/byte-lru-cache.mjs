export class ByteLruCache {
  #entries = new Map();
  #totalBytes = 0;

  constructor(maxEntries, maxBytes) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1
      || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new TypeError('ByteLruCache limits must be positive safe integers.');
    }
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
  }

  get size() { return this.#entries.size; }
  get totalBytes() { return this.#totalBytes; }
  keys() { return this.#entries.keys(); }

  get(key) {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.value;
  }

  set(key, value, bytes) {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new TypeError('Cache entry bytes must be a non-negative safe integer.');
    this.delete(key);
    if (bytes > this.maxBytes) return this;
    this.#entries.set(key, { value, bytes });
    this.#totalBytes += bytes;
    while (this.#entries.size > this.maxEntries || this.#totalBytes > this.maxBytes) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.delete(oldest);
    }
    return this;
  }

  delete(key) {
    const entry = this.#entries.get(key);
    if (!entry) return false;
    this.#entries.delete(key);
    this.#totalBytes = Math.max(0, this.#totalBytes - entry.bytes);
    return true;
  }
}
