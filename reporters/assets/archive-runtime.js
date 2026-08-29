(() => {
  'use strict';

  const CURRENT_RUNTIME_VERSION = 3;
  const CURRENT_BUNDLE_VERSION = 3;
  const MINIMUM_BUNDLE_VERSION = 1;
  const DATA_SCHEMA_VERSION = 1;

  function legacyContract() {
    return Object.freeze({
      schemaVersion: 1,
      bundleVersion: 1,
      runtimeVersion: 1,
      minimumReaderVersion: 1,
      dataSchemaVersion: 1,
      assetBase: 'assets',
      manifestHref: null,
      legacy: true,
    });
  }

  function parseContract(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || value.schemaVersion !== 1
      || !Number.isInteger(value.bundleVersion)
      || !Number.isInteger(value.runtimeVersion)
      || !Number.isInteger(value.minimumReaderVersion)
      || !Number.isInteger(value.dataSchemaVersion)
      || typeof value.assetBase !== 'string'
      || typeof value.manifestHref !== 'string') {
      throw new TypeError(`${label} archive bundle contract is invalid.`);
    }
    if (value.bundleVersion < MINIMUM_BUNDLE_VERSION || value.bundleVersion > CURRENT_BUNDLE_VERSION
      || value.runtimeVersion > CURRENT_RUNTIME_VERSION
      || value.minimumReaderVersion > CURRENT_RUNTIME_VERSION
      || value.dataSchemaVersion !== DATA_SCHEMA_VERSION) {
      throw new TypeError(`${label} archive bundle is not compatible with runtime ${CURRENT_RUNTIME_VERSION}.`);
    }
    const expectedBase = `assets/archive-v${value.bundleVersion}`;
    if (value.assetBase !== expectedBase || value.manifestHref !== `${expectedBase}/bundle.json`) {
      throw new TypeError(`${label} archive bundle paths do not match its version.`);
    }
    return Object.freeze({ ...value, legacy: false });
  }

  function validateBundleContract(embeddedValue, descriptorValue, dataSchemaVersion = DATA_SCHEMA_VERSION) {
    if (dataSchemaVersion !== DATA_SCHEMA_VERSION) {
      throw new TypeError('The sealed archive data schema is not supported.');
    }
    if (embeddedValue == null && descriptorValue == null) return legacyContract();
    if (embeddedValue == null || descriptorValue == null) {
      throw new TypeError('The sealed archive bundle metadata is incomplete.');
    }
    const embedded = parseContract(embeddedValue, 'Embedded');
    const descriptor = parseContract(descriptorValue, 'Descriptor');
    if (JSON.stringify(embeddedValue) !== JSON.stringify(descriptorValue)) {
      throw new TypeError('The sealed archive bundle metadata does not match its pinned descriptor.');
    }
    return embedded;
  }

  function readEmbeddedContract(documentObject, descriptorValue = null, dataSchemaVersion = DATA_SCHEMA_VERSION) {
    const node = documentObject?.querySelector?.('#archive-bundle');
    let embedded = null;
    if (node) {
      try { embedded = JSON.parse(node.textContent ?? 'null'); } catch {
        throw new TypeError('The embedded archive bundle metadata is invalid JSON.');
      }
    }
    return validateBundleContract(embedded, descriptorValue, dataSchemaVersion);
  }

  globalThis.Quitting7ohArchiveRuntime = Object.freeze({
    CURRENT_RUNTIME_VERSION,
    CURRENT_BUNDLE_VERSION,
    MINIMUM_BUNDLE_VERSION,
    DATA_SCHEMA_VERSION,
    validateBundleContract,
    readEmbeddedContract,
  });
})();
