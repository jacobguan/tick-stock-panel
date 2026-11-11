import { describe, expect, it } from "vitest";
import type { OHLC } from "./chart-types";
import { computeMainFormula, ema, xma, zigzagPivots } from "./main-formula";

let sequence = 0;
// 逐日递增的真实日期：公式本身不吃日期，但保持与日K数据同形。
const bar = (
  open: number,
  high: number,
  low: number,
  close: number,
  volume = 100,
): OHLC => ({
  date: new Date(Date.UTC(2024, 0, 1) + sequence++ * 86_400_000)
    .toISOString()
    .slice(0, 10),
  open,
  high,
  low,
  close,
  volume,
});
const flat = (value: number, volume = 100) =>
  bar(value, value, value, value, volume);
const daily = (values: number[]) =>
  values.map((value) => bar(value, value, value, value));

describe("xma / ema", () => {
  it("XMA 是中心窗口截断后的 N/2+1 根因果均值", () => {
    // period=2 → 窗口 2；period=34 → 窗口 18，与策略侧 _xma_causal 同口径。
    expect(xma([10, 20, 30], 2)).toEqual([10, 15, 25]);
    expect(xma([10], 34)).toEqual([10]);
    const ramp = Array.from({ length: 20 }, (_, i) => i + 1);
    const values = xma(ramp, 34);
    // 第 18 根（下标 17）是 1..18 的均值，第 20 根是 3..20 的均值。
    expect(values[17]).toBeCloseTo(9.5, 10);
    expect(values[19]).toBeCloseTo(11.5, 10);
    // 开头不足一整窗时用已有样本求均值，不能开头就补 0。
    expect(values[0]).toBe(1);
  });

  it("EMA 使用 2/(N+1) 平滑系数", () => {
    expect(ema([10, 20], 3)).toEqual([10, 15]);
  });
});

describe("上下轨", () => {
  it("一字行情时上下轨都收敛到同一价位", () => {
    const rows = Array.from({ length: 40 }, () => flat(10));
    const formula = computeMainFormula(rows);
    expect(formula.upper).toHaveLength(40);
    expect(formula.upper.every((value) => Math.abs(value - 10) < 1e-9)).toBe(
      true,
    );
    expect(formula.lower.every((value) => Math.abs(value - 10) < 1e-9)).toBe(
      true,
    );
  });

  it("单边行情里上下轨跟随方向标色", () => {
    // 双层 18 根均值在单调行情里方向稳定，用单调行验证分色，不用"涨完就跌"的拐点。
    const up = Array.from({ length: 60 }, (_, i) => flat(10 + i * 0.1));
    expect(computeMainFormula(up).upperRising.slice(1).every(Boolean)).toBe(
      true,
    );
    const down = Array.from({ length: 60 }, (_, i) => flat(20 - i * 0.1));
    const falling = computeMainFormula(down);
    expect(falling.upperRising.slice(1).some(Boolean)).toBe(false);
    expect(falling.lowerRising.slice(1).some(Boolean)).toBe(false);
    // 测试用一字K线，上下轨在无振幅时重合，只需保证通道不倒挂。
    expect(falling.upper.at(-1)!).toBeGreaterThanOrEqual(falling.lower.at(-1)!);
  });
});

describe("筹码分布", () => {
  it("按几何十档统计近 168 根成交量，宽度按占比分配", () => {
    const rows = Array.from({ length: 200 }, (_, i) => {
      const close = i % 2 === 0 ? 10 : 20;
      return bar(close, close * 1.01, close * 0.99, close, 100);
    });
    const { chips } = computeMainFormula(rows);
    expect(chips).toHaveLength(10);
    // 168 根窗口里高低两个价位各占一半，只有最上和最下两档有量。
    expect(chips[0].bars).toBe(252);
    expect(chips[9].bars).toBe(252);
    expect(chips.slice(1, 9).every((bucket) => bucket.bars === 0)).toBe(true);
    expect(chips[0].top).toBeGreaterThan(chips[0].bottom);
    expect(chips[0].top).toBeGreaterThan(chips[1].top);
  });

  it("十档都按上沿在上、下沿在下排列，且高档位始终更贵", () => {
    const rows = Array.from({ length: 200 }, (_, i) => {
      const close = 5 + Math.sin(i / 7) * 3;
      return bar(close, close * 1.02, close * 0.98, close, 100);
    });
    const { chips } = computeMainFormula(rows);
    expect(chips).toHaveLength(10);
    for (const bucket of chips)
      expect(bucket.top).toBeGreaterThan(bucket.bottom);
    for (let i = 1; i < chips.length; i++)
      expect(chips[i - 1].bottom).toBeGreaterThanOrEqual(chips[i].top * 0.98);
  });

  it("没有价差或没有成交量时不给筹码", () => {
    expect(
      computeMainFormula(Array.from({ length: 30 }, () => flat(10, 0))).chips,
    ).toEqual([]);
  });
});

