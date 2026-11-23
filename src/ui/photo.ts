import type { PhotoResult, PhotoRow } from '../data/photo';
import { photoTotal } from '../data/photo';
import { escapeHtml } from '../format';

// ─────────────────────────────────────────────────────────────
// 계좌 화면 캡처 → 글자 인식(OCR) → 확인 화면.
// 사진은 이 브라우저 안에서만 읽는다 (서버로 보내지 않음).
// 글자 인식 엔진 · 한글 데이터는 처음 한 번 CDN 에서 내려받아 브라우저에 저장된다.
// ─────────────────────────────────────────────────────────────

type Worker = { recognize(img: File): Promise<{ data: { text: string } }> };
let workerPromise: Promise<Worker> | null = null;

export async function recognizeImages(files: File[], onProgress: (msg: string) => void): Promise<string[]> {
  if (!workerPromise) {
    onProgress('글자 인식 준비 중… (처음 한 번은 한글 인식 데이터를 내려받아 조금 걸립니다)');
    workerPromise = import('tesseract.js').then((m) => m.createWorker(['kor', 'eng']) as unknown as Promise<Worker>);
    workerPromise.catch(() => (workerPromise = null));
  }
  const worker = await workerPromise;
  const out: string[] = [];
  for (const [i, f] of files.entries()) {
    onProgress(`사진 읽는 중… ${i + 1} / ${files.length}`);
    out.push((await worker.recognize(f)).data.text);
  }
  return out;
}

const won = (n: number | null) => (n === null ? '' : String(Math.round(n)));
const fmt = (n: number) => `${Math.round(n).toLocaleString('ko-KR')}원`;

export interface ReviewedAccount {
  account: string;
  rows: PhotoRow[];
  cashKRW: number | null;
  cashUSD: number | null;
}

