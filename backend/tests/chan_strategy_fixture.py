"""缠论三买策略测试共享夹具（不是 pytest 用例文件）。"""
from __future__ import annotations

import importlib.util
import sys
from datetime import date, timedelta
from itertools import pairwise
from pathlib import Path

import polars as pl

PROJECT_ROOT = Path(__file__).resolve().parents[2]
CUSTOM_DIR = PROJECT_ROOT / "data" / "strategies" / "custom"
STRATEGY_PATH = CUSTOM_DIR / "custom_20261110_chan_third_buy.py"
ETF_STRATEGY_PATH = CUSTOM_DIR / "custom_20261110_chan_third_buy_etf.py"
CORE_PATH = CUSTOM_DIR / "_chan_third_buy_core.py"

SYMBOL = "TEST.SZ"
START = date(2024, 1, 1)
CONFIRM_INDEX = 31


def _exec_module(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_strategy(path: Path = STRATEGY_PATH, name: str = "chan_third_buy"):
    strategy_dir = str(path.parent)
    sys.path.insert(0, strategy_dir)
    try:
        sys.modules.pop("_chan_third_buy_core", None)
        sys.modules.pop(name, None)
        return _exec_module(path, name)
    finally:
        sys.path.remove(strategy_dir)


def load_core():
    strategy_dir = str(CORE_PATH.parent)
    sys.path.insert(0, strategy_dir)
    try:
        sys.modules.pop("_chan_third_buy_core", None)
        return _exec_module(CORE_PATH, "_chan_third_buy_core")
    finally:
        sys.path.remove(strategy_dir)


def make_frame(volume: float = 1.0) -> pl.DataFrame:
    """无包含关系的锯齿行情。

    0→5→10→15→20 构成三笔中枢，20→25 向上离开，25→30 回抽不跌回 ZG，
    30 为回抽底分型、31 为其确认 K 线。31 之后先做一次不足 3% 的弱反弹
    （32，分型被 min_bars 过滤），再跌破 ZG（37），用于验证全区间重算
    不会把 31 日已经成立的三买信号抹掉。
    """
    turning = [
        (0, 10.00),
        (5, 11.00),
        (10, 10.20),
        (15, 11.10),
        (20, 10.30),
        (25, 12.00),
        (30, 11.50),
        (31, 11.55),
        (32, 11.58),
        (33, 11.50),
        (34, 11.35),
        (35, 11.20),
        (36, 11.05),
        (37, 10.90),
        (38, 11.00),
    ]
    prices = [0.0] * (turning[-1][0] + 1)
    prices[0] = turning[0][1]
    for (a, pa), (b, pb) in pairwise(turning):
        for i in range(a + 1, b + 1):
            prices[i] = pa + (pb - pa) * (i - a) / (b - a)

    dates = [START + timedelta(days=i) for i in range(len(prices))]
    return pl.DataFrame(
        {
            "symbol": [SYMBOL] * len(prices),
            "date": dates,
            "open": prices,
            "high": [price * 1.0005 for price in prices],
            "low": [price * 0.9995 for price in prices],
            "close": prices,
            "volume": [volume] * len(prices),
        }
    )


def hits(df: pl.DataFrame) -> set[tuple[str, date]]:
    return set(df.select(["symbol", "date"]).iter_rows())