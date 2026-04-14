/* ui-toast.js — global toast notifications (success/error/info) */
/* global window, document */

(function () {
  const CONTAINER_ID = 'sh-toast-container';
  const TOAST_ID = 'sh-toast';

  function ensureToastDom() {
    let container = document.getElementById(CONTAINER_ID);
    if (!container) {
      container = document.createElement('div');
      container.id = CONTAINER_ID;
      container.className = 'sh-toast-container';
      document.body.appendChild(container);
    }

    let toast = document.getElementById(TOAST_ID);
    if (!toast) {
      toast = document.createElement('div');
      toast.id = TOAST_ID;
      toast.className = 'sh-toast';
      toast.setAttribute('role', 'status');
      toast.setAttribute('aria-live', 'polite');
      toast.setAttribute('aria-atomic', 'true');
      container.appendChild(toast);
    }

    return toast;
  }

  function show(type, message, opts) {
    const options = opts || {};
    const durationMs = Number.isFinite(options.durationMs) ? options.durationMs : 4500;

    const toast = ensureToastDom();
    toast.className = `sh-toast sh-toast--${type} sh-toast--visible`;
    toast.textContent = String(message || '');

    // Errors should announce immediately; success/info can be polite.
    toast.setAttribute('aria-live', type === 'error' ? 'assertive' : 'polite');

    if (toast._timer) window.clearTimeout(toast._timer);
    toast._timer = window.setTimeout(() => {
      toast.classList.remove('sh-toast--visible');
    }, durationMs);
  }

  window.toast = window.toast || {};
  window.toast.success = (message, opts) => show('success', message, opts);
  window.toast.error = (message, opts) => show('error', message, opts);
  window.toast.info = (message, opts) => show('info', message, opts);
})();

