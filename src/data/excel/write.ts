import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';

// ─────────────────────────────────────────────────────────────
// 원본 엑셀은 그대로 두고 지정한 시트만 새로 쓰거나 추가한다.
// 다른 시트 · 수식 · 서식은 손대지 않는다 (zip 안의 XML 몇 개만 고침).
// ─────────────────────────────────────────────────────────────

export type CellValue = string | number | null | undefined;

export interface SheetData {
  name: string;
  /** 이 이름의 시트가 있고 name 시트가 없으면 이름을 바꿔서 쓴다 (위치 유지) */
  renameFrom?: string;
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

/** 기존 시트의 칸 하나에 수식 + 계산된 값을 넣는다 */
export interface CellUpdate {
  ref: string;
  formula: string;
  value: number | string;
}

const colNum = (ref: string) => [.../^[A-Z]+/.exec(ref)![0]].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);

/** 시트 XML 의 칸들을 바꾼다. 서식(s)은 유지, 공유 수식의 기준 칸은 건드리지 않는다 */
export function applyCells(xml: string, cells: CellUpdate[]): { xml: string; applied: string[] } {
  const applied: string[] = [];
  for (const c of cells) {
    const num = typeof c.value === 'number' && Number.isFinite(c.value);
    const body = `<f>${esc(c.formula)}</f><v>${num ? c.value : esc(String(c.value))}</v>`;
    const tAttr = num ? '' : ' t="str"';
    const m = new RegExp(`<c r="${c.ref}"(\\s[^>]*?)?(?:/>|>([\\s\\S]*?)</c>)`).exec(xml);
    if (m) {
      if (/<f\b[^>]*\bref="/.test(m[2] ?? '')) continue;
      const style = /\ss="\d+"/.exec(m[1] ?? '')?.[0] ?? '';
      xml = xml.slice(0, m.index) + `<c r="${c.ref}"${style}${tAttr}>${body}</c>` + xml.slice(m.index + m[0].length);
      applied.push(c.ref);
      continue;
    }
    const rowNo = /\d+$/.exec(c.ref)![0];
    const rm = new RegExp(`<row r="${rowNo}"([^>]*?)(/>|>([\\s\\S]*?)</row>)`).exec(xml);
    if (!rm) continue;
    const inner = rm[3] ?? '';
    const cellTags = [...inner.matchAll(/<c r="([A-Z]+\d+)"[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g)];
    const after = cellTags.find((t) => colNum(t[1]) > colNum(c.ref));
    const newCell = `<c r="${c.ref}"${tAttr}>${body}</c>`;
    const newInner = after ? inner.slice(0, after.index) + newCell + inner.slice(after.index) : inner + newCell;
    const attrs = rm[1].replace(/\/$/, '');
    xml = xml.slice(0, rm.index) + `<row r="${rowNo}"${attrs}>${newInner}</row>` + xml.slice(rm.index + rm[0].length);
    applied.push(c.ref);
  }
  return { xml, applied };
}

/**
 * xlsx 바이트에 시트들을 쓴다. 같은 이름이 있으면 내용을 바꾸고, 없으면 맨 뒤에 추가한다.
 * cells 를 주면 기존 시트(예: Summary)의 칸에 수식을 넣고, 엑셀이 열 때 다시 계산하게 한다.
 */
export function upsertSheets(xlsx: Uint8Array, sheets: SheetData[], cells?: { sheet: string; updates: CellUpdate[] }): Uint8Array {
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

  const pathOf = (target: string) => (target.startsWith('/') ? target.slice(1) : `xl/${target}`);
  for (const sheet of sheets) {
    const xml = strToU8(sheetXml(sheet));
    let existing = sheetTags.find((t) => attr(t, 'name') === sheet.name);
    if (!existing && sheet.renameFrom) {
      const old = sheetTags.find((t) => attr(t, 'name') === sheet.renameFrom);
      if (old) {
        const renamed = old.replace(/\sname="[^"]*"/, ` name="${esc(sheet.name)}"`);
        workbook = workbook.replace(old, renamed);
        sheetTags[sheetTags.indexOf(old)] = renamed;
        existing = renamed;
      }
    }
    const rid = existing ? attr(existing, 'r:id') : undefined;
    const target = rid ? relTargets.get(rid) : undefined;
    if (target) {
      files[pathOf(target)] = xml;
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

  if (cells?.updates.length) {
    const tag = sheetTags.find((t) => attr(t, 'name') === cells.sheet);
    const target = tag ? relTargets.get(attr(tag, 'r:id') ?? '') : undefined;
    if (target && files[pathOf(target)]) {
      files[pathOf(target)] = strToU8(applyCells(strFromU8(files[pathOf(target)]), cells.updates).xml);
      // 열 때 모든 수식을 다시 계산 (Summary 의 다른 수식도 새 기말자산을 반영)
      workbook = /<calcPr\b/.test(workbook)
        ? workbook.replace(/<calcPr\b([^>]*?)(\s*\/?>)/, (_m, a: string, end: string) => `<calcPr${a.replace(/\sfullCalcOnLoad="[^"]*"/, '')} fullCalcOnLoad="1"${end}`)
        : workbook;
    }
  }

  files['xl/workbook.xml'] = strToU8(workbook);
  files['xl/_rels/workbook.xml.rels'] = strToU8(rels);
  files['[Content_Types].xml'] = strToU8(types);
  const zippable: Zippable = {};
  for (const [p, data] of Object.entries(files)) zippable[p] = [data, { level: 6 }];
  return zipSync(zippable);
}
