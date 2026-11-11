import type { OHLC } from "./chart-types";

/**
 * 通达信主图公式（docs 侧「主图.txt」）的前端实现。
 *
 * 公式里的 FINANCE/DYNAINFO/WINNER 等行情与财务常量在日K接口中没有对应字段，
 * 这里只实现由 OHLCV 可以严格复现的图形部分；筹码、缺口等窗口口径与原文一致。
 */

/** 筹码分布取价窗口（原文 DA1 = MIN(168, TOTALBARSCOUNT)）。 */
const CHIP_WINDOW = 168;
/** 筹码档位数量（原文几何十等分）。 */
const CHIP_LEVELS = 10;
/** 缺口回溯的最大个数（原文 YXXQK1..YXXQK10）。 */
const GAP_LOOKBACK = 10;

export interface ChipBucket {
  /** 档位上沿价格 */
  top: number;
  /** 档位下沿价格 */
  bottom: number;
  /** 横向条形宽度，单位「根K线」 */
  bars: number;
}

export interface FormulaGap {
  /** 缺口当日在 rows 中的下标 */
  start: number;
  /** 缺口未回补区间的最后一个下标 */
  end: number;
  top: number;
  bottom: number;
  kind: "up" | "down";
}

export interface FormulaMarker {
  index: number;
  kind: "buy" | "sell" | "hot";
  label: string;
}

export interface FormulaEmaLevel {
  key: string;
  values: number[];
  /** 短周期在上（原文中上A..E），用于红色着色 */
  bull: boolean[];
  /** 原文 LINETHICK2 的两根，其余为 DOTLINE */
  thick: boolean;
}

export interface MainFormula {
  upper: number[];
  lower: number[];
  /** 上轨较前值抬升（原文 上轨>=REF(上轨,1) 画红） */
  upperRising: boolean[];
  lowerRising: boolean[];
  emaLevels: FormulaEmaLevel[];
  chips: ChipBucket[];
  gaps: FormulaGap[];
  markers: FormulaMarker[];
}

const EMPTY_FORMULA: MainFormula = {
  upper: [],
  lower: [],
  upperRising: [],
  lowerRising: [],
  emaLevels: [],
  chips: [],
  gaps: [],
  markers: [],
};

/**
 * 通达信 XMA(X,N) 是「偏移移动平均」：以当前 bar 为中心取 N 根，属于未来函数。
 * 图上不能引用未来数据，这里按策略侧 custom_20261104_below_lower_rail.py 的
 * _xma_causal 口径截断到当日，等价于 N/2+1 根因果均值（N=34 时就是 18 日均线）。
 * 开头不足一整窗时与 rolling_mean(min_samples=1) 一致，用已有样本求均值。
 */
export function xma(values: number[], period: number): number[] {
  const window = Math.floor(period / 2) + 1;
  const result: number[] = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= window) sum -= values[i - window];
    result.push(sum / Math.min(i + 1, window));
  }
  return result;
}

/** 通达信 EMA(X,N)，平滑系数 2/(N+1)。 */
export function ema(values: number[], period: number): number[] {
  const alpha = 2 / (period + 1);
  const result: number[] = [];
  for (let i = 0; i < values.length; i++) {
    result.push(
      i === 0 ? values[0] : result[i - 1] + alpha * (values[i] - result[i - 1]),
    );
  }
  return result;
}

/**
 * 上下轨：XMA(XMA(H,34),34) 与 XMA(XMA(L,34),34) 构成的通道。
 * XMA 按因果口径截断（双层 18 根均值），与选股策略里的 _xma_causal 完全一致。
 * 原文用 IF(>= 前值) 分色，等值时绿线后画覆盖红线，故这里严格大于才算红。
 */
function trendBands(rows: OHLC[]) {
  const highBand = xma(
    xma(
      rows.map((row) => row.high),
      34,
    ),
    34,
  );
  const lowBand = xma(
    xma(
      rows.map((row) => row.low),
      34,
    ),
    34,
  );
  const upper = highBand.map((value, i) => 2 * value - lowBand[i]);
  const lower = lowBand.map(
    (value, i) => value - 1.5 * (highBand[i] - lowBand[i]),
  );
  const rising = (values: number[]) =>
    values.map((value, i) => i > 0 && value > values[i - 1]);
  return {
    upper,
    lower,
    upperRising: rising(upper),
    lowerRising: rising(lower),
  };
}

/**
 * EMA 均线束：M5 依次套 4 层 EMA(,2) 得到中下 A..E；
 * 原文的「中上 A..E」只是把同一根线在多头排列时改画红色，这里用逐点颜色表达。
 */
