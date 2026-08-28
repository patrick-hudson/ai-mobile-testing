(() => {
  if (location.protocol === 'file:') return;
  let bundle;
  try {
    const descriptor = JSON.parse(document.querySelector('#gallery-archive-head')?.textContent ?? 'null');
    bundle = globalThis.Quitting7ohArchiveRuntime?.readEmbeddedContract(
      document,
      descriptor?.archiveBundle ?? null,
      descriptor?.schemaVersion,
    );
    if (!bundle) throw new TypeError('The pinned archive runtime bundle is unavailable.');
  } catch (error) {
    const loading = document.querySelector('#gallery-loading');
    const fatal = document.querySelector('#gallery-fatal');
    if (loading) loading.hidden = true;
    if (fatal) fatal.hidden = false;
    const message = document.querySelector('#gallery-fatal-message');
    if (message) message.textContent = error instanceof Error ? error.message : 'Archive runtime validation failed.';
    return;
  }
  // The controller and archive adapter are inlined by the generator for both
  // HTTP and file URLs. Keeping module execution inside the sealed page means
  // a previous portal server can serve a new export without knowing the new
  // versioned module path or relaxing its opaque-origin CORS policy.
  globalThis.Quitting7ohArchiveBundle = bundle;
})();