/** 읽은 결과를 표로 보여주고, 고친 값으로 onApply. 계좌를 고르지 않은 화면은 건너뛴다 */
export function openPhotoReview(results: PhotoResult[], accounts: string[], usdKrw: number, onApply: (list: ReviewedAccount[]) => void): void {
  let dlg = document.getElementById('photo-dialog') as HTMLDialogElement | null;
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'photo-dialog';
    dlg.className = 'dialog wide';
    document.body.appendChild(dlg);
  }
  const matchLabel: Record<string, string> = { name: '이름', quantity: '수량', value: '금액' };
  const rowHtml = (r: PhotoRow, si: number, ri: number) => `<tr data-s="${si}" data-r="${ri}">
      <td><input name="name" value="${escapeHtml(r.name)}" aria-label="종목 이름" />${r.ocrName && r.ocrName !== r.name ? `<small class="ocr" title="사진에서 읽은 글자">읽은 글자: ${escapeHtml(r.ocrName)}</small>` : ''}</td>
      <td><input name="code" value="${escapeHtml(r.code)}" aria-label="종목코드" class="code-in" /></td>
      <td><input name="quantity" inputmode="decimal" value="${r.quantity ?? ''}" aria-label="수량" class="num" /></td>
      <td><input name="value" inputmode="numeric" value="${won(r.value)}" aria-label="평가금 (원)" class="num" /></td>
      <td><input name="pnl" inputmode="numeric" value="${won(r.pnl)}" aria-label="평가손익 (원)" class="num" placeholder="모름" /></td>
      <td>${r.matched ? `<span class="chip" title="지금 보유 종목과 ${matchLabel[r.matched]}(으)로 맞춤">${matchLabel[r.matched]}</span>` : '<span class="chip warn">새 종목</span>'}</td>
      <td><button type="button" class="mini danger" data-del aria-label="이 줄 빼기">✕</button></td>
    </tr>`;
  const section = (res: PhotoResult, si: number) => {
    const sum = photoTotal(res.rows, res.cashKRW, res.cashUSD, usdKrw);
    const ok = res.total !== null && Math.abs(sum - res.total) <= Math.max(1000, res.total * 0.002);
    return `<section class="photo-sec" data-s="${si}">
      <div class="photo-head">
        <label class="field inline"><span>계좌</span><select name="account">
          <option value="">— 고르세요 (건너뜀) —</option>
          ${accounts.map((a) => `<option value="${escapeHtml(a)}" ${a === res.account ? 'selected' : ''}>${escapeHtml(a)}</option>`).join('')}
        </select></label>
        <span class="hint">화면 총액 ${res.total !== null ? fmt(res.total) : '못 읽음'} · 읽은 합계 <b class="sum">${fmt(sum)}</b>
          <span class="chip ${ok ? 'ok' : 'warn'} check">${ok ? '일치' : '확인 필요'}</span></span>
      </div>
      <div class="table-wrap"><table class="data photo-table">
        <thead><tr><th class="left">종목</th><th class="left">코드</th><th>수량</th><th>평가금(원)</th><th>평가손익(원)</th><th></th><th></th></tr></thead>
        <tbody>${res.rows.map((r, ri) => rowHtml(r, si, ri)).join('')}</tbody>
      </table></div>
      <div class="photo-foot">
        <button type="button" class="btn" data-add="${si}">+ 줄 추가</button>
        <label class="field inline"><span>현금(원)</span><input name="cashKRW" inputmode="numeric" class="num" value="${won(res.cashKRW)}" /></label>
        <label class="field inline"><span>달러($)</span><input name="cashUSD" inputmode="decimal" class="num" value="${res.cashUSD ?? ''}" /></label>
      </div>
    </section>`;
  };

  dlg.innerHTML = `<form method="dialog" class="dialog-form" novalidate>
      <h3>사진으로 계좌 업데이트 — 확인</h3>
      <p class="hint">사진에서 읽은 값입니다. 틀린 칸은 고쳐 주세요. 적용하면 고른 계좌의 종목 · 현금을 이 값으로 <b>통째로 바꿉니다</b>. 평가손익이 빈 종목은 예전 매입금액을 유지합니다.</p>
      ${results.map(section).join('')}
      <p class="form-error" role="alert"></p>
      <div class="dialog-actions">
        <button type="button" class="btn" value="cancel">취소</button>
        <button type="submit" class="btn primary">적용</button>
      </div>
    </form>`;
  const form = dlg.querySelector('form')!;
  const err = dlg.querySelector<HTMLElement>('.form-error')!;
  const num = (v: string) => {
    const t = v.replace(/[,\s원$]/g, '');
    if (!t) return null;
    const n = Number(t);
    if (!Number.isFinite(n)) throw new Error(`숫자가 아닙니다: ${v}`);
    return n;
  };
  const read = (si: number): ReviewedAccount => {
    const sec = form.querySelector<HTMLElement>(`section[data-s="${si}"]`)!;
    const rows: PhotoRow[] = [...sec.querySelectorAll<HTMLTableRowElement>('tbody tr')].map((tr) => {
      const v = (n: string) => tr.querySelector<HTMLInputElement>(`input[name="${n}"]`)!.value;
      const orig = results[si].rows[Number(tr.dataset.r)];
      const code = v('code').trim().toUpperCase();
      return {
        name: v('name').trim(),
        code,
        currency: orig && orig.code === code ? orig.currency : /^[A-Z.]{1,6}$/.test(code) ? 'USD' : 'KRW',
        quantity: num(v('quantity')),
        value: num(v('value')),
        pnl: num(v('pnl')),
        ocrName: orig?.ocrName ?? '',
        matched: orig?.matched ?? null,
      };
    });
    const g = (n: string) => num(sec.querySelector<HTMLInputElement>(`input[name="${n}"]`)!.value);
    return { account: sec.querySelector<HTMLSelectElement>('select[name="account"]')!.value, rows, cashKRW: g('cashKRW'), cashUSD: g('cashUSD') };
  };
  const refresh = (si: number) => {
    try {
      const r = read(si);
      const sec = form.querySelector<HTMLElement>(`section[data-s="${si}"]`)!;
      const sum = photoTotal(r.rows, r.cashKRW, r.cashUSD, usdKrw);
      const total = results[si].total;
      const ok = total !== null && Math.abs(sum - total) <= Math.max(1000, total * 0.002);
      sec.querySelector('.sum')!.textContent = fmt(sum);
      const chip = sec.querySelector('.check')!;
      chip.textContent = ok ? '일치' : '확인 필요';
      chip.className = `chip ${ok ? 'ok' : 'warn'} check`;
    } catch {
      /* 숫자 입력 중 */
    }
  };
  form.oninput = (e) => {
    const sec = (e.target as HTMLElement).closest<HTMLElement>('section[data-s]');
    if (sec) refresh(Number(sec.dataset.s));
  };
  form.onclick = (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('[data-del]')) {
      const tr = t.closest('tr')!;
      const si = Number(tr.dataset.s);
      tr.remove();
      refresh(si);
    }
    const add = t.closest<HTMLElement>('[data-add]');
    if (add) {
      const si = Number(add.dataset.add);
      const body = form.querySelector(`section[data-s="${si}"] tbody`)!;
      body.insertAdjacentHTML('beforeend', rowHtml({ name: '', code: '', currency: 'KRW', quantity: null, value: null, pnl: null, ocrName: '', matched: null }, si, -1));
    }
  };
  dlg.querySelector<HTMLButtonElement>('button[value="cancel"]')!.onclick = () => dlg!.close();
  form.onsubmit = (e) => {
    e.preventDefault();
    try {
      const list = results.map((_, si) => read(si)).filter((r) => r.account);
      if (!list.length) throw new Error('적용할 계좌를 하나 이상 고르세요');
      const dup = list.map((r) => r.account).find((a, i, all) => all.indexOf(a) !== i);
      if (dup) throw new Error(`'${dup}' 계좌가 두 번 골라졌습니다. 사진마다 다른 계좌를 고르세요`);
      for (const r of list) {
        for (const row of r.rows) {
          if (!row.name) throw new Error(`${r.account}: 종목 이름이 빈 줄이 있습니다 (필요 없으면 ✕로 빼세요)`);
          if (!(row.quantity && row.quantity > 0) || !(row.value && row.value > 0)) throw new Error(`${r.account} · ${row.name}: 수량과 평가금을 확인하세요`);
        }
      }
      onApply(list);
      dlg!.close();
    } catch (ex) {
      err.textContent = ex instanceof Error ? ex.message : String(ex);
    }
  };
  dlg.showModal();
}