function emaLadder(rows: OHLC[]): FormulaEmaLevel[] {
  const m5 = ema(
    rows.map((row) => row.close),
    5,
  );
  const levels: {
    key: string;
    values: number[];
    fast: number[];
    thick: boolean;
  }[] = [];
  let current = m5;
  for (const [index, key] of ["a", "b", "c", "d", "e"].entries()) {
    const values = ema(current, 2);
    levels.push({
      key,
      values,
      fast: current,
      thick: index === 0 || index === 4,
    });
    current = values;
  }
  return levels.map(({ key, values, fast, thick }) => ({
    key,
    values,
    thick,
    bull: values.map((value, i) => fast[i] > value),
  }));
}

/** 单根K线收盘价落在第几档筹码（0 = 最高档，9 = 最低档）。 */
function chipLevel(
  close: number,
  high: number,
  low: number,
  step: number,
): number {
  for (let level = 1; level <= 7; level++)
    if (close >= high / step ** level) return level - 1;
  for (let level = 3; level >= 1; level--)
    if (close >= low * step ** level) return 10 - level;
  return CHIP_LEVELS - 1;
}

/**
 * 筹码分布：几何十等分价格档，取近 CHIP_WINDOW 根K线的成交量；
 * 原文 L1..L10 是「滚动窗口求和后再取窗口内最大值」，这里保持同一口径。
 */
function chipProfile(rows: OHLC[]): ChipBucket[] {
  const window = Math.min(CHIP_WINDOW, rows.length);
  if (window < 10) return [];
  const recent = rows.slice(-window);
  const high = Math.max(...recent.map((row) => row.high));
  const low = Math.min(...recent.map((row) => row.low));
  if (!(high > 0) || !(low > 0)) return [];
  const step = low > 0 ? Math.exp(Math.log(high / low) / CHIP_LEVELS) : 1;
  // 一字板等极端样本没有价差，几何分档退化，直接不给筹码。
  if (!(step > 1 + 1e-9)) return [];
  const segmentStart = Math.max(0, rows.length - 2 * window);
  const segment = rows.slice(segmentStart);
  const prefix = [new Array<number>(CHIP_LEVELS).fill(0)];
  for (const row of segment) {
    const next = prefix[prefix.length - 1].slice();
    const volume =
      row.volume != null && Number.isFinite(row.volume) && row.volume > 0
        ? row.volume
        : 0;
    next[chipLevel(row.close, high, low, step)] += volume;
    prefix.push(next);
  }
  const totals = new Array<number>(CHIP_LEVELS).fill(0);
  // 原文 HHV(LHx, DA)：只统计结束于最近 DA 根的滚动窗口。
  for (let end = segment.length - window; end < segment.length; end++) {
    const from = Math.max(0, end + 1 - window),
      to = end + 1;
    for (let level = 0; level < CHIP_LEVELS; level++)
      totals[level] = Math.max(
        totals[level],
        prefix[to][level] - prefix[from][level],
      );
  }
  const sum = totals.reduce((acc, value) => acc + value, 0);
  if (!(sum > 0)) return [];
  const bounds: [number, number][] = [];
  for (let level = 1; level <= 7; level++)
    bounds.push([(high / step ** (level - 1)) * 0.99, high / step ** level]);
  // 原文最后三档是自下而上写的，统一成 [上沿, 下沿] 后交给绘制层，避免 top/bottom 倒挂。
  bounds.push([low * step ** 3 * 0.99, low * step ** 2]);
  bounds.push([low * step ** 2 * 0.99, low * step]);
  bounds.push([low * step * 0.99, low]);
  return bounds.map(([top, bottom], level) => ({
    top,
    bottom,
    // 原文 CEILING(DA*Lx/SSS)*3：最宽一档横跨 3 倍窗口。
    bars: Math.ceil((window * totals[level]) / sum) * 3,
  }));
}

/**
 * 未回补缺口的成本带：缺口当日之后最高价始终未回到缺口上沿即视为未回补，
 * 带体从缺口当日一直画到最后一根K线。
 */
function unfilledGaps(rows: OHLC[]): FormulaGap[] {
  const last = rows.length - 1;
  const result: FormulaGap[] = [];
  let found = 0;
  for (let i = last; i >= 1 && found < GAP_LOOKBACK; i--) {
    const down = rows[i].high < rows[i - 1].low;
    const up = rows[i].low > rows[i - 1].high;
    if (!down && !up) continue;
    const reference = rows[i - 1].close;
    if (!(reference > 0)) continue;
    // 无复权因子时按不复权入库的日K会把除权/份额折算画成巨型跳空（如 3:1 折算直接跌 67%），
    // 涨跌停限制下真实的缺口不会超过 20%，超出上限的一律当数据口径问题忽略。
    if (
      (down ? reference - rows[i].high : rows[i].low - reference) / reference >
      0.2
    )
      continue;
    found++;
    if (down) {
      let filled = false,
        highest = -Infinity;
      for (let j = i; j <= last; j++) {
        if (rows[j].high >= rows[i - 1].low) {
          filled = true;
          break;
        }
        highest = Math.max(highest, rows[j].high);
      }
      if (!filled && rows[i - 1].low > highest)
        result.push({
          start: i,
          end: last,
          top: rows[i - 1].low,
          bottom: highest,
          kind: "down",
        });
    } else {
      let filled = false,
        lowest = Infinity;
      for (let j = i; j <= last; j++) {
        if (rows[j].low <= rows[i - 1].high) {
          filled = true;
          break;
        }
        lowest = Math.min(lowest, rows[j].low);
      }
      if (!filled && lowest > rows[i - 1].high)
        result.push({
          start: i,
          end: last,
          top: lowest,
          bottom: rows[i - 1].high,
          kind: "up",
        });
    }
  }
  return result.reverse();
}

