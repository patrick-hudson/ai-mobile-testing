import { createSharedControlBrowserClient, SharedControlBrowserError } from './shared-control-client.js';

export function createConsoleSessionBanner({
  document = globalThis.document,
  shell,
  client = createSharedControlBrowserClient(),
  autoRestore = true,
  onAuthorized = async () => {},
  onStateChange = () => {},
} = {}) {
  if (!document || !shell?.workspace || typeof autoRestore !== 'boolean'
    || typeof onAuthorized !== 'function' || typeof onStateChange !== 'function') {
    throw new TypeError('Console session banner requires a shell and authorization callbacks.');
  }

  const banner = document.createElement('section');
  banner.className = 'console-session-banner';
  banner.dataset.consoleSessionBanner = '';
  banner.setAttribute('aria-live', 'assertive');
  banner.hidden = true;

  const summary = document.createElement('div');
  summary.className = 'console-session-summary';
  const title = document.createElement('strong');
  const message = document.createElement('span');
  summary.append(title, message);

  const authorize = document.createElement('button');
  authorize.type = 'button';
  authorize.className = 'console-button console-session-authorize';
  authorize.textContent = 'Authorize';

  const form = document.createElement('form');
  form.className = 'console-session-form';
  form.hidden = true;
  const label = document.createElement('label');
  label.textContent = 'Operator credential';
  const input = document.createElement('input');
  input.type = 'password';
  input.name = 'operator-credential';
  input.required = true;
  input.maxLength = 4_096;
  input.autocomplete = 'off';
  input.spellcheck = false;
  label.append(input);
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'console-button console-button-secondary';
  submit.textContent = 'Unlock console';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'console-button';
  cancel.textContent = 'Cancel';
  const formStatus = document.createElement('span');
  formStatus.className = 'console-session-form-status';
  formStatus.setAttribute('role', 'status');
  form.append(label, submit, cancel, formStatus);
  banner.append(summary, authorize, form);
  shell.workspace.insertBefore(banner, shell.header.nextSibling);

  let destroyed = false;
  let submitting = false;
  let authenticationController = null;

  authorize.addEventListener('click', openForm);
  cancel.addEventListener('click', closeForm);
  form.addEventListener('submit', submitCredential);

  if (autoRestore) void restore();

  function setState(state, detail = {}) {
    if (destroyed) return;
    banner.dataset.sessionState = state;
    onStateChange(Object.freeze({ state, ...detail }));
  }

  function requireAuthentication(error = {}) {
    if (destroyed || sharedControlDisabled(error)) return false;
    const expired = error?.code === 'SESSION_EXPIRED';
    title.textContent = expired ? 'Operator session expired' : 'Operator authorization required';
    message.textContent = expired
      ? 'This browser can no longer load protected console data. Authorize again to continue where you left off.'
      : 'Authorize this browser to load protected console data.';
    banner.hidden = false;
    setState(expired ? 'expired' : 'required', { error });
    return true;
  }

  async function restore() {
    const controller = beginAuthentication();
    try {
      const session = await client.restore({ signal: controller.signal });
      if (!authenticationCurrent(controller)) return;
      banner.hidden = true;
      setState('authorized', { session });
    } catch (error) {
      if (!authenticationCurrent(controller) || error?.name === 'AbortError') return;
      if (sharedControlDisabled(error)) {
        banner.hidden = true;
        setState('unavailable');
        return;
      }
      requireAuthentication(error);
    } finally {
      if (authenticationController === controller) authenticationController = null;
    }
  }

  function openForm() {
    form.hidden = false;
    authorize.hidden = true;
    formStatus.textContent = 'The credential is exchanged for an HttpOnly session and is not retained.';
    input.focus();
  }

  function closeForm() {
    input.value = '';
    form.hidden = true;
    authorize.hidden = false;
    formStatus.textContent = '';
    authorize.focus();
  }

  async function submitCredential(event) {
    event.preventDefault();
    if (submitting || !form.reportValidity()) return;
    submitting = true;
    submit.disabled = true;
    formStatus.textContent = 'Authorizing this browser…';
    const controller = beginAuthentication();
    let credential = input.value;
    input.value = '';
    try {
      const login = client.login(credential, { signal: controller.signal });
      credential = '';
      const session = await login;
      if (!authenticationCurrent(controller)) return;
      form.hidden = true;
      authorize.hidden = false;
      banner.hidden = true;
      setState('authorized', { session });
      try {
        await onAuthorized(session);
      } catch (error) {
        if (!authenticationCurrent(controller) || error?.name === 'AbortError') return;
        onStateChange(Object.freeze({ state: 'authorized', session, refreshError: error }));
      }
      if (authenticationCurrent(controller)) shell.heading?.focus();
    } catch (error) {
      credential = '';
      if (!authenticationCurrent(controller) || error?.name === 'AbortError') return;
      banner.hidden = false;
      form.hidden = false;
      authorize.hidden = true;
      formStatus.textContent = `Authorization failed: ${boundedMessage(error)}`;
      setState('required', { error });
      input.focus();
    } finally {
      submitting = false;
      submit.disabled = false;
      if (authenticationController === controller) authenticationController = null;
    }
  }

  function beginAuthentication() {
    authenticationController?.abort();
    const controller = new AbortController();
    authenticationController = controller;
    return controller;
  }

  function authenticationCurrent(controller) {
    return !destroyed && authenticationController === controller && !controller.signal.aborted;
  }

  return Object.freeze({
    element: banner,
    requireAuthentication,
    restore,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      authenticationController?.abort();
      authenticationController = null;
      input.value = '';
      authorize.removeEventListener('click', openForm);
      cancel.removeEventListener('click', closeForm);
      form.removeEventListener('submit', submitCredential);
      banner.remove();
    },
  });
}

function sharedControlDisabled(error) {
  return error instanceof SharedControlBrowserError
    && (error.status === 404 || (error.status === 503 && error.message === 'Shared control API is not enabled.'));
}

function boundedMessage(error) {
  return String(error?.message ?? 'Authorization could not be completed.').slice(0, 600);
}
