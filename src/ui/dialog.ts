import { escapeHtml } from '../format';

export interface Field {
  name: string;
  label: string;
  type?: 'text' | 'number' | 'select';
  value?: string | number | null;
  options?: { value: string; label: string }[];
  step?: string;
  placeholder?: string;
  hint?: string;
  required?: boolean;
}

export interface FormOptions {
  title: string;
  description?: string;
  fields: Field[];
  submitLabel?: string;
  danger?: boolean;
  /** 값 검사 · 저장. 예외를 던지면 메시지를 보여주고 창을 닫지 않는다 */
  onSubmit: (values: Record<string, string>) => void;
}

function ensureDialog(): HTMLDialogElement {
  let dlg = document.getElementById('app-dialog') as HTMLDialogElement | null;
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'app-dialog';
    dlg.className = 'dialog';
    document.body.appendChild(dlg);
  }
  return dlg;
}

export function openForm(opts: FormOptions): void {
  const dlg = ensureDialog();
  const field = (f: Field) => {
    const id = `f-${f.name}`;
    const common = `id="${id}" name="${escapeHtml(f.name)}" ${f.required ? 'required' : ''}`;
    let input: string;
    if (f.type === 'select') {
      input = `<select ${common}>${(f.options ?? [])
        .map((o) => `<option value="${escapeHtml(o.value)}" ${String(f.value ?? '') === o.value ? 'selected' : ''}>${escapeHtml(o.label)}</option>`)
        .join('')}</select>`;
    } else {
      input = `<input ${common} type="${f.type === 'number' ? 'number' : 'text'}" ${f.step ? `step="${f.step}"` : ''} value="${escapeHtml(String(f.value ?? ''))}" placeholder="${escapeHtml(f.placeholder ?? '')}" autocomplete="off" />`;
    }
    return `<label class="field" for="${id}"><span>${escapeHtml(f.label)}</span>${input}${f.hint ? `<small>${escapeHtml(f.hint)}</small>` : ''}</label>`;
  };
  dlg.innerHTML = `<form method="dialog" class="dialog-form" novalidate>
      <h3>${escapeHtml(opts.title)}</h3>
      ${opts.description ? `<p class="hint">${escapeHtml(opts.description)}</p>` : ''}
      ${opts.fields.map(field).join('')}
      <p class="form-error" role="alert"></p>
      <div class="dialog-actions">
        <button type="button" class="btn" value="cancel">취소</button>
        <button type="submit" class="btn ${opts.danger ? 'danger' : 'primary'}">${escapeHtml(opts.submitLabel ?? '저장')}</button>
      </div>
    </form>`;
  const form = dlg.querySelector('form')!;
  const err = dlg.querySelector<HTMLElement>('.form-error')!;
  dlg.querySelector<HTMLButtonElement>('button[value="cancel"]')!.onclick = () => dlg.close();
  form.onsubmit = (e) => {
    e.preventDefault();
    const values = Object.fromEntries(new FormData(form).entries()) as Record<string, string>;
    try {
      opts.onSubmit(values);
      dlg.close();
    } catch (ex) {
      err.textContent = ex instanceof Error ? ex.message : String(ex);
    }
  };
  dlg.showModal();
  (dlg.querySelector('input, select') as HTMLElement | null)?.focus();
}

export function openConfirm(title: string, message: string, confirmLabel: string, onConfirm: () => void): void {
  openForm({ title, description: message, fields: [], submitLabel: confirmLabel, danger: true, onSubmit: onConfirm });
}

/** '1,234.5' 같은 입력을 숫자로. 비어 있으면 null */
export function parseNumber(v: string | undefined): number | null {
  if (v === undefined) return null;
  const t = v.replace(/,/g, '').trim();
  if (t === '') return null;
  const n = Number(t);
  if (!Number.isFinite(n)) throw new Error(`숫자가 아닙니다: ${v}`);
  return n;
}
