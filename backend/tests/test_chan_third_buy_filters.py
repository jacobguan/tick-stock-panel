"""缠论三买 P1/P2 过滤器与 ETF 变体回归。"""
from __future__ import annotations

import sys
from datetime import timedelta

import polars as pl
import pytest
from chan_strategy_fixture import (
    CONFIRM_INDEX,
    ETF_STRATEGY_PATH,
    START,
    STRATEGY_PATH,
    hits,
    load_core,
    load_strategy,
    make_frame,
)

pytestmark = pytest.mark.skipif(
    not STRATEGY_PATH.exists(), reason="custom chan strategy not present"
)
CONFIRM_DATE = START + timedelta(days=CONFIRM_INDEX)


def _signal_dates(module, frame: pl.DataFrame, params: dict) -> set:
    return {hit_date for _, hit_date in hits(module.filter_history(frame, params))}


def _expanding_pullback_frame() -> pl.DataFrame:
    frame = make_frame()
    volumes = [1.0] * len(frame)
    for i in range(26, 31):
        volumes[i] = 10.0
    return frame.with_columns(pl.Series("volume", volumes))


def test_pullback_volume_filter_blocks_expanding_pullback() -> None:
    module = load_strategy()
    frame = _expanding_pullback_frame()

    blocked = _signal_dates(
        module,
        frame,
        {"require_pullback_shrink": True, "pullback_vol_ratio_max": 1.2},
    )
    assert blocked == set()

    allowed = _signal_dates(module, frame, {"require_pullback_shrink": False})
    assert allowed == {CONFIRM_DATE}


def test_breakout_volume_uses_pre_breakout_baseline() -> None:
    module = load_strategy()
    frame = make_frame()
    volumes = [1.0] * len(frame)
    for i in range(21, 26):
        volumes[i] = 2.0
    frame = frame.with_columns(pl.Series("volume", volumes))

    # 突破笔均量约 1.83，突破前 5 日均量为 1.0；若错误地用包含突破
    # 自身的后 5 日均量（2.0）作基准，mult=1.0 会被误杀。
    assert _signal_dates(
        module, frame, {"require_breakout_volume": True, "breakout_vol_mult": 1.0}
    ) == {CONFIRM_DATE}
    assert _signal_dates(
        module, frame, {"require_breakout_volume": True, "breakout_vol_mult": 2.0}
    ) == set()


def test_entry_gap_and_pullback_gap_filters() -> None:
    module = load_strategy()
    frame = make_frame()

    assert _signal_dates(module, frame, {"max_entry_gap_pct": 1.0}) == set()
    assert _signal_dates(module, frame, {"max_entry_gap_pct": 10.0}) == {CONFIRM_DATE}
    assert _signal_dates(module, frame, {"max_pullback_gap_pct": 1.0}) == set()
    assert _signal_dates(module, frame, {"max_pullback_gap_pct": 10.0}) == {CONFIRM_DATE}
    module = load_strategy()
    frame = make_frame()

    assert _signal_dates(module, frame, {"max_entry_gap_pct": 1.0}) == set()
    assert _signal_dates(module, frame, {"max_entry_gap_pct": 10.0}) == {CONFIRM_DATE}


def test_pullback_length_filter() -> None:
    module = load_strategy()
    frame = make_frame()

    assert _signal_dates(module, frame, {"max_pullback_bars": 3}) == set()
    assert _signal_dates(module, frame, {"max_pullback_bars": 10}) == {CONFIRM_DATE}


def test_atr_stroke_threshold() -> None:
    module = load_strategy()
    frame = make_frame()

    assert _signal_dates(module, frame, {"stroke_atr_mult": 100.0}) == set()
    assert _signal_dates(module, frame, {"stroke_atr_mult": 0.0}) == {CONFIRM_DATE}
    assert _signal_dates(module, frame, {"zone_atr_mult": 100.0}) == set()
    assert _signal_dates(module, frame, {"zone_atr_mult": 0.0}) == {CONFIRM_DATE}


