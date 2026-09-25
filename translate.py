# -*- coding: utf-8 -*-
"""餐饮日报 · 翻译模块

两个可选后端：
  1. mymemory —— 免费、不需要 Key（默认），单条请求、有每日额度
  2. llm       —— 任何 OpenAI 兼容接口（DeepSeek 等），需要 Key，质量更好，可批量

共同点：结果全部落盘缓存（config/translations.json），同一句话只翻一次；
已是要翻译的语言时不重复翻。
"""

from __future__ import annotations

import hashlib
import json
import re
import ssl
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

ROOT = Path(__file__).resolve().parent
CONFIG_DIR = ROOT / "config"
CACHE_FILE = CONFIG_DIR / "translations.json"
DATA_FILE = ROOT / "public" / "data" / "translations.json"

CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36"

# 界面上的语言选项
LANGS = [
    ("zh", "中文"),
    ("zh-TW", "繁體"),
    ("en", "English"),
    ("ja", "日本語"),
    ("ko", "한국어"),
]
LANG_LABEL = dict(LANGS)
# MyMemory 用的语言代码
MM_CODE = {"zh": "zh-CN", "zh-TW": "zh-TW", "en": "en", "ja": "ja", "ko": "ko"}
LLM_NAME = {"zh": "简体中文", "zh-TW": "繁体中文", "en": "English",
            "ja": "日本語", "ko": "한국어"}

_CACHE_LOCK = threading.Lock()


# --------------------------------------------------------------------------
# 语种识别
# --------------------------------------------------------------------------
KANA = re.compile(r"[\u3040-\u309f\u30a0-\u30ff]")
HANGUL = re.compile(r"[\uac00-\ud7af]")
CJK = re.compile(r"[\u4e00-\u9fff]")


def detect_lang(text: str) -> str:
    if not text:
        return "en"
    if KANA.search(text):
        return "ja"
    if HANGUL.search(text):
        return "ko"
    cjk = len(CJK.findall(text))
    if cjk >= 6:
        return "zh"
    return "en"


def is_already(text: str, target: str) -> bool:
    """这句话是不是已经是目标语言了（含简繁差异的判断）。"""
    if not text:
        return True
    cur = detect_lang(text)
    if target in ("zh", "zh-TW"):
        if cur != "zh":
            return False
        # 简体/繁体：粗略用特征字判断，拿不准就当需要转换
        trad = set("個們來這說時會後點臺灣萬與體產權關懷為國對開")
        simp = set("个们来这说时会后点台湾万与体产权关怀念为国对开")
        has_trad = any(c in trad for c in text)
        has_simp = any(c in simp for c in text)
        if target == "zh-TW":
            return has_trad and not has_simp
        return has_simp and not has_trad
    return cur == target


# --------------------------------------------------------------------------
# 缓存
# --------------------------------------------------------------------------
def _key(text: str, target: str) -> str:
    h = hashlib.sha1(f"{target}\x00{text}".encode("utf-8")).hexdigest()
    return h[:20]


