# -*- coding: utf-8 -*-
"""ChartCanvas - 通用可视化画图桌面应用 (pywebview + Plotly.js 本地渲染)

后端职责：文件选择、Excel/CSV 解析、列类型识别、聚合计算，
前端 (web/index.html) 负责图表配置与渲染。
"""
import json
import os
import sys
import threading

import webview

try:
    import pandas as pd
except Exception:
    pd = None

__version__ = "0.1.0"

AGG_FUNCS = {
    "求和 sum": "sum",
    "均值 mean": "mean",
    "计数 count": "count",
    "最大值 max": "max",
    "最小值 min": "min",
    "中位数 median": "median",
    "去重计数 nunique": "nunique",
    "首值 first": "first",
    "不聚合 raw": "raw",
}

META_COLS = {"__chart_row__": "内置行号"}


class Api:
    def __init__(self):
        self.df = None
        self.file_name = ""
        self.loaded = False

    def version(self):
        return {"app": __version__, "pandas": pd.__version__ if pd else "N/A"}

    def log(self, msg):
        """前端把日志/错误转发到控制台，便于调试。"""
        print("[JS]", msg, flush=True)
        return True

    # ---------------- 文件 ---------------- #
    def choose_and_load(self):
        """打开系统文件选择框并加载 Excel/CSV。"""
        if not pd:
            return {"ok": False, "error": "缺少 pandas，请检查环境"}
        try:
            win = webview.windows[0]
        except Exception:
            win = None
        if win is None:
            return {"ok": False, "error": "窗口未就绪"}
        file_types = (
            "Excel/CSV (*.xlsx;*.xls;*.csv;*.tsv;*.txt)",
            "Excel (*.xlsx;*.xls)",
            "CSV (*.csv;*.tsv;*.txt)",
            "所有文件 (*.*)",
        )
        chosen = win.create_file_dialog(
            webview.OPEN_DIALOG, allow_multiple=False, file_types=file_types
        )
        if not chosen:
            return {"ok": False, "cancel": True}
        path = chosen[0] if isinstance(chosen, (list, tuple)) else str(chosen)
        return self.load_path(path)

    def load_demo(self):
        """加载随附的演示数据（便于开箱体验）。"""
        demo = os.path.join(resource_dir(), "sample_data", "经营数据.csv")
        if os.path.exists(demo):
            return self.load_path(demo)
        return {"ok": False, "error": "未找到演示数据"}

    def load_path(self, path):
        try:
            df = _read_table(path)
        except Exception as e:
            return {"ok": False, "error": f"读取失败：{e}"}
        self.df = df
        self.file_name = os.path.basename(path)
        self.loaded = True
        return self._describe()

    # ---------------- 数据描述 ---------------- #
    def _describe(self):
        df = self.df
        cols = []
        for c in df.columns:
            s = df[c]
            dtype = _dtype_of(s)
            na = int(s.isna().sum())
            cols.append(
                {
                    "name": str(c),
                    "dtype": dtype,
                    "nonnull": int(s.notna().sum()),
                    "nunique": int(s.nunique(dropna=True)) if dtype != "obj_blob" else -1,
                }
            )
        preview = df.head(20).fillna("").astype(str).values.tolist()
        return {
            "ok": True,
            "file": self.file_name,
            "rows": int(len(df)),
            "cols": len(cols),
            "columns": cols,
            "headers": [str(c) for c in df.columns],
            "preview": preview,
        }

    def get_schema(self):
        if not self.loaded:
            return {"ok": False, "error": "尚未加载数据"}
        return {**self._describe(), "agg_funcs": list(AGG_FUNCS.keys())}

    # ---------------- 数据提取/聚合 ---------------- #
    def categories(self, req):
        """返回各列的去重取值，用于筛选下拉。 req: {cols:[...], top:每列上限}"""
        if not self.loaded:
            return {"ok": False, "error": "尚未加载数据"}
        try:
            cfg = json.loads(req) if isinstance(req, str) else req
        except Exception:
            cfg = req
        top = int(cfg.get("top") or 500)
        out = {}
        for c in cfg.get("cols") or []:
            if c in self.df.columns:
                vals = self.df[c].dropna().astype(str).unique().tolist()[:top]
                out[c] = vals
        return {"ok": True, "values": out}

    def query(self, req):
        """req: {cols:[...], series, filters:{col:[...]}, limit}
        返回按系列分组后的原始列数组，前端完成聚合与绘图。
        returns {ok, series:[{name, data:{col:[v]}}], colTypes:{col:'numeric'|'category'|'datetime'}, warn}"""
        if not self.loaded:
            return {"ok": False, "error": "尚未加载数据"}
        try:
            cfg = json.loads(req) if isinstance(req, str) else req
        except Exception:
            cfg = req
        cols = cfg.get("cols") or []
        series_col = cfg.get("series") or None
        filters = cfg.get("filters") or {}
        limit = int(cfg.get("limit") or 200000)

        df = _apply_filters(self.df, filters)
        if series_col and series_col not in df.columns:
            series_col = None

        groups = [(None, df)] if not series_col else [
            (str(v), g) for v, g in df.groupby(series_col, dropna=False)
        ]
        col_types = {}
        out = []
        for sval, sub in groups:
            if len(sub) > limit:
                sub = sub.sample(limit, random_state=0)
            rec = {"name": "" if sval is None else sval, "data": {}}
            for c in cols:
                if c not in sub.columns:
                    continue
                arr = sub[c].tolist()
                rec["data"][c] = _sanitize(arr)
            out.append(rec)
        for c in cols:
            if c in df.columns:
                col_types[c] = _dtype_of(df[c])
        return {"ok": True, "series": out, "colTypes": col_types}


