#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
餐饮日报 · 每日行业情报采集与要点提炼

用法:
    python daily.py                     # 采集并生成今日日报
    python daily.py --date 2026-09-21   # 指定日期（写文件用）
    python daily.py --fast              # 跳过正文抓取，只跑列表（快，要点会少）
    python daily.py --only hongcan,jiemian
    python daily.py --llm               # 启用大模型润色（需 LLM_API_KEY 等环境变量）
    python daily.py --serve             # 采集后在本地起一个预览服务

设计约束:
    1. 只用 Python 标准库，无需 pip 安装任何依赖。
    2. 采集失败不中断整体流程，单个源失败只记录警告。
    3. 没有大模型 key 时，用规则式提炼，绝不伪造模型输出。
"""

from __future__ import annotations

import argparse
import hashlib
import html as htmlmod
import json
import os
import re
import socket
import ssl
import sys
import time
import urllib.error
import urllib.request
import webbrowser
import xml.etree.ElementTree as ET
from collections import Counter
from concurrent.futures import (ThreadPoolExecutor, as_completed, wait,
                                TimeoutError as FuturesTimeout)
from datetime import date, datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin, urlparse

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
except Exception:
    pass

# 兜底：个别海外站点会“连上了但不回数据”，靠这个全局超时避免整个流程卡死
socket.setdefaulttimeout(25)

ROOT = Path(__file__).resolve().parent
PUBLIC = ROOT / "public"
DATA_DIR = PUBLIC / "data"
CONFIG_DIR = ROOT / "config"
SETTINGS_FILE = CONFIG_DIR / "settings.json"
TZ = timezone(timedelta(hours=8))

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")

_SSL_CTX = ssl.create_default_context()
_SSL_CTX.check_hostname = False
_SSL_CTX.verify_mode = ssl.CERT_NONE

_SSL_CTX = ssl.create_default_context()
_SSL_CTX.check_hostname = False
_SSL_CTX.verify_mode = ssl.CERT_NONE

# 可选代理：国内源直连，个别外网源需要走代理（sources.json 里 needs_proxy）
_PROXY_OPENER = None


CAT_ORDER = ["product", "trend", "brand"]


# --------------------------------------------------------------------------
# 基础设施
# --------------------------------------------------------------------------
def log(msg: str) -> None:
    print(msg, flush=True)


def load_json(path: Path, default=None):
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:
        log(f"  ! 读取 {path.name} 失败: {e}")
        return default


def save_json(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=1), encoding="utf-8")


def decode_bytes(raw: bytes) -> str:
    head = raw[:4096].lower().decode("ascii", "ignore")
    encs = []
    m = re.search(r'charset=["\']?([\w-]+)', head)
    if m:
        encs.append(m.group(1))
    encs += ["utf-8", "gb18030", "gbk", "big5"]
    for e in encs:
        try:
            return raw.decode(e)
        except (UnicodeDecodeError, LookupError):
            continue
    return raw.decode("utf-8", "ignore")


def http_get(url: str, timeout: int = 15, retries: int = 3,
             use_proxy: bool = False) -> str:
    """抓一个 URL，失败重试。use_proxy=True 时走 --proxy 指定的代理。"""
    if use_proxy and _PROXY_OPENER is None:
        raise RuntimeError("该源需要代理，但没传 --proxy")
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": UA,
                "Accept": "text/html,application/xhtml+xml,application/xml,*/*;q=0.9",
                "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            })
            opener = _PROXY_OPENER if use_proxy else None
            if opener is not None:
                resp = opener.open(req, timeout=timeout)
            else:
                resp = urllib.request.urlopen(req, timeout=timeout, context=_SSL_CTX)
            with resp:
                return decode_bytes(resp.read())
        except Exception as e:
            last = e
            if attempt < retries - 1:
                time.sleep(1.2 * (attempt + 1))
    raise last


def set_proxy(url: str) -> None:
    global _PROXY_OPENER
    handler = urllib.request.ProxyHandler({"http": url, "https": url})
    opener = urllib.request.build_opener(
        handler,
        urllib.request.HTTPSHandler(context=_SSL_CTX),
        urllib.request.HTTPHandler(),
    )
    opener.addheaders = []
    _PROXY_OPENER = opener


def clean_text(s: str) -> str:
    if not s:
        return ""
    s = htmlmod.unescape(s)
    s = re.sub(r"<[^>]+>", "", s)
    s = s.replace("\u3000", " ").replace("\xa0", " ")
    s = re.sub(r"\s+", " ", s).strip()
    return s


def contains(text: str, word: str) -> bool:
    """关键词命中判断。

    中文直接子串匹配；英文要求单词边界，避免 "AI" 命中 "airlines"、
    "cava" 命中 "cavalry" 这类误判；全大写短缩写（IPO/CEO/QSR）区分大小写。
    """
    if not text or not word:
        return False
    if not word.isascii():
        return word in text
    if word.isupper() and len(word) <= 5:
        return re.search(r"(?<![A-Za-z0-9])" + re.escape(word) + r"(?![A-Za-z0-9])",
                         text) is not None
    return re.search(r"(?<![A-Za-z0-9])" + re.escape(word.lower())
                     + r"(?![A-Za-z0-9])", text.lower()) is not None


SENT_SPLIT = re.compile(r"(?<=[。！？；!?;])\s*|(?<=[\.])\s+(?=[A-Z0-9\"'“])")


def split_sentences(text: str) -> list:
    return [s for s in SENT_SPLIT.split(text or "") if s and s.strip()]


def load_settings() -> dict:
    """网站在网页里保存的设置（目前只有外网节点）。"""
    return load_json(SETTINGS_FILE, {}) or {}


def save_settings(doc: dict) -> None:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    save_json(SETTINGS_FILE, doc)


def effective_proxy(cli_proxy: str = "") -> str:
    """代理优先级：命令行 --proxy > 网页里保存的节点"""
    if cli_proxy and cli_proxy.strip():
        return cli_proxy.strip()
    return (load_settings().get("proxy") or "").strip()


# --------------------------------------------------------------------------
# HTML 解析
# --------------------------------------------------------------------------
class LinkCollector(HTMLParser):
    """收集页面里的 <a> 链接与锚文本。"""

    def __init__(self, base: str):
        super().__init__(convert_charrefs=True)
        self.base = base
        self.links: list[tuple[str, str]] = []
        self._cur = None
        self._buf: list[str] = []
        self._skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style", "noscript"):
            self._skip += 1
        elif tag == "a":
            self._cur = urljoin(self.base, dict(attrs).get("href", "") or "")
            self._buf = []

    def handle_endtag(self, tag):
        if tag in ("script", "style", "noscript") and self._skip:
            self._skip -= 1
        elif tag == "a" and self._cur:
            self.links.append((self._cur, clean_text("".join(self._buf))))
            self._cur, self._buf = None, []

    def handle_data(self, data):
        if self._skip:
            return
        if self._cur:
            self._buf.append(data)


class ArticlePage(HTMLParser):
    """从正文页抽出标题、meta 摘要、发布时间与首段。"""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.meta: dict[str, str] = {}
        self.title = ""
        self.h1 = ""
        self.paras: list[str] = []
        self._skip = 0
        self._in = None
        self._buf: list[str] = []

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style", "noscript"):
            self._skip += 1
            return
        if tag == "meta":
            d = {k.lower(): (v or "") for k, v in attrs}
            key = (d.get("name") or d.get("property") or d.get("itemprop") or "").lower()
            if key and d.get("content"):
                self.meta.setdefault(key, clean_text(d["content"]))
        elif tag in ("title", "h1", "p"):
            self._in = tag
            self._buf = []

    def handle_endtag(self, tag):
        if tag in ("script", "style", "noscript"):
            if self._skip:
                self._skip -= 1
            return
        if tag in ("title", "h1", "p") and self._in == tag:
            text = clean_text("".join(self._buf))
            if tag == "title" and not self.title:
                self.title = text
            elif tag == "h1" and len(text) >= 6 and not self.h1:
                self.h1 = text
            elif tag == "p" and len(text) >= 24:
                self.paras.append(text)
            self._in, self._buf = None, []

    def handle_data(self, data):
        if self._skip:
            return
        if self._in:
            self._buf.append(data)


TITLE_NOISE = [
    r"^【[^】]{1,10}】", r"^\[[^\]]{1,10}\]", r"^\([^)]{1,10}\)",
    r"^\s*(独家|原创|重磅|深度|专访|快讯|观点|观察|解读|图解|直播)\s*[｜|:：]\s*",
    r"\s*[-–—_|｜]\s*[^-–—_|｜]{2,14}$",
]


def clean_title(t: str, source_name: str = "") -> str:
    t = clean_text(t).rstrip("…").strip()
    for pat in TITLE_NOISE:
        t = re.sub(pat, "", t).strip()
    if source_name:
        t = re.sub(rf"^({re.escape(source_name)}|红餐网|餐饮界|赢商网)\s*[｜|:：]?\s*", "", t)
    return t.strip(" -|｜")


DATE_PATTERNS = [
    r'"publish(?:ed)?Time"\s*[:=]\s*"([^"]{8,30})"',
    r'"pub_?date"\s*[:=]\s*"([^"]{8,30})"',
    r'"create_?time"\s*[:=]\s*"([^"]{8,30})"',
]


def parse_any_time(s: str):
    if not s:
        return None
    s = s.strip()
    try:
        dt = parsedate_to_datetime(s)
        if dt:
            return dt.astimezone(TZ)
    except Exception:
        pass
    m = re.search(r"(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})[日]?\s*(\d{1,2})?:?(\d{2})?", s)
    if m:
        y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
        hh = int(m.group(4) or 0)
        mm = int(m.group(5) or 0)
        try:
            return datetime(y, mo, d, hh, mm, tzinfo=TZ)
        except ValueError:
            return None
    return None


def date_from_url(url: str):
    """从一个 URL 里提取发布日期（新华网 /food/20260921/、每经 /articles/2026-09-21/ 等）。"""
    m = re.search(r"/(\d{4})[-/]?(\d{2})[-/]?(\d{2})/", url)
    if not m:
        return None
    try:
        return datetime(int(m.group(1)), int(m.group(2)), int(m.group(3)), tzinfo=TZ)
    except ValueError:
        return None


def shingles(s: str, n: int = 2) -> set:
    s = re.sub(r"[\W_]+", "", s or "")
    return {s[i:i + n] for i in range(len(s) - n + 1)}


def near_dup(sg: set, others: list, threshold: float = 0.55) -> bool:
    if len(sg) < 8:
        return False
    for other in others:
        if not other:
            continue
        union = len(sg | other)
        if union and len(sg & other) / union >= threshold:
            return True
    return False


def meta_time(page: ArticlePage):
    for key in ("article:published_time", "weibo:article:create_at", "og:release_date",
                "publishdate", "pubdate", "date", "sailthru.date", "og:updated_time"):
        if key in page.meta:
            dt = parse_any_time(page.meta[key])
            if dt:
                return dt
    return None


# --------------------------------------------------------------------------
# 采集：RSS / HTML 列表
# --------------------------------------------------------------------------
def parse_rss(text: str, src: dict) -> list[dict]:
    text = text.strip()
    try:
        root = ET.fromstring(text)
    except ET.ParseError:
        root = ET.fromstring(re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", text))
    out = []
    for node in root.iter():
        if node.tag.split("}")[-1].lower() not in ("item", "entry"):
            continue
        d: dict[str, str] = {}
        for ch in node:
            k = ch.tag.split("}")[-1].lower()
            if k == "link":
                d[k] = (ch.text or "").strip() or (ch.attrib.get("href") or "").strip()
            elif k in ("title", "description", "summary", "content",
                       "pubdate", "published", "updated", "date"):
                d.setdefault(k, (ch.text or "").strip())
        title = clean_title(d.get("title", ""), src["name"])
        url = d.get("link", "").strip()
        if not title or not url:
            continue
        raw_sum = d.get("description") or d.get("summary") or d.get("content") or ""
        dt = None
        for k in ("pubdate", "published", "updated", "date"):
            if d.get(k):
                dt = parse_any_time(d[k])
                if dt:
                    break
        out.append({
            "title": title, "url": url,
            "_feed_sum": clean_text(raw_sum),
            "published": dt.isoformat() if dt else "",
        })
    return out


def parse_list_html(text: str, src: dict) -> list[dict]:
    lc = LinkCollector(src["url"])
    lc.feed(text)
    rx = re.compile(src["link_regex"])
    seen, out = set(), []
    for href, anchor in lc.links:
        if not rx.search(href):
            continue
        href = href.split("#")[0]
        if href in seen:
            continue
        anchor = clean_title(anchor, src["name"])
        if len(anchor) < 8 or not re.search(r"[\u4e00-\u9fff]", anchor):
            continue
        seen.add(href)
        out.append({"title": anchor, "url": href, "_feed_sum": "", "published": ""})
    return out


def fetch_source(src: dict, timeout: int) -> tuple[dict, list[dict], str]:
    use_proxy = bool(src.get("needs_proxy"))
    try:
        text = http_get(src["url"], timeout=timeout, retries=2, use_proxy=use_proxy)
    except Exception as e:
        return src, [], f"{type(e).__name__}: {e}"
    try:
        items = parse_rss(text, src) if src["type"] == "rss" else parse_list_html(text, src)
    except Exception as e:
        return src, [], f"解析失败 {type(e).__name__}: {e}"
    return src, items, ""


# --------------------------------------------------------------------------
# 分类与打分
# --------------------------------------------------------------------------
def classify(title: str, summary: str, kw: dict) -> tuple[str, dict]:
    text = f"{title} {summary}"
    scores = {}
    for cid, conf in kw["categories"].items():
        s = 0.0
        for word, weight in conf["hints"].items():
            if contains(text, word):
                s += weight
        scores[cid] = round(s, 2)
    best = max(scores, key=lambda k: scores[k])
    if scores[best] <= 0:
        best = "brand"
    return best, scores


def match_tags(title: str, summary: str, kw: dict, limit: int = 3) -> list[str]:
    text = f"{title} {summary}"
    hits = []
    for tag, words in kw["tags"].items():
        for w in words:
            if contains(text, w):
                hits.append(tag)
                break
    return hits[:limit]


# --------------------------------------------------------------------------
# 品牌与品类识别
# --------------------------------------------------------------------------
def detect_brands(text: str, bdoc: dict) -> tuple[list, list]:
    """返回 (品牌名列表, 品类 id 列表)。一条资讯可能同时涉及多个品牌。"""
    names, cats = [], []
    if not text:
        return names, cats
    for b in (bdoc or {}).get("brands", []):
        hit = False
        for n in [b["name"]] + list(b.get("alias") or []):
            if n and contains(text, n):
                hit = True
                break
        if hit:
            names.append(b["name"])
            if b.get("cat") and b["cat"] not in cats:
                cats.append(b["cat"])
    if not cats:
        cats = detect_cat_keywords(text, bdoc)
    return names, cats


def detect_cat_keywords(text: str, bdoc: dict) -> list:
    cats = []
    for cid, words in ((bdoc or {}).get("cat_keywords") or {}).items():
        for w in words:
            if contains(text, w):
                cats.append(cid)
                break
    return cats


# 规模类数字：把「门店数 / 营收 / 市场规模 / 融资额」从标题和要点里抽出来
SCALE_PATTERNS = [
    ("门店数", r"(?:门店(?:数|数量)?|在营门店|已开出|开出)[^\d]{0,8}([\d,\.]+)\s*(万家|家)"),
    ("门店数", r"([\d,\.]+)\s*(万家|家)\s*(?:门店|店)"),
    ("门店数", r"([\d,]+)\s*(stores|locations|units)"),
    ("营收", r"(?:营收|收入|销售额|业绩)[^\d]{0,8}([\d,\.]+)\s*(亿元|亿|万元|亿美元|亿美元|亿港元)"),
    ("营收", r"(?:revenue|net sales|sales)\D{0,14}\$?([\d,\.]+)\s*(million|billion|bn)"),
    ("市场规模", r"(?:市场规模|赛道规模)[^\d]{0,8}([\d,\.]+)\s*(万亿元|万亿|亿元|亿)"),
    ("市场规模", r"(?:market|industry)\D{0,14}\$?([\d,\.]+)\s*(billion|trillion|bn)"),
    ("融资/估值", r"(?:融资|估值|投资|收购)[^\d]{0,8}([\d,\.]+)\s*(亿元|亿|万美元|亿美元)"),
    ("金额", r"\$\s*([\d,\.]+)\s*(million|billion|bn)"),
]


def extract_scales(text: str, limit: int = 3) -> list:
    out, seen = [], set()
    for kind, pat in SCALE_PATTERNS:
        for m in re.finditer(pat, text or "", re.I):
            value = m.group(1) + (m.group(2) if (m.lastindex or 0) >= 2 else "")
            if (kind, value) in seen:
                continue
            seen.add((kind, value))
            out.append({"kind": kind, "value": value})
            if len(out) >= limit:
                return out
    return out


def strip_title_echo(text: str, title: str) -> str:
    """部分站点的摘要是「标题-正文」，把开头的标题回声去掉。"""
    t = (text or "").strip()
    if not t or not title:
        return t
    if t.startswith(title):
        rest = t[len(title):].lstrip(' -－—|｜:：·"“”\'\n')
        if len(rest) >= 30:
            return rest
    return t


def make_summary(text: str, limit: int = 128) -> str:
    text = clean_text(text)
    if not text:
        return ""
    out = ""
    for p in split_sentences(text):
        if out and len(out) + len(p) > limit:
            break
        out += p
        if len(out) >= limit * 0.65:
            break
    out = out.strip()
    if not out:
        out = text[:limit]
    if len(out) > limit:
        out = out[:limit].rstrip("，,、；; ") + "…"
    return out


def short_point(text: str, limit: int = 56) -> str:
    """把一条要点压成适合放进「今日要点」的一句话。"""
    t = clean_text(text)
    if not t:
        return ""
    out = ""
    for s in split_sentences(t):
        if not s.strip():
            continue
        if out and len(out) + len(s) > limit:
            break
        out += s
        if len(out) >= limit * 0.62:
            break
    out = out.rstrip("。！？； ")
    if len(out) > limit:
        out = out[:limit].rstrip("，,、；; ") + "…"
    return out


# --------------------------------------------------------------------------
# 正文补全
# --------------------------------------------------------------------------
BOILER_PAT = re.compile(
    r"版权|免责|转载|联系我们|广告服务|微信公众号|扫描二维码|点击查看|版权所有|"
    r"京ICP|沪ICP|粤ICP|增值电信|违法和不良信息|举报邮箱|本网站|copyright|Copyright")


def norm_key(s: str) -> str:
    return re.sub(r"[\W_]+", "", s or "")[:60]


def title_overlap(title: str, cand: str) -> float:
    """候选摘要与标题的 2-gram 重合度，用来判断“这段文字是不是这条新闻的”。"""
    if not cand:
        return 0.0
    t = shingles(title)
    if not t:
        return 0.0
    return len(t & shingles(cand)) / len(t)


def best_para(paras: list, title: str) -> str:
    best, best_score = "", 0.0
    for p in paras[:10]:
        if len(p) < 30 or BOILER_PAT.search(p):
            continue
        s = title_overlap(title, p)
        if s > best_score:
            best, best_score = p, s
    return best


def title_from_page(t: str) -> str:
    """页面 <title> 一般是「标题_站点名」，拆出前半段。"""
    t = clean_text(t)
    for sep in ("｜", "|", " - ", " – ", "—", "_"):
        if sep in t:
            head = t.split(sep)[0].strip()
            if len(head) >= 10:
                return head
    return t


# --------------------------------------------------------------------------
# 正文补全
# --------------------------------------------------------------------------
def enrich_article(item: dict, timeout: int) -> dict:
    try:
        page = ArticlePage()
        page.feed(http_get(item["url"], timeout=timeout, retries=2,
                           use_proxy=bool(item.get("needs_proxy"))))
    except Exception:
        return item

    def better(cur: str, cand: str) -> str:
        """列表页的凿文本常被截断，能拿到更完整的标题就换掉。"""
        cand = clean_title(cand, item["source"])
        if len(cand) < 10:
            return cur
        if cur.endswith("…"):
            return cand
        if len(cand) > len(cur) and (cand[:10] in cur or cur[:10] in cand):
            return cand
        return cur

    if page.h1:
        item["title"] = better(item["title"], page.h1)
    if page.title:
        item["title"] = better(item["title"], title_from_page(page.title))

    item["_meta"] = clean_text(page.meta.get("description")
                            or page.meta.get("og:description")
                            or page.meta.get("twitter:description") or "")
    item["_paras"] = page.paras[:10]
    if not item.get("published"):
        dt = meta_time(page)
        if dt:
            item["published"] = dt.isoformat()
    return item


def finalize_summaries(items: list) -> None:
    """为每条资讯挑出“真正属于它”的要点。

    中文新闻站的 meta description 经常是站点模板文案（每条都一样），
    所以先做重复检测，再用「与标题的重合度」在 meta / 正文导语之间选。
    """
    freq = Counter()
    for it in items:
        m = it.get("_meta") or ""
        if len(m) >= 25:
            freq[norm_key(m)] += 1
    boiler = {k for k, v in freq.items() if v >= 2}

    stats = {"meta": 0, "lead": 0, "feed": 0, "none": 0}
    for it in items:
        title = it["title"]
        feed = it.get("_feed_sum") or ""
        meta = it.get("_meta") or ""
        lead = best_para(it.get("_paras") or [], title)
        cands = []
        if len(feed) >= 25:
            cands.append(("feed", feed))
        if len(meta) >= 25 and norm_key(meta) not in boiler:
            cands.append(("meta", meta))
        if len(lead) >= 25:
            cands.append(("lead", lead))

        chosen, src_kind = "", "none"
        for kind, c in cands:
            if title_overlap(title, c) >= 0.12:
                chosen, src_kind = c, kind
                break
        if not chosen and cands:
            chosen, src_kind = cands[0][1], cands[0][0]

        chosen = strip_title_echo(chosen, title)
        it["summary"] = make_summary(chosen)
        stats[src_kind] += 1
        for k in ("_meta", "_paras", "_feed_sum"):
            it.pop(k, None)
    return stats


# --------------------------------------------------------------------------
# 大模型润色（可选）
# --------------------------------------------------------------------------
def llm_enhance(digest: dict, items: list[dict]) -> bool:
    key = (os.environ.get("LLM_API_KEY") or os.environ.get("DEEPSEEK_API_KEY")
           or os.environ.get("OPENAI_API_KEY") or "")
    if not key:
        return False
    base = os.environ.get("LLM_BASE_URL", "https://api.deepseek.com/v1").rstrip("/")
    model = os.environ.get("LLM_MODEL", "deepseek-chat")

    payload_items = [{"id": it["id"], "cat": it["cat"], "title": it["title"],
                      "raw": it.get("raw_summary", "")[:200]} for it in items]
    prompt = (
        "你是餐饮行业情报编辑。下面是今天抓取的餐饮行业资讯，请完成三件事，只输出 JSON：\n"
        "1) headline：一句不超过 40 字的今日综述，概括今天餐饮行业最值得关注的方向；\n"
        "2) brief：3-5 条「今日要点」，每条不超过 45 字，按重要度排序，需要具体到品牌或数字，不要空话；\n"
        "3) items：为每条资讯输出 {\"id\":..., \"cat\":\"product|trend|brand\", \"summary\":\"40-90 字的要点提炼\"}，"
        "summary 要写清「谁、做了什么、关键数据」，不要复述标题。\n"
        "分类标准：product=产品上新/新品/联名/菜单；trend=行业趋势/数据报告/政策监管/消费洞察；"
        "brand=品牌动作/融资开店关店/人事/财报。\n"
        "输出格式示例：{\"headline\":\"...\",\"brief\":[\"...\"],\"items\":[{\"id\":\"..\",\"cat\":\"..\",\"summary\":\"..\"}]}\n\n"
        + json.dumps(payload_items, ensure_ascii=False)
    )
    body = json.dumps({
        "model": model, "temperature": 0.3,
        "messages": [{"role": "user", "content": prompt}],
        "response_format": {"type": "json_object"},
    }).encode("utf-8")
    req = urllib.request.Request(base + "/chat/completions", data=body, headers={
        "Content-Type": "application/json", "Authorization": f"Bearer {key}"})
    try:
        with urllib.request.urlopen(req, timeout=180, context=_SSL_CTX) as r:
            resp = json.loads(r.read().decode("utf-8"))
        content = resp["choices"][0]["message"]["content"]
        m = re.search(r"\{.*\}", content, re.S)
        data = json.loads(m.group(0) if m else content)
    except Exception as e:
        log(f"  ! 大模型调用失败，改用规则式提炼: {e}")
        return False

    if data.get("headline"):
        digest["headline"] = clean_text(data["headline"])[:80]
    brief = [clean_text(b)[:70] for b in (data.get("brief") or []) if clean_text(b)]
    if brief:
        digest["brief_text"] = brief
    by_id = {it["id"]: it for it in items}
    for rec in data.get("items") or []:
        it = by_id.get(rec.get("id"))
        if not it:
            continue
        if rec.get("cat") in CAT_ORDER:
            it["cat"] = rec["cat"]
        s = clean_text(rec.get("summary") or "")
        if len(s) >= 12:
            it["summary"] = s
    digest["enhanced_by"] = model
    return True


# --------------------------------------------------------------------------
# 市场格局汇总（品类分布 / 品牌榜 / 规模数字 / 综合占比）
# --------------------------------------------------------------------------
def scale_number(kind: str, value: str) -> float:
    """把「3,500家 / 3.5万家 / 1,200 stores」这类规模数字转成可比较的门店数。"""
    if kind != "门店数":
        return 0.0
    m = re.match(r"([\d,\.]+)\s*(万家|家|stores|locations|units)?", value or "", re.I)
    if not m:
        return 0.0
    try:
        n = float(m.group(1).replace(",", ""))
    except ValueError:
        return 0.0
    if (m.group(2) or "") == "万家":
        n *= 10000
    return n


def build_market(items: list, bdoc: dict, kw: dict) -> dict:
    """把「品类 / 品牌 / 规模」汇总成一套可用饼图展示的数据。

    综合占比 = 0.6 × 资讯热度占比 + 0.4 × 已披露门店规模占比
    （没有任何规模数字的品类则只用资讯热度，最后统一归一化到 100%）
    """
    cat_meta = {c["id"]: c for c in (bdoc or {}).get("categories", [])}
    brand_cat = {b["name"]: b.get("cat") for b in (bdoc or {}).get("brands", [])}

    per_cat = {}
    brand_rec = {}
    scales = []

    for it in items:
        bcats = it.get("bcats") or []
        brands = it.get("brands") or []
        for cid in bcats:
            rec = per_cat.setdefault(cid, {"items": 0, "brands": set(), "stores": 0.0,
                                           "named": 0})
            rec["items"] += 1
            rec["brands"].update(brands)
            if brands:
                rec["named"] += 1
        for v in (it.get("scales") or []):
            scales.append({"kind": v["kind"], "value": v["value"],
                           "brand": brands[0] if brands else "",
                           "cat": bcats[0] if bcats else "",
                           "source": it["source"], "url": it["url"],
                           "date": (it.get("published") or "")[:10]})
            if v["kind"] == "门店数" and bcats:
                per_cat[bcats[0]]["stores"] += scale_number(v["kind"], v["value"])
        for b in brands:
            br = brand_rec.setdefault(b, {"name": b, "cat": brand_cat.get(b) or "other",
                                          "count": 0, "latest": "", "url": ""})
            br["count"] += 1
            if not br["latest"]:
                br["latest"] = it["title"]
                br["url"] = it["url"]

    total_items = sum(r["items"] for r in per_cat.values()) or 1
    total_stores = sum(r["stores"] for r in per_cat.values())
    # 没识别出具体品牌/品类的条目不参与饼图，另行说明
    unclassified = sum(1 for it in items if not (it.get("bcats") or []))

    cats_out = []
    for cid, r in per_cat.items():
        meta = cat_meta.get(cid, {"label": cid, "color": "#8D949C"})
        heat = r["items"] / total_items
        stores_share = (r["stores"] / total_stores) if total_stores > 0 else 0.0
        composite = (0.6 * heat + 0.4 * stores_share) if total_stores > 0 else heat
        cats_out.append({
            "id": cid, "label": meta["label"], "color": meta["color"],
            "items": r["items"], "brands": len(r["brands"]),
            "stores": int(r["stores"]),
            "heat": round(heat, 4),
            "stores_share": round(stores_share, 4),
            "composite": round(composite, 4),
        })
    # 归一化：把 composite 与 heat 各自缩到总和 100%
    for key in ("composite", "heat"):
        tot = sum(c[key] for c in cats_out) or 1
        for c in cats_out:
            c[key] = round(c[key] / tot, 4)
    cats_out.sort(key=lambda c: -c["composite"])

    brand_top = sorted(brand_rec.values(), key=lambda b: (-b["count"], b["name"]))[:20]
    scales.sort(key=lambda s: -scale_number(s["kind"], s["value"]))

    return {
        "formula": "综合占比 = 0.6 × 资讯热度占比 + 0.4 × 已披露门店规模占比（仅统计本次采集到的公开信息）",
        "cats": cats_out,
        "brand_top": brand_top,
        "scales": scales[:24],
        "total_stores": int(total_stores),
        "unclassified": unclassified,
    }


# --------------------------------------------------------------------------
# 板块汇总（内网 / 外网 各自一套）
# --------------------------------------------------------------------------
def pick_brief(items: list, kw: dict, limit: int = 5) -> list:
    """选今日要点：每个板块先保一条，再按信息量（含数字、长度）补足。"""
    roundup = re.compile(r"餐饮大事件|周报|一周热点|盘点|行业快讯|热点回顾|合集")
    gener = re.compile(r"尽数收录|轮番上演|密集爆发|不容错过|一切尽在|敬请关注|精彩回顾|"
                       r"风云迭代|风云变幻|本文收录")

    def rank(it):
        s = it.get("summary") or ""
        v = it.get("score", 0)
        if re.search(r"\d", s):
            v += 2.5
        if len(s) >= 45:
            v += 0.5
        if roundup.search(it["title"]):
            v -= 4
        if not s or gener.search(s):
            v -= 1
        return v

    ordered = sorted(items, key=lambda x: -rank(x))
    picked = []
    for c in CAT_ORDER:
        pool = [i for i in ordered if i["cat"] == c]
        if pool:
            picked.append(pool[0])
    need = kw.get("brief_min_items", 4)
    for it in ordered:
        if len(picked) >= need:
            break
        if it not in picked:
            picked.append(it)

    out = []
    for it in picked[:limit]:
        s = it.get("summary") or ""
        if not s or gener.search(s):
            s = it["title"]
        text = short_point(s)
        if not text:
            continue
        out.append({"cat": it["cat"], "text": text, "id": it["id"],
                    "region": it.get("region", "cn"),
                    "source": it["source"], "url": it["url"]})
    return out


def build_section(items: list, kw: dict, bdoc: dict, cat_label: dict) -> dict:
    """一个板块的全套数据：条数、板块分布、要点、高频词、市场格局。"""
    counts = {c: sum(1 for i in items if i["cat"] == c) for c in CAT_ORDER}
    tag_freq: dict = {}
    for it in items:
        for t in it["tags"]:
            tag_freq[t] = tag_freq.get(t, 0) + 1
    top_tags = [t for t, _ in sorted(tag_freq.items(), key=lambda x: -x[1])[:6]]
    stat_txt = " · ".join(f"{cat_label[c]} {counts[c]}" for c in CAT_ORDER if counts[c])
    headline = f"{len(items)} 条：{stat_txt}" if items else "暂无条目"
    if top_tags:
        headline += f"；高频词 {('、'.join('《' + t + '》' for t in top_tags[:3]))}"
    return {
        "total": len(items),
        "counts": counts,
        "keywords": top_tags,
        "brief": pick_brief(items, kw),
        "market": build_market(items, bdoc, kw),
        "headline": headline,
    }


# --------------------------------------------------------------------------
# 主流程
# --------------------------------------------------------------------------
def url_hash(u: str) -> str:
    return hashlib.sha1(u.split("#")[0].encode("utf-8")).hexdigest()[:16]


def build_digest(args) -> int:
    sources_cfg = load_json(ROOT / "sources.json")
    kw = load_json(ROOT / "keywords.json")
    bdoc = load_json(ROOT / "brands.json", {}) or {}
    if not sources_cfg or not kw:
        log("缺少 sources.json / keywords.json")
        return 1

    settings = sources_cfg.get("settings", {})
    timeout = settings.get("html_timeout", 15)
    today = args.date or date.today().isoformat()

    sources = [s for s in sources_cfg["sources"] if s.get("enabled", True)]
    if args.only:
        want = {x.strip() for x in args.only.split(",") if x.strip()}
        sources = [s for s in sources if s["id"] in want]

    # ---------- 1. 抓列表 ----------
    log(f"\n=== 餐饮日报 · {today} ===")
    log(f"[1/5] 抓取 {len(sources)} 个信息源列表")
    raw: list[dict] = []
    ex = ThreadPoolExecutor(max_workers=min(8, len(sources) or 1))
    futs = {ex.submit(fetch_source, s, timeout): s for s in sources}
    done_names = set()
    try:
        for f in as_completed(futs, timeout=110):
            src, items, err = f.result()
            done_names.add(src["id"])
            cap = settings.get("max_items_per_source", 40)
            items = items[:cap]
            tag = "内" if src.get("region", "cn") == "cn" else "外"
            if err:
                log(f"  ✗[{tag}] {src['name']:<20} {err[:60]}")
            else:
                log(f"  ✓[{tag}] {src['name']:<20} {len(items):>3} 条")
            for it in items:
                it.update({"source": src["name"], "source_id": src["id"],
                           "region": src.get("region", "cn"),
                           "weight": src.get("weight", 1.0),
                           "niche": src.get("niche", False),
                           "needs_proxy": src.get("needs_proxy", False)})
            raw.extend(items)
    except FuturesTimeout:
        pass
    for s in sources:
        if s["id"] not in done_names:
            log(f"  ✗[{('内' if s.get('region', 'cn') == 'cn' else '外')}] "
                f"{s['name']:<20} 抓取超时，已跳过")
    ex.shutdown(wait=False, cancel_futures=True)
    if not raw:
        log("!! 所有信息源都没抓到内容，请检查网络或代理设置")
        return 1

    # ---------- 2. 过滤 / 去重 ----------
    log("[2/5] 过滤与去重")
    seen_db = load_json(DATA_DIR / "seen.json", {}) or {}
    seen_urls = set()
    for d, urls in seen_db.items():
        if d != today:
            seen_urls.update(urls)

    excl = re.compile("|".join(kw["exclude_title"]))
    rterms = kw["restaurant_terms"]
    kept, seen_title, dropped = [], set(), 0
    for it in raw:
        title = it["title"]
        if excl.search(title):
            dropped += 1
            continue
        if it["url"] in seen_urls or url_hash(it["url"]) in seen_urls:
            dropped += 1
            continue
        if not it["niche"] and not any(t in title for t in rterms):
            dropped += 1
            continue
        key = re.sub(r"[\W_]+", "", title)[:16]
        if key in seen_title:
            dropped += 1
            continue
        seen_title.add(key)
        kept.append(it)
    log(f"  保留 {len(kept)} 条（内网 "
        f"{sum(1 for i in kept if i.get('region') == 'cn')} · 外网 "
        f"{sum(1 for i in kept if i.get('region') == 'global')}；过滤掉 {dropped} 条：重复/非餐饮/软文）")

    # ---------- 3. 预排序：先按标题粗排，决定要抓哪些正文 ----------
    log("[3/5] 去重与预排序")
    for it in kept:
        it["title"] = clean_title(it["title"], it["source"]) or it["title"]
        _, pre_scores = classify(it["title"], "", kw)
        pre = max(pre_scores.values(), default=0) + it["weight"]
        if re.search(r"\d", it["title"]):
            pre += 1.5
        if len(it["title"]) >= 18:
            pre += 0.8
        it["_pre"] = round(pre, 2)

    # 近重复过滤：保留分数更高的那一条
    kept.sort(key=lambda x: (-x["_pre"], x["title"]))
    kept_sgs, deduped, near = [], [], 0
    for it in kept:
        sg = shingles(it["title"])
        if near_dup(sg, kept_sgs):
            near += 1
            continue
        kept_sgs.append(sg)
        deduped.append(it)
    kept = deduped
    if near:
        log(f"  合并近重复标题 {near} 条")

    # 内网 / 外网配额，避免一边把另一边挤掉
    total_cap = settings.get("max_items_total", 80)
    global_share = settings.get("global_quota", 0.5)
    cn_cap = int(round(total_cap * (1 - global_share)))
    gl_cap = total_cap - cn_cap
    cn_items = [i for i in kept if i.get("region") == "cn"]
    gl_items = [i for i in kept if i.get("region") == "global"]
    picked = cn_items[:cn_cap] + gl_items[:gl_cap]
    if len(picked) < total_cap:            # 某一侧不够时用另一侧补足
        chosen = {id(i) for i in picked}
        picked += [i for i in kept if id(i) not in chosen][:total_cap - len(picked)]
    picked.sort(key=lambda x: (-x["_pre"], x["title"]))
    kept = picked
    log(f"  配额筛选：内网 {sum(1 for i in kept if i.get('region') == 'cn')} 条 · "
        f"外网 {sum(1 for i in kept if i.get('region') == 'global')} 条")

    # ---------- 4. 抓正文、提炼要点 ----------
    limit = settings.get("article_fetch_limit", 70)
    if not args.fast:
        log(f"[4/5] 抓正文提炼要点（{min(limit, len(kept))} 条）")
        targets = kept[:limit]
        ex2 = ThreadPoolExecutor(max_workers=min(settings.get("workers", 8), len(targets) or 1))
        futs = [ex2.submit(enrich_article, it, timeout) for it in targets]
        done, pending2 = wait(futs, timeout=260)
        log(f"  … 完成 {len(done)}/{len(targets)}" + (f"，{len(pending2)} 条超时未取到正文" if pending2 else ""))
        ex2.shutdown(wait=False, cancel_futures=True)
        st = finalize_summaries(kept)
        log(f"  要点来源：正文导语 {st['lead']} · 站点摘要 {st['meta']} · "
            f"订阅摘要 {st['feed']} · 仅标题 {st['none']}")
    else:
        log("[4/5] --fast 模式，跳过正文抓取")
        finalize_summaries(kept)

    # ---------- 5. 分类、打分与目录 ----------
    log("[5/5] 分类、打分与要点提炼")
    for it in kept:
        text = f"{it['title']} {it['summary']}"
        cat, scores = classify(it["title"], it["summary"], kw)
        it["cat"] = cat
        it["tags"] = match_tags(it["title"], it["summary"], kw)
        brands, bcats = detect_brands(text, bdoc)
        it["brands"] = brands[:4]
        it["bcats"] = bcats[:3]
        it["scales"] = extract_scales(text)
        score = scores.get(cat, 0) + it["weight"]
        if re.search(r"\d", it["title"]):
            score += 1.5
        if len(it["title"]) >= 18:
            score += 0.8
        if len(it["summary"]) >= 40:
            score += 0.8
        it["score"] = round(score, 2)
        it["id"] = url_hash(it["url"])
        dt = parse_any_time(it.get("published", "")) or date_from_url(it["url"])
        it["published"] = dt.isoformat() if dt else ""
        for k in ("_pre", "weight", "niche", "needs_proxy"):
            it.pop(k, None)

    # 重新编号：先按分类分组，组内按分数排序，得到稳定的阅读顺序
    kept.sort(key=lambda x: (CAT_ORDER.index(x["cat"]), -x["score"]))
    for n, it in enumerate(kept, 1):
        it["no"] = n

    # ---------- 6. 汇总：内网 / 外网两个大板块各自成一套数据 ----------
    cat_label = {c: kw["categories"][c]["label"] for c in CAT_ORDER}

    # 大模型润色先跑，保证分板块的统计基于润色后的分类与要点
    llm_headline, llm_brief = None, None
    if args.llm:
        log("      · 调用大模型润色要点")
        box = {}
        if llm_enhance(box, kept):
            llm_headline = box.get("headline")
            llm_brief = box.get("brief_text")
    else:
        log("      · 未启用大模型（--llm 可开启），使用规则式提炼")

    region_counts = {
        "cn": sum(1 for i in kept if i.get("region") == "cn"),
        "global": sum(1 for i in kept if i.get("region") == "global"),
    }
    sections = {
        "all": build_section(kept, kw, bdoc, cat_label),
        "cn": build_section([i for i in kept if i.get("region") == "cn"], kw, bdoc, cat_label),
        "global": build_section([i for i in kept if i.get("region") == "global"],
                                kw, bdoc, cat_label),
    }

    # 同一天重跑时，把之前翻好的译文按 id 接回来，不用重翻
    prev = load_json(DATA_DIR / f"digest-{today}.json") or {}
    prev_tr = {i["id"]: i.get("tr") for i in prev.get("items", []) if i.get("tr")}
    for it in kept:
        if it["id"] in prev_tr and not it.get("tr"):
            it["tr"] = prev_tr[it["id"]]
    for k, sec in sections.items():
        old = (prev.get("sections") or {}).get(k, {}).get("tr")
        if old:
            sec["tr"] = old

    digest = {
        "date": today,
        "generated_at": datetime.now(TZ).isoformat(timespec="seconds"),
        "headline": sections["all"]["headline"],
        "brief": sections["all"]["brief"],
        "keywords": sections["all"]["keywords"],
        "counts": sections["all"]["counts"],
        "region_counts": region_counts,
        "market": sections["all"]["market"],
        "total": len(kept),
        "labels": cat_label,
        "items": kept,
        "sections": sections,
        "llm": False,
    }

    if llm_headline:
        digest["headline"] = llm_headline
        digest["sections"]["all"]["headline"] = llm_headline
    if llm_brief:
        fixed = [{"cat": "", "text": t, "id": "", "source": "", "url": "",
                  "region": ""} for t in llm_brief]
        digest["brief"] = fixed
        digest["sections"]["all"]["brief"] = fixed
    digest["llm"] = bool(llm_headline or llm_brief)

    # 可选：采集时顺带翻译外网内容（译文会写进数据，离线也能看）
    if args.translate:
        langs = [x.strip() for x in args.translate.split(",") if x.strip()]
        if langs:
            log(f"      · 翻译外网内容 → {', '.join(langs)}")
            try:
                from translate import Translator
                tr = Translator(load_settings())
                tr.settings = load_settings()
                overseas = [i for i in kept if i.get("region") == "global"]
                for lang in langs:
                    texts = [it["title"] for it in overseas]
                    texts += [it["summary"] for it in overseas if it.get("summary")]
                    texts += [b["text"] for b in sections["global"]["brief"] if b.get("text")]
                    texts = list(dict.fromkeys([t for t in texts if t]))
                    if not texts:
                        continue
                    got = tr.translate_many(texts, lang)
                    m = dict(zip(texts, got))
                    for it in overseas:
                        rec = it.setdefault("tr", {})
                        rec[lang] = {
                            "t": m.get(it["title"], it["title"]),
                            "s": m.get(it.get("summary") or "", it.get("summary") or ""),
                        }
                    sections["global"].setdefault("tr", {})[lang] = [
                        m.get(b["text"], b["text"]) for b in sections["global"]["brief"]]
                    log(f"        {lang}: {len(texts)} 条文本，联网 {tr.used_network} 次")
                tr.save()
            except Exception as e:
                log(f"  ! 翻译失败（不影响采集）：{e}")


    # ---------- 写文件 ----------
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    meta = load_json(DATA_DIR / "meta.json", {}) or {}
    if "start_date" not in meta:
        meta["start_date"] = today
    try:
        start = date.fromisoformat(meta["start_date"])
        digest["issue"] = (date.fromisoformat(today) - start).days + 1
    except Exception:
        digest["issue"] = 1
    meta["last_run"] = digest["generated_at"]
    save_json(DATA_DIR / "meta.json", meta)

    save_json(DATA_DIR / f"digest-{today}.json", digest)

    index = load_json(DATA_DIR / "index.json", {"history": []}) or {"history": []}
    hist = [h for h in index.get("history", []) if h.get("date") != today]
    hist.append({"date": today, "total": digest["total"], "counts": counts,
                 "issue": digest["issue"], "headline": digest["headline"].split("；")[0]})
    hist.sort(key=lambda x: x["date"], reverse=True)
    save_json(DATA_DIR / "index.json", {"latest": hist[0]["date"] if hist else today,
                                        "history": hist})

    seen_db[today] = sorted({url_hash(it["url"]) for it in kept})
    keep_days = settings.get("keep_raw_days", 3)
    if len(seen_db) > keep_days:
        for d in sorted(seen_db)[:-keep_days]:
            seen_db.pop(d, None)
    save_json(DATA_DIR / "seen.json", seen_db)

    render_index_html(digest)

    log(f"\n完成：{digest['total']} 条（{stat_txt}）")
    log(f"  内网 {region_counts['cn']} 条 · 外网 {region_counts['global']} 条")
    if market["cats"]:
        top = "、".join(f"{c['label']}{c['composite'] * 100:.0f}%" for c in market["cats"][:4])
        log(f"  综合格局前四：{top}")
    log(f"  期号 第 {digest['issue']:03d} 期")
    log(f"  数据 public/data/digest-{today}.json")
    log(f"  页面 public/index.html（离线单文件版 public/offline.html）")
    return 0


# --------------------------------------------------------------------------
# 渲染单文件页面（可直接双击打开，也可部署到任意静态托管）
# --------------------------------------------------------------------------
def render_index_html(digest: dict, offline_days: int = 14) -> None:
    template = PUBLIC / "index.template.html"
    if not template.exists():
        log("  ! 未找到 public/index.template.html，跳过页面渲染")
        return
    tpl = template.read_text(encoding="utf-8")

    def dump(obj) -> str:
        return json.dumps(obj, ensure_ascii=False,
                          separators=(",", ":")).replace("</", "<\\/")

    # 联网版：数据分隔开放，页面自己向 data/ 目录取往期
    auth_json = dump(load_json(PUBLIC / "auth-config.json", {}) or {})
    out = tpl.replace("/*__BOOT_DATA__*/null", dump(digest))
    out = out.replace("/*__BOOT_ARCHIVE__*/null", "null")
    out = out.replace("/*__AUTH_CONFIG__*/null", auth_json)
    (PUBLIC / "index.html").write_text(out, encoding="utf-8")

    # 单文件版：把最近几天的数据全部内联，离线也能翻往期，供 App / 微信传输用
    history = (load_json(DATA_DIR / "index.json", {}) or {}).get("history", [])
    archive = {}
    for h in history[:offline_days]:
        d = load_json(DATA_DIR / f"digest-{h['date']}.json")
        if d:
            archive[h["date"]] = d
    if digest["date"] not in archive:
        archive[digest["date"]] = digest

    single = tpl.replace("/*__BOOT_DATA__*/null", dump(digest))
    single = single.replace("/*__BOOT_ARCHIVE__*/null", dump(archive))
    single = single.replace("/*__AUTH_CONFIG__*/null", auth_json)
    css = (PUBLIC / "style.css").read_text(encoding="utf-8")
    js = (PUBLIC / "app.js").read_text(encoding="utf-8")
    auth_file = PUBLIC / "auth.js"
    auth_js = auth_file.read_text(encoding="utf-8") if auth_file.exists() else ""
    single = single.replace('<link rel="stylesheet" href="style.css">',
                            "<style>\n" + css + "\n</style>")
    single = single.replace('<script src="auth.js"></script>',
                            "<script>\n" + auth_js + "\n</script>")
    single = single.replace('<script src="app.js"></script>',
                            "<script>\n" + js + "\n</script>")
    for tag in ('<link rel="manifest" href="manifest.webmanifest">',
                '<link rel="apple-touch-icon" href="icon-192.png">',
                '<link rel="icon" href="icon-192.png">'):
        single = single.replace(tag, "")
    (PUBLIC / "offline.html").write_text(single, encoding="utf-8")
    log(f"  离线版内含 {len(archive)} 天数据，{len(single) / 1024:.0f} KB")


def local_ips() -> list:
    ips = []
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("223.5.5.5", 80))
        ips.append(s.getsockname()[0])
        s.close()
    except Exception:
        pass
    try:
        for ip in socket.gethostbyname_ex(socket.gethostname())[2]:
            if not ip.startswith("127.") and ip not in ips:
                ips.append(ip)
    except Exception:
        pass
    return ips


def serve(port: int = 8848) -> None:
    import functools
    import http.server

    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(PUBLIC))
    # 监听 0.0.0.0，同一 WiFi 下的手机也能直接打开
    with http.server.ThreadingHTTPServer(("0.0.0.0", port), handler) as srv:
        log("\n预览已启动（Ctrl+C 结束）")
        log(f"  本机：http://127.0.0.1:{port}/index.html")
        for ip in local_ips():
            log(f"  手机：http://{ip}:{port}/index.html   （需在同一 WiFi）")
        webbrowser.open(f"http://127.0.0.1:{port}/index.html")
        try:
            srv.serve_forever()
        except KeyboardInterrupt:
            log("已停止")


def main() -> int:
    ap = argparse.ArgumentParser(description="餐饮日报 · 每日行业情报采集")
    ap.add_argument("--date", help="写入用的日期，默认今天，如 2026-09-21")
    ap.add_argument("--fast", action="store_true", help="跳过正文抓取，只跑列表")
    ap.add_argument("--only", help="只跑指定源 id，逗号分隔，如 hongcan,jiemian")
    ap.add_argument("--llm", action="store_true", help="调用大模型润色要点")
    ap.add_argument("--proxy", help="HTTP 代理，如 http://127.0.0.1:7897")
    ap.add_argument("--translate", help="采集后把外网内容翻成指定语言，逗号分隔（如 zh 或 zh,ja）")
    ap.add_argument("--render-only", action="store_true",
                    help="不采集，只用已有数据重新生成页面（改前端时用）")
    ap.add_argument("--serve", action="store_true", help="采集后启动本地预览")
    ap.add_argument("--port", type=int, default=8848, help="预览端口")
    args = ap.parse_args()

    proxy = effective_proxy(args.proxy)
    if proxy:
        set_proxy(proxy)
        log(f"使用代理（外网节点）：{proxy}")

    t0 = time.time()
    if args.render_only:
        idx = load_json(DATA_DIR / "index.json", {}) or {}
        d = args.date or idx.get("latest")
        digest = load_json(DATA_DIR / f"digest-{d}.json") if d else None
        if not digest:
            log("找不到已有数据，先跑一次 python daily.py")
            return 1
        # 字典 / 关键词改过之后，不用重爬：把品牌识别、市场格局、分板块统计全部重算
        kw = load_json(ROOT / "keywords.json")
        bdoc = load_json(ROOT / "brands.json", {}) or {}
        items = digest["items"]
        for it in items:
            text = f"{it['title']} {it.get('summary', '')}"
            brands, bcats = detect_brands(text, bdoc)
            it["brands"] = brands[:4]
            it["bcats"] = bcats[:3]
            it["scales"] = extract_scales(text)
        cat_label = {c: kw["categories"][c]["label"] for c in CAT_ORDER}
        old_sections = digest.get("sections") or {}
        old_tr = {k: (v.get("tr") or {}) for k, v in old_sections.items()}
        old_item_tr = {i["id"]: i.get("tr") for i in items if i.get("tr")}
        for it in items:
            if it["id"] in old_item_tr:
                it["tr"] = old_item_tr[it["id"]]
        sections = {
            "all": build_section(items, kw, bdoc, cat_label),
            "cn": build_section([i for i in items if i.get("region") == "cn"],
                                kw, bdoc, cat_label),
            "global": build_section([i for i in items if i.get("region") == "global"],
                                    kw, bdoc, cat_label),
        }
        for k, sec in sections.items():          # 保留已经翻好的板块译文
            if old_tr.get(k):
                sec["tr"] = old_tr[k]
        digest["sections"] = sections
        digest["counts"] = sections["all"]["counts"]
        digest["brief"] = sections["all"]["brief"]
        digest["keywords"] = sections["all"]["keywords"]
        digest["market"] = sections["all"]["market"]
        digest["headline"] = sections["all"]["headline"]
        digest["region_counts"] = {
            "cn": sum(1 for i in items if i.get("region") == "cn"),
            "global": sum(1 for i in items if i.get("region") == "global"),
        }
        save_json(DATA_DIR / f"digest-{d}.json", digest)
        render_index_html(digest)
        mc = digest["market"]["cats"][:4]
        log(f"已用 {d} 的数据重算并渲染（未重新采集）：" +
            "、".join(f"{c['label']}{c['composite'] * 100:.0f}%" for c in mc) +
            f"；未归类 {digest['market']['unclassified']} 条")
        return 0
    code = build_digest(args)
    log(f"耗时 {time.time() - t0:.1f}s")
    if code == 0 and args.serve:
        serve(args.port)
    return code


if __name__ == "__main__":
    raise SystemExit(main())
