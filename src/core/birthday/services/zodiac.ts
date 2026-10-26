/**
 * Western zodiac — derived from the Gregorian local date of the birthday.
 */

export interface ZodiacResult {
  sign: string;
  element: string;
  quality: string;
}

const SIGNS: Array<{
  sign: string;
  element: string;
  quality: string;
  fromMonth: number;
  fromDay: number;
  toMonth: number;
  toDay: number;
}> = [
  { sign: '摩羯座', element: '土', quality: '本位', fromMonth: 12, fromDay: 22, toMonth: 1, toDay: 19 },
  { sign: '水瓶座', element: '风', quality: '固定', fromMonth: 1, fromDay: 20, toMonth: 2, toDay: 18 },
  { sign: '双鱼座', element: '水', quality: '变动', fromMonth: 2, fromDay: 19, toMonth: 3, toDay: 20 },
  { sign: '白羊座', element: '火', quality: '本位', fromMonth: 3, fromDay: 21, toMonth: 4, toDay: 19 },
  { sign: '金牛座', element: '土', quality: '固定', fromMonth: 4, fromDay: 20, toMonth: 5, toDay: 20 },
  { sign: '双子座', element: '风', quality: '变动', fromMonth: 5, fromDay: 21, toMonth: 6, toDay: 21 },
  { sign: '巨蟹座', element: '水', quality: '本位', fromMonth: 6, fromDay: 22, toMonth: 7, toDay: 22 },
  { sign: '狮子座', element: '火', quality: '固定', fromMonth: 7, fromDay: 23, toMonth: 8, toDay: 22 },
  { sign: '处女座', element: '土', quality: '变动', fromMonth: 8, fromDay: 23, toMonth: 9, toDay: 22 },
  { sign: '天秤座', element: '风', quality: '本位', fromMonth: 9, fromDay: 23, toMonth: 10, toDay: 23 },
  { sign: '天蝎座', element: '水', quality: '固定', fromMonth: 10, fromDay: 24, toMonth: 11, toDay: 22 },
  { sign: '射手座', element: '火', quality: '变动', fromMonth: 11, fromDay: 23, toMonth: 12, toDay: 21 },
];

export function computeZodiac(month: number, day: number): ZodiacResult {
  for (const s of SIGNS) {
    if (s.fromMonth === s.toMonth) {
      if (month === s.fromMonth && day >= s.fromDay && day <= s.toDay) return s;
    } else {
      // wraps year boundary (only Capricorn)
      if ((month === s.fromMonth && day >= s.fromDay) ||
          (month === s.toMonth && day <= s.toDay)) {
        return s;
      }
    }
  }
  return { sign: '未知', element: '未知', quality: '未知' };
}

export function formatZodiac(z: ZodiacResult): string {
  return `${z.sign} · ${z.element}象`;
}