/**
 * 通达信 ZIG(3,N) 的转折点。ZIG 本身带确认滞后（要等反向 N% 才成立），
 * 所以这里只在反向幅度达标后登记枢轴，不引入未来数据以外的额外假设。
 */
export function zigzagPivots(
  values: number[],
  percent: number,
): { index: number; kind: "buy" | "sell" }[] {
  if (values.length < 3 || !(percent > 0)) return [];
  const threshold = percent / 100;
  const pivots: { index: number; kind: "buy" | "sell" }[] = [];
  let direction = values[1] >= values[0] ? 1 : -1;
  let extreme = values[0],
    extremeIndex = 0;
  for (let i = 1; i < values.length; i++) {
    const value = values[i];
    if (direction > 0) {
      if (value >= extreme) {
        extreme = value;
        extremeIndex = i;
        continue;
      }
      if (value <= extreme * (1 - threshold)) {
        pivots.push({ index: extremeIndex, kind: "sell" });
        direction = -1;
        extreme = value;
        extremeIndex = i;
      }
    } else {
      if (value <= extreme) {
        extreme = value;
        extremeIndex = i;
        continue;
      }
      if (value >= extreme * (1 + threshold)) {
        pivots.push({ index: extremeIndex, kind: "buy" });
        direction = 1;
        extreme = value;
        extremeIndex = i;
      }
    }
  }
  return pivots;
}

/** ★游资大单：X_2 创 5 日新高后的 4 根内出现放量长阳，FILTER 去重 5 根。 */
function hotMoneySignals(rows: OHLC[]): number[] {
  if (rows.length < 10) return [];
  const typical = rows.map(
    (row) => (3 * row.close + row.high + row.low + row.open) / 6,
  );
  const fast = ema(typical, 20);
  const highest = fast.map((_, i) =>
    Math.max(...fast.slice(Math.max(0, i - 4), i + 1)),
  );
  const lower = fast.map((value, i) => 2 * value - highest[i]);
  const reset = highest.map(
    (value, i) => i > 0 && value === lower[i] && highest[i - 1] > lower[i - 1],
  );
  const signals: number[] = [];
  for (let i = 9; i < rows.length; i++) {
    if (fast[i] !== highest[i]) continue;
    let recent = false;
    for (let j = i; j >= Math.max(0, i - 4); j--)
      if (reset[j]) {
        recent = true;
        break;
      }
    if (!recent) continue;
    const volume = rows[i].volume ?? 0,
      previousVolume = rows[i - 1].volume ?? 0;
    if (
      rows[i].close < rows[i].open ||
      !(volume >= previousVolume * 2) ||
      !(rows[i].close > rows[i - 1].close * 1.03)
    )
      continue;
    if (signals.length && i - signals[signals.length - 1] < 5) continue;
    signals.push(i);
  }
  return signals;
}

/** 合并三组标记：ZIG(3,10) 买卖点、ZIG(3,5) 转折箭头（近 2 根内不重复）、游资大单。 */
function formulaMarkers(rows: OHLC[]): FormulaMarker[] {
  const result = new Map<number, FormulaMarker>();
  for (const pivot of zigzagPivots(
    rows.map((row) => row.close),
    10,
  )) {
    result.set(pivot.index, {
      index: pivot.index,
      kind: pivot.kind,
      label: pivot.kind === "buy" ? "B" : "S",
    });
  }
  for (const pivot of zigzagPivots(
    rows.map((row) => row.close),
    5,
  )) {
    if ([...result.keys()].some((index) => Math.abs(index - pivot.index) <= 2))
      continue;
    result.set(pivot.index, {
      index: pivot.index,
      kind: pivot.kind,
      label: "",
    });
  }
  for (const index of hotMoneySignals(rows))
    result.set(index, { index, kind: "hot", label: "游资" });
  return [...result.values()].sort((a, b) => a.index - b.index);
}

export function computeMainFormula(rows: OHLC[]): MainFormula {
  if (!rows.length) return EMPTY_FORMULA;
  return {
    ...trendBands(rows),
    emaLevels: emaLadder(rows),
    chips: chipProfile(rows),
    gaps: unfilledGaps(rows),
    markers: formulaMarkers(rows),
  };
}
