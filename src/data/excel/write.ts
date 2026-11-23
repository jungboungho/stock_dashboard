import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';

// ─────────────────────────────────────────────────────────────
// 원본 엑셀은 그대로 두고 지정한 시트만 새로 쓰거나 추가한다.
// 다른 시트 · 수식 · 서식은 손대지 않는다 (zip 안의 XML 몇 개만 고침).
// ─────────────────────────────────────────────────────────────

export type CellValue = string | number | null | undefined;

export interface SheetData {
  name: string;
  rows: CellValue[][];
  /** 열 너비 (문자 수) */
  widths?: number[];
}

const WS_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet';
const WS_CONTENT = 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const unesc = (s: string) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

function colName(n: number): string {
  let s = '';
  for (n += 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

export function sheetXml(sheet: SheetData): string {
  const rows = sheet.rows
    .map((cells, r) => {
      const cs = cells
        .map((v, c) => {
          const ref = `${colName(c)}${r + 1}`;
          if (v === null || v === undefined || v === '') return '';
          if (typeof v === 'number') return Number.isFinite(v) ? `<c r="${ref}"><v>${v}</v></c>` : '';
          return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
        })
        .join('');
      return `<row r="${r + 1}">${cs}</row>`;
    })
    .join('');
  const cols = sheet.widths?.length
    ? `<cols>${sheet.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`
    : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>${cols}<sheetData>${rows}</sheetData></worksheet>`;
}

const attr = (tag: string, name: string) => {
  const m = new RegExp(`\\s${name.replace(':', '\\:')}="([^"]*)"`).exec(tag);
  return m ? unesc(m[1]) : undefined;
};

/** xlsx 바이트에 시트들을 쓴다. 같은 이름이 있으면 내용을 바꾸고, 없으면 맨 뒤에 추가한다 */
export function upsertSheets(xlsx: Uint8Array, sheets: SheetData[]): Uint8Array {
  const files = unzipSync(xlsx) as Record<string, Uint8Array>;
  const read = (p: string) => {
    const f = files[p];
    if (!f) throw new Error(`엑셀 파일 구조를 읽지 못했습니다 (${p} 없음)`);
    return strFromU8(f);
  };
  let workbook = read('xl/workbook.xml');
  let rels = read('xl/_rels/workbook.xml.rels');
  let types = read('[Content_Types].xml');

  const relTargets = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(m[0], 'Id');
    const target = attr(m[0], 'Target');
    if (id && target) relTargets.set(id, target);
  }
  const sheetTags = [...workbook.matchAll(/<sheet\b[^>]*\/>/g)].map((m) => m[0]);
  let maxSheetId = Math.max(0, ...sheetTags.map((t) => Number(attr(t, 'sheetId')) || 0));
  let relN = Math.max(0, ...[...relTargets.keys()].map((id) => Number(/(\d+)$/.exec(id)?.[1]) || 0));
  let fileN = Math.max(0, ...Object.keys(files).map((p) => Number(/^xl\/worksheets\/sheet(\d+)\.xml$/.exec(p)?.[1]) || 0));

  for (const sheet of sheets) {
    const xml = strToU8(sheetXml(sheet));
    const existing = sheetTags.find((t) => attr(t, 'name') === sheet.name);
    const rid = existing ? attr(existing, 'r:id') : undefined;
    const target = rid ? relTargets.get(rid) : undefined;
    if (target) {
      const path = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
      files[path] = xml;
      continue;
    }
    fileN += 1;
    maxSheetId += 1;
    do relN += 1;
    while (relTargets.has(`rId${relN}`));
    const newRid = `rId${relN}`;
    files[`xl/worksheets/sheet${fileN}.xml`] = xml;
    rels = rels.replace('</Relationships>', `<Relationship Id="${newRid}" Type="${WS_TYPE}" Target="worksheets/sheet${fileN}.xml"/></Relationships>`);
    relTargets.set(newRid, `worksheets/sheet${fileN}.xml`);
    workbook = workbook.replace('</sheets>', `<sheet name="${esc(sheet.name)}" sheetId="${maxSheetId}" r:id="${newRid}"/></sheets>`);
    types = types.replace('</Types>', `<Override PartName="/xl/worksheets/sheet${fileN}.xml" ContentType="${WS_CONTENT}"/></Types>`);
  }

  files['xl/workbook.xml'] = strToU8(workbook);
  files['xl/_rels/workbook.xml.rels'] = strToU8(rels);
  files['[Content_Types].xml'] = strToU8(types);
  const zippable: Zippable = {};
  for (const [p, data] of Object.entries(files)) zippable[p] = [data, { level: 6 }];
  return zipSync(zippable);
}
