// Small helpers shared by the app's screens.
export const $ = (id) => document.getElementById(id);

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** localStorage that never throws (private windows, blocked storage). */
export const safeStorage = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  getJSON(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } },
  setJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
};

/**
 * Turn a form into a nested object. Names like "highSchool.name" become nested keys.
 * Checkbox groups whose name ends in [] become arrays. Empty strings become null.
 * Inputs with data-type="number" become numbers; data-type="bool" checkboxes become booleans.
 */
export function formToObject(form) {
  const out = {};
  const set = (path, value) => {
    const keys = path.split('.');
    let o = out;
    keys.slice(0, -1).forEach((k) => { o[k] = o[k] || {}; o = o[k]; });
    o[keys[keys.length - 1]] = value;
  };
  for (const el of form.elements) {
    if (!el.name || el.disabled) continue;
    if (el.name.endsWith('[]')) {
      const name = el.name.slice(0, -2);
      const current = name.split('.').reduce((o, k) => (o ? o[k] : undefined), out) || [];
      if (el.checked) current.push(el.value);
      set(name, current);
      continue;
    }
    if (el.type === 'checkbox') { set(el.name, el.checked); continue; }
    if (el.type === 'radio') { if (el.checked) set(el.name, el.value); continue; }
    let v = el.value.trim();
    if (v === '') v = null;
    else if (el.dataset.type === 'number') v = Number(v);
    set(el.name, v);
  }
  return out;
}

export function options(list, selected, { blank } = {}) {
  const items = list.map((o) => (typeof o === 'object' ? o : { value: o, label: o }));
  return (blank !== undefined ? `<option value="">${esc(blank)}</option>` : '')
    + items.map((o) => `<option value="${esc(o.value)}"${String(o.value) === String(selected ?? '') ? ' selected' : ''}>${esc(o.label)}</option>`).join('');
}

export const fmtDate = (d, opts = { month: 'short', day: 'numeric' }) => (d ? new Date(d).toLocaleDateString('en-US', opts) : '');

/** "Nov 25", or "Nov 25, 2027" when the date isn't in the current year. */
export const fmtDay = (d) => {
  if (!d) return '';
  const date = new Date(d);
  return date.toLocaleDateString('en-US', date.getFullYear() === new Date().getFullYear()
    ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
};

export const money = (cents, { decimals = false } = {}) => (cents == null ? '' : (cents / 100).toLocaleString('en-US', {
  style: 'currency', currency: 'USD', minimumFractionDigits: decimals ? 2 : 0, maximumFractionDigits: decimals ? 2 : 0,
}));

/** Read an error from a callable into a friendly sentence. */
export const errorText = (e, fallback = 'Something went wrong. Try again.') => (e && e.message && !/^internal$/i.test(e.message) ? e.message : fallback);