def _sanitize(arr):
    out = []
    for v in arr:
        if v is None:
            out.append(None)
        elif isinstance(v, float) and v != v:  # NaN
            out.append(None)
        elif hasattr(v, "isoformat"):  # datetime
            out.append(v.isoformat())
        else:
            out.append(v)
    return out


def _to_num(v):
    try:
        return float(v)
    except Exception:
        return float("nan")


def _safe_numeric(s):
    return pd.to_numeric(s, errors="coerce")


def _apply_filters(df, filters):
    for col, keep in (filters or {}).items():
        if col in df.columns and keep:
            df = df[df[col].astype(str).isin([str(k) for k in keep])]
    return df


def _dtype_of(s):
    n = len(s)
    try:
        if pd.api.types.is_datetime64_any_dtype(s):
            return "datetime"
        if pd.api.types.is_numeric_dtype(s):
            return "numeric"
        # 尝试转数值（混合列）
        coerced = pd.to_numeric(s, errors="coerce")
        num_rate = coerced.notna().mean() if n else 0
        if num_rate > 0.9:
            return "numeric"
        return "category"
    except Exception:
        return "category"


def _read_table(path):
    ext = os.path.splitext(path)[1].lower()
    if ext in (".xlsx", ".xls"):
        # 读取第一个 sheet
        xl = pd.ExcelFile(path)
        sheet = xl.sheet_names[0]
        df = xl.parse(sheet)
        return df
    if ext in (".csv", ".tsv", ".txt"):
        enc = "utf-8-sig"
        sample = open(path, "r", encoding=enc).read(4096)
        has_tab = "\t" in sample
        sep = "\t" if has_tab else ","
        return pd.read_csv(path, sep=sep, engine="python", encoding=enc)
    raise ValueError(f"不支持的文件类型：{ext}")


def resource_dir():
    if getattr(sys, "frozen", False):  # PyInstaller 打包后
        return sys._MEIPASS
    return os.path.dirname(os.path.abspath(__file__))


def main():
    api = Api()
    index = os.path.join(resource_dir(), "web", "index.html")
    # 环境变量 CHART_DEMO=1 时启动自动载入示例数据（供自动化验证/演示）
    if os.environ.get("CHART_DEMO") == "1":
        index += "#auto"
    win = webview.create_window(
        f"ChartCanvas 可视化画图 - v{__version__}",
        index,
        js_api=api,
        width=1280,
        height=840,
        min_size=(1000, 640),
    )
    webview.start(debug=False, http_server=True)


if __name__ == "__main__":
    main()
