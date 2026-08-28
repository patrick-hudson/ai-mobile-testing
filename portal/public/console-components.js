function element(document, tagName, { className, text, attributes = {} } = {}) {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  for (const [name, value] of Object.entries(attributes)) {
    if (value !== undefined && value !== null) node.setAttribute(name, String(value));
  }
  return node;
}

export function createConsoleNavigation(document, { items, activeId }) {
  const navigation = element(document, 'nav', {
    className: 'console-navigation',
    attributes: { 'aria-label': 'Console' },
  });
  const identity = element(document, 'p', { className: 'console-product', text: 'AUDIT CONSOLE' });
  const list = element(document, 'ul', { className: 'console-navigation-list' });
  for (const item of items) {
    const listItem = document.createElement('li');
    const link = element(document, 'a', {
      text: item.label,
      attributes: { href: item.href, 'data-navigation-id': item.id },
    });
    if (item.id === activeId) link.setAttribute('aria-current', 'page');
    listItem.append(link);
    list.append(listItem);
  }
  navigation.append(identity, list);
  return navigation;
}

export function createAsyncStateBlock(document, { id, title }) {
  const section = element(document, 'section', {
    className: 'console-region',
    attributes: { id, 'aria-labelledby': `${id}-title`, 'aria-busy': 'false', 'data-async-state': 'initial-loading' },
  });
  const headingRow = element(document, 'div', { className: 'console-region-heading' });
  const heading = element(document, 'h2', { text: title, attributes: { id: `${id}-title`, tabindex: '-1', 'data-focus-key': `${id}-heading` } });
  const freshness = element(document, 'span', { className: 'console-freshness', text: 'Not loaded', attributes: { 'data-async-freshness': '' } });
  const status = element(document, 'p', { className: 'console-region-status', text: 'Waiting to load.', attributes: { role: 'status', 'aria-live': 'polite', 'data-async-status': '' } });
  const content = element(document, 'div', { className: 'console-region-content', attributes: { 'data-async-content': '' } });
  const retry = element(document, 'button', { className: 'console-button console-button-secondary', text: 'Retry', attributes: { type: 'button', hidden: '', 'data-async-retry': '' } });
  headingRow.append(heading, freshness);
  section.append(headingRow, status, content, retry);
  return { section, heading, freshness, status, content, retry };
}

export function createManualTabs(document, { id, label, tabs, onActivate }) {
  const container = element(document, 'section', { className: 'console-tabs' });
  const tabList = element(document, 'div', { className: 'console-tab-list', attributes: { role: 'tablist', 'aria-label': label } });
  const panels = new Map();
  const buttons = [];
  let activeId = tabs[0]?.id ?? null;

  for (const [index, tab] of tabs.entries()) {
    const button = element(document, 'button', {
      className: 'console-tab',
      text: tab.label,
      attributes: {
        id: `${id}-tab-${tab.id}`,
        type: 'button',
        role: 'tab',
        'aria-controls': `${id}-panel-${tab.id}`,
        'aria-selected': index === 0 ? 'true' : 'false',
        tabindex: index === 0 ? '0' : '-1',
        'data-tab-id': tab.id,
      },
    });
    const panel = element(document, 'div', {
      className: 'console-tab-panel',
      attributes: {
        id: `${id}-panel-${tab.id}`,
        role: 'tabpanel',
        'aria-labelledby': button.id,
        tabindex: '0',
        ...(index === 0 ? {} : { hidden: '' }),
      },
    });
    panel.textContent = tab.content ?? '';
    buttons.push(button);
    panels.set(tab.id, panel);
    tabList.append(button);
    container.append(panel);
  }
  container.prepend(tabList);

  function focusAt(index) {
    const button = buttons[(index + buttons.length) % buttons.length];
    buttons.forEach((entry) => entry.setAttribute('tabindex', entry === button ? '0' : '-1'));
    button?.focus();
  }

  async function activate(tabId) {
    if (!panels.has(tabId)) return false;
    activeId = tabId;
    for (const button of buttons) {
      const selected = button.dataset.tabId === tabId;
      button.setAttribute('aria-selected', selected ? 'true' : 'false');
      button.setAttribute('tabindex', selected ? '0' : '-1');
    }
    for (const [panelId, panel] of panels) panel.hidden = panelId !== tabId;
    await onActivate?.(tabId, panels.get(tabId));
    return true;
  }

  function onClick(event) {
    const button = event.target.closest('[role="tab"]');
    if (button && tabList.contains(button)) void activate(button.dataset.tabId);
  }

  function onKeyDown(event) {
    const current = buttons.indexOf(event.target);
    if (current < 0) return;
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft' || event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : current + (event.key === 'ArrowRight' ? 1 : -1);
      focusAt(next);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      void activate(event.target.dataset.tabId);
    }
  }

  tabList.addEventListener('click', onClick);
  tabList.addEventListener('keydown', onKeyDown);
  return {
    element: container,
    activate,
    get activeId() { return activeId; },
    destroy() {
      tabList.removeEventListener('click', onClick);
      tabList.removeEventListener('keydown', onKeyDown);
    },
  };
}

export function createConsoleDialog(document, { id, title, description }) {
  const dialog = element(document, 'dialog', { className: 'console-dialog', attributes: { id, 'aria-labelledby': `${id}-title` } });
  const heading = element(document, 'h2', { text: title, attributes: { id: `${id}-title`, tabindex: '-1' } });
  const copy = element(document, 'p', { text: description });
  const closeButton = element(document, 'button', { className: 'console-button', text: 'Close', attributes: { type: 'button' } });
  let opener = null;
  dialog.append(heading, copy, closeButton);

  function close() { dialog.close(); }
  function restoreFocus() {
    if (opener?.isConnected) opener.focus();
    opener = null;
  }
  closeButton.addEventListener('click', close);
  dialog.addEventListener('close', restoreFocus);
  return {
    element: dialog,
    closeButton,
    show(invoker) {
      opener = invoker ?? document.activeElement;
      dialog.showModal();
      heading.focus();
    },
    destroy() {
      closeButton.removeEventListener('click', close);
      dialog.removeEventListener('close', restoreFocus);
      if (dialog.open) dialog.close();
    },
  };
}

export function createConsoleSeparator(document, { controls, valueMin, valueMax, valueNow }) {
  return element(document, 'div', {
    className: 'console-separator',
    attributes: {
      role: 'separator',
      tabindex: '0',
      'aria-label': 'Resize inspector',
      'aria-orientation': 'vertical',
      'aria-controls': controls,
      'aria-valuemin': valueMin,
      'aria-valuemax': valueMax,
      'aria-valuenow': valueNow,
    },
  });
}
