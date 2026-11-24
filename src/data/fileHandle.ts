// ─────────────────────────────────────────────────────────────
// 엑셀 파일 핸들 (크롬 · 엣지의 File System Access)
//  - 새로고침해도 ③ 엑셀 업데이트가 같은 파일에 저장할 수 있게 IndexedDB 에 기억한다
//  - 쓰기 권한은 버튼을 누른 직후(사용자 동작 안)에만 요청할 수 있다
// ─────────────────────────────────────────────────────────────

export interface FileHandle {
  name: string;
  getFile(): Promise<File>;
  queryPermission?(o: { mode: 'readwrite' }): Promise<PermissionState>;
  requestPermission?(o: { mode: 'readwrite' }): Promise<PermissionState>;
  createWritable(): Promise<{ write(d: Blob | Uint8Array): Promise<void>; close(): Promise<void> }>;
}

type PickerOptions = { types: { description: string; accept: Record<string, string[]> }[] };
const win = window as unknown as {
  showOpenFilePicker?: (o: PickerOptions & { multiple: boolean }) => Promise<FileHandle[]>;
  showSaveFilePicker?: (o: PickerOptions & { suggestedName?: string }) => Promise<FileHandle>;
};
export const XLSX_TYPES: PickerOptions['types'] = [{ description: '엑셀', accept: { 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'] } }];
export const openPicker = win.showOpenFilePicker?.bind(window);
export const savePicker = win.showSaveFilePicker?.bind(window);

/**
 * 쓰기 권한 확인 → 없으면 요청 (크롬이 "이 파일 수정 허용?" 을 물음).
 * 버튼을 누른 뒤 다른 await 보다 먼저 불러야 한다 (사용자 동작이 지나면 요청이 거절됨).
 */
export async function ensureWritable(h: FileHandle): Promise<PermissionState> {
  if (!h.queryPermission || !h.requestPermission) return 'granted';
  const now = await h.queryPermission({ mode: 'readwrite' });
  if (now === 'granted') return now;
  return h.requestPermission({ mode: 'readwrite' });
}

// ─── IndexedDB 에 핸들 기억 ───
const DB = 'stock-dashboard';
const STORE = 'handles';
const KEY = 'excel';

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  try {
    return await new Promise<T>((resolve, reject) => {
      const r = run(d.transaction(STORE, mode).objectStore(STORE));
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  } finally {
    d.close();
  }
}

export async function rememberHandle(h: FileHandle | null): Promise<void> {
  try {
    await tx<unknown>('readwrite', (s) => (h ? s.put(h, KEY) : s.delete(KEY)) as IDBRequest<unknown>);
  } catch {
    /* 기억하지 못해도 이번 화면에서는 동작 */
  }
}

export async function recallHandle(): Promise<FileHandle | null> {
  try {
    return ((await tx('readonly', (s) => s.get(KEY))) as FileHandle | undefined) ?? null;
  } catch {
    return null;
  }
}

/** 예외를 사람이 읽을 이유로 */
export function writeErrorText(e: unknown): string {
  const name = (e as DOMException)?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return '브라우저가 이 파일에 쓰기 권한을 주지 않았습니다';
  if (name === 'NoModificationAllowedError' || name === 'InvalidModificationError') return '다른 프로그램(엑셀 등)이 파일을 열고 있거나 읽기 전용입니다';
  if (name === 'NotFoundError') return '파일이 옮겨졌거나 지워졌습니다';
  return e instanceof Error ? e.message : String(e);
}
