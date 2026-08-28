import { createConsoleNavigation, createConsoleSeparator } from './console-components.js';

const FOCUS_KEY_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,79}$/i;

export const CONSOLE_NAVIGATION_ITEMS = Object.freeze([
  Object.freeze({ id: 'overview', label: 'Overview', href: '/' }),
  Object.freeze({ id: 'runs', label: 'Runs', href: '/runs.html' }),
  Object.freeze({ id: 'findings', label: 'Findings', href: '/findings.html' }),
  Object.freeze({ id: 'evidence', label: 'Evidence', href: '/evidence.html' }),
  Object.freeze({ id: 'new-audit', label: 'New audit', href: '/new-audit.html' }),
  Object.freeze({ id: 'settings', label: 'Settings', href: '/settings.html' }),
]);

export function createFocusManager(root) {
  const targets = new Map();

  function register(key, target) {
    if (!FOCUS_KEY_PATTERN.test(String(key)) || !(target instanceof Element) || !root.contains(target)) {
      throw new TypeError('Focus targets need a safe key and an element inside the shell.');
    }
    targets.set(key, target);
    target.dataset.focusKey = key;
    return () => targets.delete(key);
  }

  function focus(key, fallback = null) {
    const target = FOCUS_KEY_PATTERN.test(String(key)) ? targets.get(key) : null;
    const resolved = target?.isConnected ? target : fallback?.isConnected ? fallback : null;
    resolved?.focus({ preventScroll: true });
    return Boolean(resolved);
  }

  function currentKey() {
    const active = root.ownerDocument.activeElement;
    return root.contains(active) && FOCUS_KEY_PATTERN.test(String(active?.dataset?.focusKey))
      ? active.dataset.focusKey
      : null;
  }

  return { register, focus, currentKey, destroy: () => targets.clear() };
}

export function createConsoleShell(root, {
  navigationItems,
  activeNavigationId,
  title,
  description,
  inspectorLabel = 'Context inspector',
}) {
  if (!(root instanceof Element) || root.childElementCount > 0) throw new TypeError('Console shell root must be an empty element.');
  const document = root.ownerDocument;
  root.className = 'console-shell';

  const skipLink = document.createElement('a');
  skipLink.className = 'console-skip-link';
  skipLink.href = '#console-main';
  skipLink.textContent = 'Skip to workspace';
  const navigation = createConsoleNavigation(document, { items: navigationItems, activeId: activeNavigationId });
  const workspace = document.createElement('div');
  workspace.className = 'console-workspace';
  const header = document.createElement('header');
  header.className = 'console-context-header';
  const heading = document.createElement('h1');
  heading.id = 'console-page-title';
  heading.tabIndex = -1;
  heading.textContent = title;
  const copy = document.createElement('p');
  copy.textContent = description;
  const headerActions = document.createElement('div');
  headerActions.className = 'console-context-actions';
  header.append(heading, copy, headerActions);
  const body = document.createElement('div');
  body.className = 'console-workspace-body';
  const main = document.createElement('main');
  main.id = 'console-main';
  main.className = 'console-main';
  main.setAttribute('aria-labelledby', heading.id);
  const inspector = document.createElement('aside');
  inspector.id = 'console-inspector';
  inspector.className = 'console-inspector';
  inspector.setAttribute('aria-label', inspectorLabel);
  const separator = createConsoleSeparator(document, { controls: inspector.id, valueMin: 240, valueMax: 560, valueNow: 320 });
  body.append(main, separator, inspector);
  workspace.append(header, body);
  root.append(skipLink, navigation, workspace);
  return { root, navigation, workspace, header, heading, headerActions, main, inspector, separator };
}

export function createConsoleSplitter({ shell, separator, inspector, initial = 320, minimum = 240, maximum = 560, onCommit }) {
  let value = clamp(initial);
  let dragging = false;

  function clamp(candidate) {
    return Math.max(minimum, Math.min(maximum, Math.round(Number(candidate) || minimum)));
  }

  function render(next, { commit = false } = {}) {
    value = clamp(next);
    shell.style.setProperty('--console-inspector-width', `${value}px`);
    separator.setAttribute('aria-valuenow', String(value));
    separator.setAttribute('aria-valuetext', `${value} pixels`);
    if (commit) onCommit?.(value);
    return value;
  }

  function pointerValue(event) {
    const bounds = shell.getBoundingClientRect();
    return bounds.right - event.clientX;
  }

  function onPointerDown(event) {
    if (event.button !== 0) return;
    dragging = true;
    separator.setPointerCapture?.(event.pointerId);
    render(pointerValue(event));
    event.preventDefault();
  }

  function onPointerMove(event) {
    if (dragging) render(pointerValue(event));
  }

  function onPointerUp(event) {
    if (!dragging) return;
    dragging = false;
    separator.releasePointerCapture?.(event.pointerId);
    render(value, { commit: true });
  }

  function onKeyDown(event) {
    const direction = getComputedStyle(shell).direction === 'rtl' ? -1 : 1;
    let next = null;
    if (event.key === 'ArrowLeft') next = value + (16 * direction);
    if (event.key === 'ArrowRight') next = value - (16 * direction);
    if (event.key === 'Home') next = minimum;
    if (event.key === 'End') next = maximum;
    if (next === null) return;
    event.preventDefault();
    render(next, { commit: true });
  }

  separator.addEventListener('pointerdown', onPointerDown);
  separator.addEventListener('pointermove', onPointerMove);
  separator.addEventListener('pointerup', onPointerUp);
  separator.addEventListener('pointercancel', onPointerUp);
  separator.addEventListener('keydown', onKeyDown);
  render(value);
  return {
    get value() { return value; },
    setValue: (next, options) => render(next, options),
    destroy() {
      separator.removeEventListener('pointerdown', onPointerDown);
      separator.removeEventListener('pointermove', onPointerMove);
      separator.removeEventListener('pointerup', onPointerUp);
      separator.removeEventListener('pointercancel', onPointerUp);
      separator.removeEventListener('keydown', onKeyDown);
      shell.style.removeProperty('--console-inspector-width');
    },
  };
}
