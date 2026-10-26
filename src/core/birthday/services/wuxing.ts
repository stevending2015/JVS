/**
 * Wuxing (五行) + Shichen (时辰) summary, derived from the Gregorian local
 * date. The actual algorithm uses the lunar year/month for traditional 五行,
 * but here we keep the implementation dependency-free by mapping Gregorian
 * month to a 木/火/土/金/水 cycle that the UI can show as a histogram.
 */

export interface WuxingSummary {
  year: number;
  monthGanZhi?: string;
  wuxing: { wood: number; fire: number; earth: number; metal: number; water: number };
  dominant: 'wood' | 'fire' | 'earth' | 'metal' | 'water';
  bars: string; // pre-rendered bar chart for UI
}

const WUXING_OF_MONTH: Record<number, 'wood' | 'fire' | 'earth' | 'metal' | 'water'> = {
  3: 'wood', 4: 'wood',
  5: 'fire', 6: 'fire',
  9: 'metal', 10: 'metal',
  12: 'water', 1: 'water',
  7: 'earth', 8: 'earth',
  11: 'earth',
  2: 'wood',
};

export function computeWuxing(month: number): WuxingSummary {
  const tally: WuxingSummary['wuxing'] = { wood: 0, fire: 0, earth: 0, metal: 0, water: 0 };
  tally[WUXING_OF_MONTH[month] ?? 'earth'] += 3;
  tally.fire += 1;
  tally.water += 1;
  const dominant = (Object.entries(tally) as Array<[keyof typeof tally, number]>)
    .sort((a, b) => b[1] - a[1])[0][0] as WuxingSummary['dominant'];
  const max = Math.max(...Object.values(tally));
  const labels: Record<keyof typeof tally, string> = {
    wood: '木', fire: '火', earth: '土', metal: '金', water: '水',
  };
  const bars = (Object.keys(tally) as Array<keyof typeof tally>)
    .map((k) => `${labels[k]} ${'█'.repeat(Math.max(1, Math.round((tally[k] / max) * 4)))}`)
    .join(' ');
  return { year: new Date().getFullYear(), wuxing: tally, dominant, bars };
}

/**
 * Shichen (时辰) for a given local time. Each shichen spans 2 hours; index
 * 0 = 子时 (23:00–01:00).
 */
export function shichenFromHour(hour: number): { index: number; name: string } {
  const idx = Math.floor((hour + 1) / 2) % 12;
  const names = ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥'];
  return { index: idx, name: names[idx] };
}
