"""NH PLUG Open API 연결 확인 (조회 전용).

토큰 발급 → 계좌 목록 → 계좌별 국내주식·해외주식·금현물 잔고, 최근 1년 입출금 건수를 조회하고
'어떤 계좌가 잡히는지 / 응답이 오는지'만 출력한다. 금액·키 값은 출력하지 않는다.

    python tools/nh_probe.py "C:/내/경로/credential.txt"

- 접근토큰은 local-data/nh_token.json 에 저장해 24시간 재사용한다 (재발급하면 NH 보안 알림이 감).
- 주문 API 는 호출하지 않는다.
"""
from __future__ import annotations

import datetime as dt
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

BASE = "https://api.nhplug.com:8443"
TOKEN_FILE = Path(__file__).resolve().parent.parent / "local-data" / "nh_token.json"
_last_call = 0.0


def read_credentials(path: str) -> tuple[str, str]:
    vals: dict[str, str] = {}
    for line in Path(path).read_text(encoding="utf-8-sig").splitlines():
        if ":" in line:
            k, v = line.split(":", 1)
            vals[k.strip().lower().replace(" ", "")] = v.strip()
    key, secret = vals.get("appkey"), vals.get("appsecret")
    if not key or not secret:
        sys.exit("credential 파일에서 'APP KEY' / 'APP Secret' 줄을 찾지 못했습니다.")
    return key, secret


def get_token(key: str, secret: str, force: bool = False) -> str:
    if not force and TOKEN_FILE.exists():
        cached = json.loads(TOKEN_FILE.read_text(encoding="utf-8"))
        if cached.get("expires_at", 0) > time.time() + 300:
            return cached["access_token"]
    q = urllib.parse.urlencode({"appkey": key, "appsecretkey": secret, "grant_type": "client_credentials", "scope": "oob"})
    req = urllib.request.Request(f"{BASE}/oauth2/token?{q}", data=b"", method="POST", headers={"Content-Type": "application/x-www-form-urlencoded"})
    with urllib.request.urlopen(req, timeout=20) as r:
        body = json.load(r)
    token = body["access_token"]
    TOKEN_FILE.parent.mkdir(exist_ok=True)
    TOKEN_FILE.write_text(json.dumps({"access_token": token, "expires_at": time.time() + int(body.get("expires_in", 86400))}), encoding="utf-8")
    print("· 접근토큰 새로 발급 (NH 보안 알림이 갈 수 있음)")
    return token


def call(token: str, path: str, inp: dict) -> dict:
    global _last_call
    wait = 0.25 - (time.time() - _last_call)  # 초당 5건 제한
    if wait > 0:
        time.sleep(wait)
    _last_call = time.time()
    req = urllib.request.Request(
        f"{BASE}{path}",
        data=json.dumps({"Input_0": inp}).encode(),
        method="POST",
        headers={"Content-Type": "application/json; charset=utf-8", "Authorization": f"Bearer {token}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        return {"rsp_cd": f"HTTP{e.code}", "rsp_msg": e.read().decode("utf-8", "replace")[:200]}


def rows(resp: dict, block: str) -> list:
    v = resp.get(block)
    return v if isinstance(v, list) else ([v] if isinstance(v, dict) else [])


def mask(acct: str) -> str:
    return "*" * max(0, len(acct) - 4) + acct[-4:]


def main() -> None:
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    key, secret = read_credentials(sys.argv[1])
    token = get_token(key, secret)

    info = call(token, "/n2/acctinfo", {})
    if str(info.get("rsp_cd", "")).startswith("HTTP401"):
        token = get_token(key, secret, force=True)
        info = call(token, "/n2/acctinfo", {})
    accts = rows(info, "Output_0")
    print(f"계좌 목록: {len(accts)}개 · {info.get('rsp_msg', '')}")
    today = dt.date.today()
    year_ago = today - dt.timedelta(days=365)

    for a in accts:
        no, typ = a.get("acct_no", ""), a.get("acct_type", "")
        print(f"\n■ {mask(no)} (구분 {typ})")
        if typ not in ("01", "02"):
            print("  운영 계좌가 아니라 건너뜀")
            continue
        kr = call(token, "/krstock/inquiry/v1/balance", {"act_no": no, "bnc_bse_cd": "1", "ltg_aot_dit_cd": "9", "aet_bse": "2", "qut_dit_cd": "UNT", "aly_qut_cd": "1"})
        kr0 = rows(kr, "Output_0")
        print(f"  국내주식 잔고: 종목 {len(rows(kr, 'Output_1'))}개 · 합계블록 {'있음' if kr0 else '없음'} · 계좌상품: {kr0[0].get('cfd_pdt_tp_nm', '').strip() if kr0 else '-'} · {kr.get('rsp_msg', '')}")
        gb = call(token, "/gbstock/inquiry/v1/balance", {"act_no": no, "qut_iqr_dit_cd": "9", "fc_sec_trd_nat_cd": "200", "cur_cd": "KRW", "xns_dit_cd": "0"})
        print(f"  해외주식(미국) 잔고: 종목 {len(rows(gb, 'Output_1'))}개 · {gb.get('rsp_msg', '')}")
        au = call(token, "/krgold/inquiry/v1/goldDepositAndBalance", {"act_no": no})
        print(f"  금현물 잔고: 종목 {len(rows(au, 'Output_1'))}개 · {au.get('rsp_msg', '')}")
        dw = call(token, "/common/inquiry/v1/depositWithdrawal", {"iqr_tp_cd": "1", "act_no": no, "iqr_sta_dt": year_ago.strftime("%Y%m%d"), "iqr_end_dt": today.strftime("%Y%m%d"), "act_trd_dtl_cd": "01"})
        print(f"  최근 1년 입출금: {len(rows(dw, 'Output_0'))}건(첫 페이지) · {dw.get('rsp_msg', '')}")


if __name__ == "__main__":
    main()
