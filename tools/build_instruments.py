"""NH 투자증권 국내주식 종목 마스터(m_new_stock.mst, 공개 · 인증 불필요) → public/instruments.json

대시보드의 '사진으로 계좌 업데이트'가 종목 이름 앞부분으로 종목명 · 코드를 찾을 때 쓴다.
종목이 새로 상장되면 다시 실행해서 커밋하면 된다.

    python tools/build_instruments.py
"""
import json
import urllib.request
from pathlib import Path

URL = "https://www.nhplug.com/instruments/m_new_stock.mst"
REC = 237  # m_new_stock.h 의 @record (sCode 6, sMarket 1, sKorName 41 …)
OUT = Path(__file__).resolve().parent.parent / "public" / "instruments.json"


def main() -> None:
    data = urllib.request.urlopen(URL, timeout=60).read()
    if len(data) % REC:
        raise SystemExit(f"파일 크기({len(data)})가 레코드 크기({REC})로 나누어떨어지지 않습니다 — 구조가 바뀌었는지 m_new_stock.h 를 확인하세요")
    items = {}
    for i in range(0, len(data), REC):
        r = data[i : i + REC]
        code = r[0:6].decode("ascii", "replace").strip()
        # 한글종목명 첫 글자는 지수 표시(* KOSPI200 / # 코스닥150)일 수 있다
        name = r[7:48].decode("cp949", "replace").strip().lstrip("*#").strip()
        if code and name:
            items[code] = name
    rows = sorted(([c, n] for c, n in items.items()), key=lambda x: x[1])
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps({"source": URL, "count": len(rows), "items": rows}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{OUT} · {len(rows)}종목 · {OUT.stat().st_size // 1024}KB")


if __name__ == "__main__":
    main()