class Translator:
    def __init__(self, settings: dict | None = None):
        self.settings = settings or {}
        self.cache = self._load()
        self.used_network = 0
        self.errors: list = []

    @staticmethod
    def _load() -> dict:
        try:
            return json.loads(CACHE_FILE.read_text(encoding="utf-8"))
        except Exception:
            return {}

    def save(self) -> None:
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        try:
            with _CACHE_LOCK:
                CACHE_FILE.write_text(json.dumps(self.cache, ensure_ascii=False),
                                      encoding="utf-8")
        except Exception as e:
            print(f"  ! 翻译缓存写入失败: {e}")

    # ---------------- 对外 ----------------
    def stats(self, texts: list, target: str) -> dict:
        todo = [t for t in texts if not is_already(t, target)
                and _key(t, target) not in self.cache]
        return {"total": len(texts), "pending": len(todo), "cached": len(texts) - len(todo)}

    def clear_targets(self, texts: list, target: str) -> int:
        """删掉这些文本在该语言下的缓存（重译前调用）。"""
        n = 0
        for t in texts:
            if self.cache.pop(_key(t, target), None) is not None:
                n += 1
        if n:
            self.save()
        return n

    def translate(self, text: str, target: str) -> str:
        return self.translate_many([text], target)[0]

    def translate_many(self, texts: list, target: str, progress=None,
                       force: bool = False) -> list:
        """force=True 时忽略缓存重新翻译（换服务后想重译就用它）。"""
        out: list = [None] * len(texts)
        todo: list = []
        for i, t in enumerate(texts):
            if not t or is_already(t, target):
                out[i] = t or ""
                continue
            hit = None if force else self.cache.get(_key(t, target))
            if hit:
                out[i] = hit
            else:
                todo.append(i)

        if not todo:
            return out

        provider = (self.settings.get("provider") or "mymemory").lower()
        if provider == "llm" and (self.settings.get("api_key") or "").strip():
            done = self._batch_llm([(i, texts[i]) for i in todo], target, out)
            todo = [i for i in todo if out[i] is None]
        for n, i in enumerate(todo):
            out[i] = self._one_mymemory(texts[i], target)
            self.used_network += 1
            if progress:
                progress(n + 1, len(todo))
            time.sleep(0.12)
        self.save()
        return [x if x else "" for x in out]

    # ---------------- 后端：MyMemory ----------------
    def _one_mymemory(self, text: str, target: str) -> str:
        src = detect_lang(text)
        if src == target:
            return text
        pair = f"{MM_CODE.get(src, 'en')}|{MM_CODE.get(target, 'zh-CN')}"
        params = {"q": text[:500], "langpair": pair}
        email = (self.settings.get("mymemory_email") or "").strip()
        if email:
            params["de"] = email
        url = "https://api.mymemory.translated.net/get?" + urllib.parse.urlencode(params)
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=20, context=CTX) as r:
                data = json.loads(r.read().decode("utf-8", "replace"))
            got = (data.get("responseData") or {}).get("translatedText") or ""
            got = got.strip()
            if got and not got.upper().startswith("MYMEMORY WARNING"):
                self.cache[_key(text, target)] = got
                return got
            self.errors.append(str(data.get("responseDetails"))[:80])
        except Exception as e:
            self.errors.append(f"{type(e).__name__}: {str(e)[:60]}")
        return text

    # ---------------- 后端：大模型 ----------------
    def _batch_llm(self, pairs: list, target: str, out: list, size: int = 10) -> int:
        base = (self.settings.get("base_url") or "https://api.deepseek.com/v1").rstrip("/")
        key = (self.settings.get("api_key") or "").strip()
        model = self.settings.get("model") or "deepseek-chat"
        lang = LLM_NAME.get(target, target)
        done = 0
        for i in range(0, len(pairs), size):
            chunk = pairs[i:i + size]
            payload = json.dumps({
                "model": model,
                "temperature": 0.2,
                "messages": [
                    {"role": "system", "content":
                     f"你是新闻翻译。把用户给的 JSON 数组里每条文本翻译成{lang}，"
                     "保持原有的品牌名、数字、专有名词，不要解释、不要加引号。"
                     "只输出一个 JSON 数组，长度和顺序与输入完全一致。"},
                    {"role": "user", "content": json.dumps([t for _, t in chunk],
                                                            ensure_ascii=False)},
                ],
            }).encode()
            try:
                req = urllib.request.Request(base + "/chat/completions", data=payload, headers={
                    "Content-Type": "application/json",
                    "Authorization": "Bearer " + key,
                })
                with urllib.request.urlopen(req, timeout=120, context=CTX) as r:
                    resp = json.loads(r.read().decode("utf-8", "replace"))
                content = resp["choices"][0]["message"]["content"]
                m = re.search(r"\[.*\]", content, re.S)
                arr = json.loads(m.group(0) if m else content)
                for (idx, src), got in zip(chunk, arr):
                    if isinstance(got, str) and got.strip():
                        out[idx] = got.strip()
                        self.cache[_key(src, target)] = got.strip()
                        done += 1
            except Exception as e:
                self.errors.append(f"LLM: {type(e).__name__}: {str(e)[:80]}")
        return done


def load_settings(path: Path | None = None) -> dict:
    p = path or (CONFIG_DIR / "settings.json")
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return {}


if __name__ == "__main__":
    t = Translator(load_settings())
    sample = "McDonald's is testing a new value menu to win back customers"
    for code, label in LANGS:
        print(f"  {label:<8} {t.translate(sample, code)}")
    print(f"  网络请求 {t.used_network} 次，错误 {t.errors[:2]}")
