/** Module registration: the dashboard renders one card per entry here. */

import * as React from 'react';
import { registerModule } from '../core/module/registry.js';
import { AlmanacCard, AlmanacPage } from './almanac/index.js';
import { AtlasCard, AtlasPage } from './atlas/index.js';
import { BirthdayCard, BirthdayPage } from './birthday/index.js';
import { CountdownCard, CountdownPage } from './countdown/index.js';
import { FamilyCard, FamilyPage } from './family/index.js';
import { FocusCard, FocusPage } from './focus/index.js';
import { GoalCard, GoalPage } from './goal/index.js';
import { NotesCard, NotesPage } from './notes/index.js';
import { WeatherCard, WeatherPage } from './weather/index.js';

export function registerAllModules(): void {
  registerModule({ id: 'birthday', title: '生日卡', icon: '🎂', blurb: '亲友生日与倒计时提醒', order: 10, status: 'ready', dashboard: <BirthdayCard />, page: <BirthdayPage /> });
  registerModule({ id: 'almanac', title: '万年历', icon: '📅', blurb: '农历 · 节气 · 干支 · 宜忌', order: 20, status: 'ready', dashboard: <AlmanacCard />, page: <AlmanacPage /> });
  registerModule({ id: 'countdown', title: '倒计时', icon: '⏳', blurb: '考试、纪念日、截止日期', order: 30, status: 'ready', dashboard: <CountdownCard />, page: <CountdownPage /> });
  registerModule({ id: 'notes', title: '笔记', icon: '📝', blurb: '本地 Markdown 笔记', order: 40, status: 'ready', dashboard: <NotesCard />, page: <NotesPage /> });
  registerModule({ id: 'family', title: '家族树', icon: '🌳', blurb: '世系图 · 世代列表 · GEDCOM', order: 15, status: 'ready', dashboard: <FamilyCard />, page: <FamilyPage /> });
  registerModule({ id: 'weather', title: '天气', icon: '🌤', blurb: 'Open-Meteo 实时与 7 天预报', order: 5, status: 'ready', dashboard: <WeatherCard />, page: <WeatherPage /> });
  registerModule({ id: 'focus', title: '专注', icon: '⏱', blurb: '番茄钟 · 正计时 · 专注统计', order: 35, status: 'ready', dashboard: <FocusCard />, page: <FocusPage /> });
  registerModule({ id: 'goal', title: '目标', icon: '🎯', blurb: '目标倒计时 · 打卡 · 读书笔记', order: 32, status: 'ready', dashboard: <GoalCard />, page: <GoalPage /> });
  registerModule({ id: 'atlas', title: '词光 atlas', icon: '📖', blurb: '雅思词库 · 插画发音 · FSRS 复习', order: 25, status: 'ready', dashboard: <AtlasCard />, page: <AtlasPage /> });
}
