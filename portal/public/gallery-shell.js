import { createConsoleSplitter } from './console-shell.js';

const shell = document.querySelector('#gallery-console');
const separator = document.querySelector('#gallery-separator');
const inspector = document.querySelector('#gallery-inspector');

if (shell && separator && inspector) {
  const splitter = createConsoleSplitter({ shell, separator, inspector });
  window.addEventListener('pagehide', () => splitter.destroy(), { once: true });
}