def test_signal_cooldown_suppresses_close_signals(monkeypatch) -> None:
    module = load_strategy()
    core = sys.modules["_chan_third_buy_core"]
    monkeypatch.setattr(core, "_is_third_buy", lambda *args, **kwargs: True)
    frame = make_frame()

    without_cooldown = _signal_dates(module, frame, {"signal_cooldown_days": 0})
    with_cooldown = _signal_dates(module, frame, {"signal_cooldown_days": 100})

    assert len(without_cooldown) >= 3
    assert with_cooldown == {min(without_cooldown)}


def test_ma_filters() -> None:
    module = load_strategy()
    frame = make_frame()

    assert _signal_dates(module, frame, {"require_above_ma20": True}) == {CONFIRM_DATE}
    # 39 根 K 线不足 MA60 预热，趋势过滤必须 fail-closed。
    assert _signal_dates(module, frame, {"require_ma_trend": True}) == set()
    assert _signal_dates(module, frame, {"require_ma_trend": False}) == {CONFIRM_DATE}


def test_zone_extension_uses_wider_common_overlap() -> None:
    core = load_core()
    strokes = [
        {"start_i": 0, "end_i": 0, "start_p": 10.4, "end_p": 10.8, "dir": 1,
         "high": 10.8, "low": 10.4},
        {"start_i": 0, "end_i": 0, "start_p": 10.8, "end_p": 10.4, "dir": -1,
         "high": 10.9, "low": 10.4},
        {"start_i": 0, "end_i": 0, "start_p": 10.4, "end_p": 11.5, "dir": 1,
         "high": 11.5, "low": 10.6},
        {"start_i": 0, "end_i": 0, "start_p": 11.5, "end_p": 10.6, "dir": -1,
         "high": 11.2, "low": 10.6},
        {"start_i": 0, "end_i": 0, "start_p": 10.6, "end_p": 11.0, "dir": 1,
         "high": 11.0, "low": 10.4},
        {"start_i": 0, "end_i": 0, "start_p": 11.0, "end_p": 11.6, "dir": 1,
         "high": 11.6, "low": 11.0},
        {"start_i": 0, "end_i": 0, "start_p": 11.6, "end_p": 10.9, "dir": -1,
         "high": 11.6, "low": 10.9},
    ]
    common = dict(
        zs_min=1.0,
        zs_max=30.0,
        max_gap=10.0,
        max_entry_gap_pct=0.0,
        confirm_close=10.9,
        max_pullback_bars=0,
        mend=[0],
        volume=[1.0],
        require_pullback_shrink=False,
        pullback_vol_ratio_max=1.2,
        require_breakout_volume=False,
        breakout_vol_mult=1.0,
    )

    assert core._is_third_buy(strokes, zone_max_strokes=5, **common) is True
    assert core._is_third_buy(strokes, zone_max_strokes=3, **common) is False


def test_stock_meta_is_stock_only_and_scoring_sums_to_one() -> None:
    module = load_strategy()
    meta = module.META
    assert meta["asset_types"] == ["stock"]
    assert sum(meta["scoring"].values()) == pytest.approx(1.0)
    param_ids = {p["id"] for p in meta["params"]}
    assert {
        "zone_max_strokes",
        "stroke_atr_mult",
        "zone_atr_mult",
        "max_entry_gap_pct",
        "max_pullback_bars",
        "require_pullback_shrink",
        "require_breakout_volume",
        "require_ma_trend",
    } <= param_ids


def test_etf_variant_has_etf_defaults_and_emits_signal() -> None:
    if not ETF_STRATEGY_PATH.exists():
        pytest.skip("ETF variant not present")
    module = load_strategy(ETF_STRATEGY_PATH, "chan_third_buy_etf")
    meta = module.META
    assert meta["asset_types"] == ["etf"]
    defaults = {p["id"]: p["default"] for p in meta["params"]}
    assert defaults["min_stroke_pct"] < 3.0
    assert defaults["max_pullback_gap_pct"] <= 8.0
    assert sum(meta["scoring"].values()) == pytest.approx(1.0)

    frame = make_frame()
    assert _signal_dates(module, frame, {}) == {CONFIRM_DATE}