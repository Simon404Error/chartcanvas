# -*- coding: utf-8 -*-
"""生成一份演示 Excel/CSV 数据，便于开箱体验。"""
import os
import random

random.seed(7)

def make_csv(path):
    rows = []
    headers = ["月份", "地区", "产品", "销售额", "成本", "利润", "客户数"]
    months = [f"2025-{m:02d}" for m in range(1, 13)]
    regions = ["华东", "华南", "华北", "西南"]
    products = ["手机", "笔记本", "平板", "耳机"]
    for month in months:
        for region in regions:
            for product in products:
                sales = random.randint(20, 90) * 10
                cost = int(sales * random.uniform(0.55, 0.75))
                rows.append([month, region, product, sales, cost, sales - cost, random.randint(50, 500)])
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        f.write(",".join(headers) + "\n")
        for r in rows:
            f.write(",".join(map(str, r)) + "\n")
    return len(rows)

def make_xlsx(path):
    from openpyxl import Workbook
    wb = Workbook()
    ws = wb.active
    ws.title = "经营数据"
    headers = ["月份", "地区", "产品", "销售额", "成本", "利润", "客户数"]
    ws.append(headers)
    months = [f"2025-{m:02d}" for m in range(1, 13)]
    regions = ["华东", "华南", "华北", "西南"]
    products = ["手机", "笔记本", "平板", "耳机"]
    for month in months:
        for region in regions:
            for product in products:
                sales = random.randint(20, 90) * 10
                cost = int(sales * random.uniform(0.55, 0.75))
                ws.append([month, region, product, sales, cost, sales - cost, random.randint(50, 500)])
    wb.save(path)
    return ws.max_row - 1

if __name__ == "__main__":
    base = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sample_data")
    os.makedirs(base, exist_ok=True)
    csv_rows = make_csv(os.path.join(base, "经营数据.csv"))
    xlsx_rows = make_xlsx(os.path.join(base, "经营数据.xlsx"))
    print(f"已生成演示数据：\n  经营数据.csv  ({csv_rows} 行)\n  经营数据.xlsx ({xlsx_rows} 行)\n  目录: {base}")
