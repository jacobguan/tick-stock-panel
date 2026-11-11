"""缠论三买策略的 as-of 因果性回归。

自定义策略位于 gitignored 的 data/strategies/custom/，不随仓库分发；
文件不存在时跳过。测试直接加载真实策略文件，避免复制算法造成漂移。
"""
from __future__ import annotations

from datetime import timedelta

import polars as pl
import pytest
from chan_strategy_fixture import (
    CONFIRM_INDEX,
    START,
    STRATEGY_PATH,
    SYMBOL,
    hits,
    load_strategy,
    make_frame,
)

pytestmark = pytest.mark.skipif(
    not STRATEGY_PATH.exists(), reason="custom chan strategy not present"
)


def test_third_buy_signal_is_point_in_time() -> None:
    module = load_strategy()
    frame = make_frame()
    full_hits = hits(module.filter_history(frame, {}))
    confirm_date = START + timedelta(days=CONFIRM_INDEX)

    assert full_hits == {(SYMBOL, confirm_date)}, (
        "回抽底分型确认日应当产生三买信号；"
        "若为空，说明全区间重算用后续更低点抹掉了当时已成立的信号"
    )

    for i in range(len(frame)):
        cutoff = START + timedelta(days=i)
        truncated = frame.filter(pl.col("date") <= cutoff)
        expected = {
            (symbol, hit_date)
            for symbol, hit_date in full_hits
            if hit_date <= cutoff
        }
        actual = hits(module.filter_history(truncated, {}))
        assert actual == expected, f"as-of mismatch at {cutoff}: {actual} != {expected}"