describe("缺口", () => {
  it("未回补的向下缺口画出从缺口日到最后一根的色带", () => {
    const rows = [
      bar(10.2, 10.5, 10, 10.1),
      bar(9.4, 9.5, 9, 9.2),
      bar(9.2, 9.4, 9.1, 9.3),
      bar(9.1, 9.3, 9, 9.1),
    ];
    expect(computeMainFormula(rows).gaps).toEqual([
      { start: 1, end: 3, top: 10, bottom: 9.5, kind: "down" },
    ]);
  });

  it("价格回到缺口上沿后不再画出色带", () => {
    const rows = [
      bar(10.2, 10.5, 10, 10.1),
      bar(9.4, 9.5, 9, 9.2),
      bar(9.2, 10.2, 9.1, 10.0),
    ];
    expect(computeMainFormula(rows).gaps).toEqual([]);
  });

  it("未回补的向上缺口同样成带", () => {
    const rows = [
      bar(9, 9, 8.9, 8.95),
      bar(10.2, 10.4, 10.1, 10.3),
      bar(10.3, 10.5, 10.2, 10.4),
    ];
    expect(computeMainFormula(rows).gaps).toEqual([
      { start: 1, end: 2, top: 10.1, bottom: 9, kind: "up" },
    ]);
  });

  it("份额折算这类超出涨跌停限制的跳空不被当成缺口", () => {
    // 实测样本：3:1 折算后 2.438 → 0.801，不复权口径下跌幅远超 20%。
    const rows = [
      bar(2.4, 2.45, 2.35, 2.438),
      bar(0.8, 0.81, 0.78, 0.793),
      bar(0.79, 0.8, 0.78, 0.785),
    ];
    expect(computeMainFormula(rows).gaps).toEqual([]);
  });
});

describe("ZIG 转折点", () => {
  it("回撤达到 10% 才确认前高为卖点", () => {
    const values = [
      1,
      ...Array.from({ length: 10 }, (_, i) => 1.02 + i * 0.02),
      1.18,
      1.16,
      1.14,
      1.12,
      1.1,
      1.08,
    ];
    expect(zigzagPivots(values, 10)).toEqual([{ index: 10, kind: "sell" }]);
  });

  it("幅度不足时不给枢轴", () => {
    expect(zigzagPivots([1, 1.05, 1.02, 1.04], 10)).toEqual([]);
  });
});

describe("游资大单", () => {
  it("EMA 创 5 日新高后放量长阳出标记", () => {
    const rows = [
      ...Array.from({ length: 12 }, () => flat(10)),
      ...daily([9.99, 9.98, 9.97, 9.96, 9.95, 9.94]),
      // 收盘较前值 +3.1%，量能翻倍，同时把 EMA20 顶回 5 日新高。
      bar(9.95, 10.3, 9.95, 10.25, 300),
    ];
    const hot = computeMainFormula(rows).markers.filter(
      (marker) => marker.kind === "hot",
    );
    expect(hot).toEqual([{ index: 18, kind: "hot", label: "游资" }]);
  });

  it("量能或涨幅不达标时不出标记", () => {
    const rows = [
      ...Array.from({ length: 12 }, () => flat(10)),
      ...daily([9.99, 9.98, 9.97, 9.96, 9.95, 9.94]),
      bar(9.95, 10.3, 9.95, 10.25, 150),
    ];
    expect(computeMainFormula(rows).markers).toEqual([]);
  });
});

describe("computeMainFormula", () => {
  it("空数据返回空结构", () => {
    expect(computeMainFormula([])).toEqual({
      upper: [],
      lower: [],
      upperRising: [],
      lowerRising: [],
      emaLevels: [],
      chips: [],
      gaps: [],
      markers: [],
    });
  });

  it("五级 EMA 均线束按多头排列逐点标色", () => {
    const rows = Array.from({ length: 80 }, (_, i) => flat(10 + i * 0.1));
    const { emaLevels } = computeMainFormula(rows);
    expect(emaLevels.map((level) => level.key)).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
    ]);
    expect(
      emaLevels.filter((level) => level.thick).map((level) => level.key),
    ).toEqual(["a", "e"]);
    // 单边上涨时短周期始终在上，五根线全部为多头色。
    expect(emaLevels.every((level) => level.bull.at(-1))).toBe(true);
  });
});
