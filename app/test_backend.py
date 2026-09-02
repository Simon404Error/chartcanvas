# -*- coding: utf-8 -*-
"""后端数据链路冒烟测试。"""
import sys, json, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import main

csv_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sample_data", "经营数据.csv")
xlsx_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sample_data", "经营数据.xlsx")

ok = True
def check(name, cond, extra=""):
    global ok
    extra = str(extra)
    print(("PASS " if cond else "FAIL ") + name + ("  " + extra if extra else ""))
    if not cond: ok = False

# 文件过滤器格式校验（与 create_file_dialog 相同规则）
try:
    from webview.util import parse_file_type as _pft
    _file_types = (
        "Excel 与 CSV 文件 (*.xlsx;*.xls;*.csv;*.tsv;*.txt)",
        "Excel 工作簿 (*.xlsx;*.xls)",
        "CSV 文本文件 (*.csv;*.tsv;*.txt)",
        "所有文件 (*.*)",
    )
    for _ft in _file_types:
        _pft(_ft)
    check("file_types valid", True)
except ImportError:
    print("(skip: no pywebview)")
except Exception as e:
    check("file_types valid", False, e)

api = main.Api()

# CSV load
r = api.load_path(csv_path)
check("csv load", r["ok"], f"rows={r['rows']} cols={r['cols']}")
cols = [c["name"] for c in r["columns"]]
check("csv 7 cols", len(cols) == 7, str(cols))
names = ["月份","地区","产品","销售额","成本","利润","客户数"]
check("col names", all(n in cols for n in names))

# query grouping by 地区
q = api.query(json.dumps({"cols": ["月份","销售额"], "series": "地区", "filters": {}, "limit": 100000}))
check("query ok", q["ok"], f"groups={len(q['series'])}")
check("query 4 regions", len(q["series"]) == 4, [g["name"] for g in q["series"]])
check("colTypes numeric", q["colTypes"].get("销售额") == "numeric", str(q["colTypes"]))
g0 = q["series"][0]
check("series data len", len(g0["data"].get("月份", [])) > 0, f"{g0['name']} n={len(g0['data'].get('月份', []))}")

# query with filter
qf = api.query(json.dumps({"cols": ["地区","销售额"], "series": "", "filters": {"地区": ["华东"]}}))
check("query filter", qf["ok"], f"groups={len(qf['series'])}")
check("filter applied", qf["ok"] and all(v == "华东" for v in qf["series"][0]["data"]["地区"]), "only 华东")

# xlsx load
r2 = api.load_path(xlsx_path)
check("xlsx load", r2["ok"], f"rows={r2['rows']}")

# categories
rc = api.categories(json.dumps({"cols": ["地区"], "top": 100}))
check("categories", rc["ok"] and len(rc["values"]["地区"]) == 4, str(rc["values"]))

print("\nRESULT:", "ALL PASS" if ok else "HAS FAILURES")
sys.exit(0 if ok else 1)
