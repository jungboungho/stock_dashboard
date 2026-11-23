import { strFromU8, unzipSync } from 'fflate';

/** 시트 하나 = 셀 주소('A1') → 값 */
export type SheetCells = Record<string, string | number>;
export type Workbook = Record<string, SheetCells>;

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/**
 * .xlsx 를 브라우저 안에서 읽는다 (서버로 보내지 않음).
 * 수식 셀은 엑셀이 마지막으로 저장한 계산 결과(캐시 값)를 쓴다.
 */
export function readWorkbook(bytes: Uint8Array): Workbook {
  const files = unzipSync(bytes);
  const xml = (path: string) => {
    const f = files[path];
    if (!f) throw new Error(`엑셀 파일 구조를 읽을 수 없습니다 (${path} 없음)`);
    return new DOMParser().parseFromString(strFromU8(f), 'application/xml');
  };
  const text = (el: Element) => Array.from(el.getElementsByTagNameNS(MAIN, 't')).map((t) => t.textContent ?? '').join('');

  const shared: string[] = files['xl/sharedStrings.xml'] ? Array.from(xml('xl/sharedStrings.xml').getElementsByTagNameNS(MAIN, 'si')).map(text) : [];

  const rels = new Map<string, string>();
  for (const r of Array.from(xml('xl/_rels/workbook.xml.rels').getElementsByTagName('Relationship'))) {
    rels.set(r.getAttribute('Id')!, r.getAttribute('Target')!);
  }

  const book: Workbook = {};
  for (const s of Array.from(xml('xl/workbook.xml').getElementsByTagNameNS(MAIN, 'sheet'))) {
    const name = s.getAttribute('name')!;
    let target = rels.get(s.getAttributeNS(REL, 'id') ?? s.getAttribute('r:id') ?? '') ?? '';
    target = target.replace(/^\//, '');
    if (!target.startsWith('xl/')) target = `xl/${target}`;
    const cells: SheetCells = {};
    for (const c of Array.from(xml(target).getElementsByTagNameNS(MAIN, 'c'))) {
      const ref = c.getAttribute('r');
      if (!ref) continue;
      const t = c.getAttribute('t');
      const v = c.getElementsByTagNameNS(MAIN, 'v')[0]?.textContent ?? '';
      let value: string | number | undefined;
      if (t === 's') value = v === '' ? undefined : shared[Number(v)];
      else if (t === 'inlineStr') value = text(c);
      else if (t === 'str' || t === 'e') value = v || undefined;
      else if (t === 'b') value = v === '1' ? 1 : 0;
      else if (v !== '') value = Number(v);
      if (value !== undefined && value !== '') cells[ref] = value;
    }
    book[name] = cells;
  }
  return book;
}
