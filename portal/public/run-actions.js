function actionFromSnapshot(snapshot, actionId) {
  return snapshot?.actions?.find?.((entry) => entry.actionId === actionId) ?? null;
}

function sameBinding(binding, snapshot) {
  const action = actionFromSnapshot(snapshot, binding.actionId);
  return snapshot?.mode === binding.mode
    && snapshot?.runId === binding.runId
    && snapshot?.sourceRevision === binding.sourceRevision
    && snapshot?.authorityRevision === binding.authorityRevision
    && action?.available === true
    && action?.eligible === true
    && action?.authorized === true;
}

function safeMessage(error) {
  const message = typeof error?.message === 'string' ? error.message : 'The request did not return a result.';
  return message.replace(/sk-ant-[a-zA-Z0-9_-]+/gu, '[REDACTED]').slice(0, 500);
}

function freezeBindingValue(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freezeBindingValue));
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, freezeBindingValue(entry)])));
  }
  return value;
}

async function responseError(response) {
  const body = await response.json().catch(() => null);
  return typeof body?.error === 'string' ? body.error.slice(0, 500) : `Request failed (${response.status}).`;
}

export function createRunActionController({
  document,
  host,
  getSnapshot,
  validate,
  execute,
  reconcile,
  onAccepted,
  resolveFocus,
  announce,
} = {}) {
  if (!document || !(host instanceof Element) || typeof getSnapshot !== 'function' || typeof execute !== 'function') {
    throw new TypeError('Run actions require document, host, snapshot, and execution ports.');
  }
  const dialog = document.createElement('dialog');
  dialog.id = 'run-action-dialog';
  dialog.className = 'console-dialog run-action-dialog';
  const form = document.createElement('form');
  form.method = 'dialog';
  const title = document.createElement('h2');
  title.id = 'run-action-title';
  title.tabIndex = -1;
  const target = document.createElement('p');
  target.id = 'run-action-target';
  const consequence = document.createElement('p');
  consequence.id = 'run-action-consequence';
  const confirmationLabel = document.createElement('label');
  confirmationLabel.htmlFor = 'run-action-confirmation';
  const confirmationPrompt = document.createElement('span');
  const confirmation = document.createElement('input');
  confirmation.id = 'run-action-confirmation';
  confirmation.autocomplete = 'off';
  confirmation.spellcheck = false;
  confirmationLabel.append(confirmationPrompt, confirmation);
  const message = document.createElement('p');
  message.id = 'run-action-message';
  message.setAttribute('role', 'status');
  message.setAttribute('aria-live', 'polite');
  const controls = document.createElement('div');
  controls.className = 'console-dialog-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'Cancel';
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'console-button console-button-danger';
  submit.dataset.actionSubmit = '';
  controls.append(cancel, submit);
  form.append(title, target, consequence, confirmationLabel, message, controls);
  dialog.append(form);
  host.append(dialog);

  let current = null;
  let opener = null;
  let pending = false;
  let invalidated = false;
  let generation = 0;

  function renderAvailability() {
    const exact = current?.confirmation ?? null;
    const matches = exact === null || confirmation.value === exact;
    submit.disabled = pending || invalidated || !matches;
    confirmationLabel.hidden = exact === null;
  }

  function close() {
    if (pending) return;
    if (dialog.open) dialog.close();
  }

  function restoreFocus() {
    const binding = current;
    const equivalent = resolveFocus?.(binding, opener);
    const target = equivalent?.isConnected ? equivalent : opener?.isConnected ? opener : null;
    target?.focus({ preventScroll: true });
    opener = null;
    current = null;
    invalidated = false;
    pending = false;
  }

  function invalidate(reason = 'The displayed target or authority changed. Review the current run before trying again.') {
    if (!current || invalidated) return false;
    invalidated = true;
    generation += 1;
    message.textContent = reason;
    message.className = 'error-text';
    renderAvailability();
    announce?.(reason);
    return true;
  }

  function open(specification, invoker) {
    const snapshot = getSnapshot();
    const action = actionFromSnapshot(snapshot, specification.actionId);
    if (!action || action.available !== true || action.eligible !== true || action.authorized !== true) {
      announce?.(action?.unavailableReason ?? 'This action is not currently available.');
      return false;
    }
    generation += 1;
    current = Object.freeze({
      actionId: specification.actionId,
      label: specification.label,
      mode: snapshot.mode,
      runId: snapshot.runId,
      sourceRevision: snapshot.sourceRevision,
      authorityRevision: snapshot.authorityRevision,
      endpoint: specification.endpoint,
      method: specification.method,
      body: freezeBindingValue(specification.body),
      confirmation: specification.confirmation ?? null,
      reconcile: specification.reconcile ?? specification.actionId,
    });
    opener = invoker ?? document.activeElement;
    pending = false;
    invalidated = false;
    title.textContent = specification.label;
    target.textContent = `${snapshot.mode} run ${snapshot.runId}`;
    consequence.textContent = specification.consequence;
    confirmation.value = '';
    confirmationPrompt.textContent = current.confirmation ? `Type ${current.confirmation} exactly to continue` : '';
    submit.textContent = specification.submitLabel ?? specification.label;
    message.textContent = '';
    message.className = '';
    renderAvailability();
    dialog.showModal();
    (current.confirmation ? confirmation : title).focus();
    return true;
  }

  async function submitCurrent(event) {
    event.preventDefault();
    if (!current || pending || invalidated || !sameBinding(current, getSnapshot())) {
      invalidate();
      return;
    }
    if (current.confirmation !== null && confirmation.value !== current.confirmation) return;
    const binding = current;
    const requestGeneration = generation;
    pending = true;
    message.textContent = 'Revalidating the immutable target and current capability…';
    message.className = '';
    renderAvailability();
    let validated = true;
    try {
      validated = validate ? await validate(binding) === true : true;
    } catch (error) {
      if (requestGeneration !== generation || current !== binding) return;
      invalidated = true;
      message.textContent = `The action was not sent because current eligibility could not be revalidated. ${safeMessage(error)}`;
      message.className = 'error-text';
      announce?.(message.textContent);
      pending = false;
      renderAvailability();
      return;
    }
    try {
      if (!validated) {
        if (current === binding && requestGeneration === generation) invalidate();
        return;
      }
      if (requestGeneration !== generation || current !== binding || invalidated || !sameBinding(binding, getSnapshot())) return;
      message.textContent = 'Waiting for server acceptance…';
      const response = await execute(binding);
      if (requestGeneration !== generation || current !== binding) return;
      if (!response?.ok) {
        message.textContent = await responseError(response);
        message.className = 'error-text';
        invalidated = true;
        announce?.(`Action was not accepted. ${message.textContent}`);
        return;
      }
      message.textContent = 'The server accepted this action.';
      await onAccepted?.(binding, response);
      if (dialog.open) dialog.close();
    } catch (error) {
      if (requestGeneration !== generation || current !== binding) return;
      message.textContent = 'The response was lost. Checking authoritative run state without repeating the mutation…';
      try {
        const result = await reconcile?.(binding);
        if (requestGeneration !== generation || current !== binding) return;
        if (result === 'accepted') {
          message.textContent = 'Authoritative state confirms that the action was accepted.';
          await onAccepted?.(binding, null);
          if (dialog.open) dialog.close();
        } else {
          invalidated = true;
          message.textContent = result === 'not-accepted'
            ? 'Authoritative state does not show the requested effect. Review current eligibility before starting a new request.'
            : 'The result remains unknown. This request will not be repeated automatically.';
          message.className = 'error-text';
        }
      } catch (reconcileError) {
        invalidated = true;
        message.textContent = `The result remains unknown and was not retried. ${safeMessage(reconcileError)}`;
        message.className = 'error-text';
      }
    } finally {
      if (current === binding) {
        pending = false;
        renderAvailability();
      }
    }
  }

  confirmation.addEventListener('input', renderAvailability);
  cancel.addEventListener('click', close);
  form.addEventListener('submit', submitCurrent);
  dialog.addEventListener('close', restoreFocus);
  return Object.freeze({
    open,
    invalidate,
    get snapshot() { return Object.freeze({ binding: current, pending, invalidated, open: dialog.open }); },
    destroy() {
      generation += 1;
      confirmation.removeEventListener('input', renderAvailability);
      cancel.removeEventListener('click', close);
      form.removeEventListener('submit', submitCurrent);
      dialog.removeEventListener('close', restoreFocus);
      if (dialog.open) dialog.close();
      dialog.remove();
    },
  });
}
