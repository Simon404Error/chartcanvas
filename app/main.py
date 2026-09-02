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

__version__ = "0.1.1"

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
        self.sheets = []
        self.active_sheet = ""

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

    def load_path(self, path, sheet=None):
        try:
            df, sheets, active = _read_table(path, sheet)
        except Exception as e:
            return {"ok": False, "error": f"读取失败：{_friendly_read_err(e)}"}
        self.df = df
        self.file_name = os.path.basename(path)
        self._last_path = path
        self.sheets = sheets
        self.active_sheet = active
        self.loaded = True
        return self._describe()

    def load_sheet(self, sheet):
        """切换 Excel 工作表。"""
        if not self.sheets:
            return {"ok": False, "error": "非 Excel 或仅一个表"}
        try:
            df, sheets, active = _read_table(self._last_path, sheet)
        except Exception as e:
            return {"ok": False, "error": f"读取失败：{_friendly_read_err(e)}"}
        self.df = df
        self.active_sheet = active
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
            "sheets": self.sheets,
            "active_sheet": self.active_sheet,
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

    # ---------------- 可编辑数据表 ---------------- #
    def table_rows(self, req):
        """返回整表数据供前端编辑。req:{limit}
        返回 rows:[{r:行号, cols:{列名:值}}]"""
        if not self.loaded:
            return {"ok": False, "error": "尚未加载数据"}
        try:
            cfg = json.loads(req) if isinstance(req, str) else req
        except Exception:
            cfg = req
        limit = int(cfg.get("limit") or 2000)
        df = self.df.head(limit)
        headers = [str(c) for c in df.columns]
        rows = []
        for i in range(len(df)):
            rec = {"r": i, "v": {}}
            for c in df.columns:
                rec["v"][str(c)] = _cell(df, i, c)
            rows.append(rec)
        return {"ok": True, "headers": headers, "rows": rows, "total": int(len(self.df)), "shown": len(rows)}

    def update_cells(self, req):
        """前端编辑后回写。req:{cells:[{r, col, value}]}"""
        if not self.loaded:
            return {"ok": False, "error": "尚未加载数据"}
        try:
            cfg = json.loads(req) if isinstance(req, str) else req
        except Exception:
            cfg = req
        for cell in cfg.get("cells", []):
            r, col = int(cell["r"]), str(cell["col"])
            if r < 0 or r >= len(self.df) or col not in self.df.columns:
                continue
            _set_cell(self.df, r, col, cell.get("value"))
        return {"ok": True, "changed": len(cfg.get("cells", []))}

    def delete_rows(self, req):
        """删除若干行。req:{rows:[索引]}"""
        if not self.loaded:
            return {"ok": False, "error": "尚未加载数据"}
        try:
            cfg = json.loads(req) if isinstance(req, str) else req
        except Exception:
            cfg = req
        idx = sorted({int(r) for r in cfg.get("rows", [])}, reverse=True)
        for r in idx:
            if 0 <= r < len(self.df):
                self.df = self.df.drop(self.df.index[r]).reset_index(drop=True)
        return {"ok": True, "deleted": len(idx)}

    def add_row(self):
        """追加一行空行。"""
        if not self.loaded:
            return {"ok": False, "error": "尚未加载数据"}
        self.df.loc[len(self.df)] = [float("nan")] * self.df.shape[1]
        return {"ok": True, "row": int(len(self.df) - 1)}


def _cell(df, r, c):
    v = df.iat[r, df.columns.get_loc(c)]
    if v is None:
        return ""
    if isinstance(v, float) and v != v:
        return ""
    if hasattr(v, "isoformat"):
        return v.isoformat()
    if hasattr(v, "item"):  # numpy 标量 -> 原生
        try:
            return v.item()
        except Exception:
            pass
    if isinstance(v, (int, float, str, bool)) or v is None:
        return v
    return str(v)


def _set_cell(df, r, c, value):
    """写入单元格，保持列类型一致性。value:'' -> NaN"""
    i = df.columns.get_loc(c)
    cur = df.iloc[:, i]
    try:
        if value is None or (isinstance(value, str) and value.strip() == ""):
            df.iat[r, i] = float("nan")
            return
        # 目标列当前为数值则转数值
        if pd.api.types.is_numeric_dtype(cur):
            try:
                df.iat[r, i] = float(value)
            except Exception:
                # 该列可能因此转为 object，改后重新推断
                df.iat[r, i] = value
        else:
            df.iat[r, i] = str(value)
    except Exception:
        df.iat[r, i] = value


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


def _friendly_read_err(e):
    """把底层异常转成对用户友好的中文提示。"""
    msg = str(e)
    low = msg.lower()
    if "xlrd" in low and ("xlrd biff" in low or "unsupported format" in low or "install xlrd" in low):
        return "旧版 .xls 需要 xlrd 库，请安装后重试"
    if "no module named 'xlrd'" in low:
        return "缺少 xlrd 库，无法读取 .xls"
    if "no module named 'openpyxl'" in low or "install openpyxl" in low:
        return "缺少 openpyxl 库，无法读取 .xlsx"
    if "unsupported format" in low or "file is not a zip" in low or "bad magic" in low:
        return "文件可能不是有效的 Excel（或已损坏/被加密）"
    if "permission" in low or "is being used by another process" in low:
        return "文件正被占用，请先关闭打开它的程序"
    if "not a valid filename" in low or "no such file" in low or "does not exist" in low:
        return "找不到该文件，可能路径已改变"
    # 截断过长的异常
    return (msg[:300] + "…") if len(msg) > 300 else msg


def _read_table(path, sheet=None):
    """读取并返回 (DataFrame, sheet 列表, 当前 sheet)。
    Excel 支持多 sheet；sheet=None 时自动取第一个有内容的表。"""
    ext = os.path.splitext(path)[1].lower()
    if ext in (".xlsx", ".xls"):
        xl = pd.ExcelFile(path)
        names = list(xl.sheet_names)
        if sheet is None or sheet not in names:
            # 找第一个非空内容的 sheet
            chosen = _first_populated(xl)
            sheet = chosen
        df = xl.parse(sheet)
        # 清理：删除全空列/行
        df = df.dropna(axis=1, how="all")
        df = df.dropna(axis=0, how="all")
        if df.shape[1] == 0:
            raise ValueError("该工作表没有可用数据列")
        return df, names, sheet
    if ext in (".csv", ".tsv", ".txt"):
        df = _read_text(path)
        return df, ["CSV 数据"], "CSV 数据"
    raise ValueError(f"不支持的文件类型：{ext}")


def _first_populated(xl):
    """返回第一个含数据的 sheet 名。"""
    for name in xl.sheet_names:
        try:
            probe = xl.parse(name, nrows=50)
            nonempty = probe.notna().any(axis=0).sum()
            if probe.shape[1] > 0 and nonempty > 0:
                return name
        except Exception:
            continue
    return xl.sheet_names[0]


def _read_text(path):
    for enc in ("utf-8-sig", "gbk", "utf-8", "latin-1"):
        try:
            sample = open(path, "r", encoding=enc).read(4096)
            has_tab = "\t" in sample and "," not in sample
            sep = "\t" if has_tab else ","
            df = pd.read_csv(path, sep=sep, engine="python", encoding=enc)
            if df.shape[1] >= 1:
                return df
        except Exception:
            continue
    raise ValueError("无法识别 CSV 编码，请用 UTF-8 或 GBK 保存")


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
