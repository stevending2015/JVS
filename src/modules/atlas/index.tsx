/**
 * 词光 atlas 模块。
 *
 * 四个视图：
 *   今日   —— 今天要复习的词 + 新词，点「开始」进做题
 *   学习   —— 做题界面
 *   词表   —— 全库浏览、搜索、收藏
 *   统计   —— 累计学习量、掌握度、错词本
 *
 * 媒体只缓存当前这一组（20–30 词，约 2 MB），换组即换缓存 —— 见 core/word/media.ts。
 */

import * as React from 'react';
import { getSetting } from '../../core/setting/repository.js';
import { useStore } from '../../core/store.js';
import { ensureWordData } from '../../core/word/import.js';
import { buildReviewReminder } from '../../core/word/link.js';
import { wordMedia } from '../../core/word/media.js';
import {
  applyMediaSource,
  isValidMediaBase,
  probeMediaBase,
  setMediaBase,
} from '../../core/word/mediaConfig.js';
import { WordRepository } from '../../core/word/repository.js';
import {
  buildQuestions,
  estimateMinutes,
  type QuizQuestion,
  type WordGroup,
} from '../../core/word/session.js';
import { newWordCard, reviewWord, type Grade } from '../../core/word/srs.js';
import {
  DAILY_NEW_DEFAULT,
  hasMedia,
  isMastered,
  primaryZh,
  wordDayKey,
  type WordCard,
  type WordDay,
  type WordEntry,
  type WordSet,
} from '../../core/word/types.js';
import { Quiz } from './Quiz.js';

type View = 'today' | 'quiz' | 'list' | 'stats';

/** 每页取多少个做干扰项；太小会让选项重复。 */
const POOL_SIZE = 200;

export function AtlasCard(): React.ReactElement {
  const [due, setDue] = React.useState<number | null>(null);
  const [learned, setLearned] = React.useState(0);
  const [todayNew, setTodayNew] = React.useState(0);

  React.useEffect(() => {
    void (async () => {
      const [summary, day] = await Promise.all([
        WordRepository.summary(Date.now()),
        WordRepository.dayStat(wordDayKey()),
      ]);
      setDue(summary.due);
      setLearned(summary.learned);
      setTodayNew(day.new_count);
    })().catch(() => undefined);
  }, []);

  if (due === null) return <p className="card__empty">正在读取词库…</p>;
  if (learned === 0) return <p className="card__empty">还没有开始背单词</p>;
  return (
    <div>
      <div className="mini-big">{due}</div>
      <div className="mini-list__meta">
        待复习 · 今日新学 {todayNew} · 累计 {learned}
      </div>
    </div>
  );
}

export function AtlasPage(): React.ReactElement {
  const { refresh, addCountdown } = useStore();
  const [view, setView] = React.useState<View>('today');
  const [error, setError] = React.useState<string | null>(null);
  const [importing, setImporting] = React.useState(false);
  const [importRatio, setImportRatio] = React.useState(0);
  const [loaded, setLoaded] = React.useState<boolean | null>(null);

  const [summary, setSummary] = React.useState({ total: 0, learned: 0, mastered: 0, due: 0, bookmarked: 0 });
  const [day, setDay] = React.useState<WordDay | null>(null);
  const [group, setGroup] = React.useState<WordGroup | null>(null);
  const [questions, setQuestions] = React.useState<QuizQuestion[]>([]);
  const [questionIndex, setQuestionIndex] = React.useState(0);
  const [prefetch, setPrefetch] = React.useState<{ done: number; total: number } | null>(null);

  const [listQuery, setListQuery] = React.useState('');
  const [listItems, setListItems] = React.useState<WordEntry[]>([]);
  const [sets, setSets] = React.useState<WordSet[]>([]);
  const [mistakes, setMistakes] = React.useState<Array<{ entry: WordEntry; count: number }>>([]);
  const [recent, setRecent] = React.useState<WordDay[]>([]);
  const [setSizes, setSetSizes] = React.useState<Map<string, number>>(new Map());
  const [reminderBusy, setReminderBusy] = React.useState(false);
  const [reminderAdded, setReminderAdded] = React.useState(false);
  const [mediaBase, setMediaBaseInput] = React.useState('');
  const [mediaBusy, setMediaBusy] = React.useState(false);
  const [mediaHint, setMediaHint] = React.useState<string | null>(null);
  const [sessionStart, setSessionStart] = React.useState<number>(0);
  const [sessionDone, setSessionDone] = React.useState(0);
  const [sessionCorrect, setSessionCorrect] = React.useState(0);

  /** 刷新所有统计。 */
  const reload = React.useCallback(async () => {
    const now = Date.now();
    const [stats, today, setList, wrongList, days] = await Promise.all([
      WordRepository.summary(now),
      WordRepository.dayStat(wordDayKey()),
      WordRepository.listSets(),
      WordRepository.mistakes(30),
      WordRepository.recentDays(14),
    ]);
    setSummary(stats);
    setDay(today);
    setSets(setList);
    setMistakes(wrongList);
    setRecent(days);
    // 每个词集有多少词，显示在词集列表里。
    const sizes = new Map<string, number>();
    await Promise.all(
      setList.map(async (set) => {
        sizes.set(set.id, await WordRepository.setSize(set.id));
      }),
    );
    setSetSizes(sizes);
  }, []);

  /**
   * 从文本里挑生词组成词集时用不到，保留给「按标签建集」。
   */

  /** 测试当前输入的地址能不能取到媒体。 */
  async function testMedia(): Promise<void> {
    setMediaBusy(true);
    setMediaHint(null);
    try {
      if (!isValidMediaBase(mediaBase)) {
        setMediaHint('地址要以 http:// 或 https:// 开头');
        return;
      }
      const found = await probeMediaBase(mediaBase);
      setMediaHint(
        found === null
          ? '取不到媒体：检查地址、路径，以及服务器是否允许跨域（CORS）'
          : `连接成功：${found}`,
      );
    } finally {
      setMediaBusy(false);
    }
  }

  /** 保存媒体地址并立即切换。 */
  async function saveMedia(): Promise<void> {
    setMediaBusy(true);
    setMediaHint(null);
    try {
      if (!isValidMediaBase(mediaBase)) {
        setMediaHint('地址要以 http:// 或 https:// 开头');
        return;
      }
      const source = await setMediaBase(mediaBase);
      wordMedia.clear();
      setMediaHint(`已切换到「${source.name}」。下一组词会从新地址拉取。`);
    } catch (e) {
      setMediaHint((e as Error).message);
    } finally {
      setMediaBusy(false);
    }
  }

  /**
   * 把「今天待复习 N 个」加成一条倒计时。
   *
   * 提醒时间定在今晚 21:00（已过则明天），和倒计时模块的日期粒度一致。
   */
  async function addReviewReminder(): Promise<void> {
    setReminderBusy(true);
    setError(null);
    try {
      const reminder = await buildReviewReminder();
      if (reminder === null) {
        setError('今天没有待复习的词');
        return;
      }
      const target = new Date();
      target.setHours(21, 0, 0, 0);
      if (target.getTime() <= Date.now()) target.setDate(target.getDate() + 1);
      const date = `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, '0')}-${String(target.getDate()).padStart(2, '0')}`;
      await addCountdown(reminder.title, date);
      setReminderAdded(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setReminderBusy(false);
    }
  }

  // 打开模块：先确认词库已导入，再拉统计。
  // 媒体源也在这里初始化 —— 放在模块顶层会让每次打开 JVS 任何页面都去探测远端。
  React.useEffect(() => {
    void (async () => {
      try {
        // 读出已保存的媒体地址，填进设置输入框。
        const savedBase = await getSetting('word.mediaBase').catch(() => null);
        if (savedBase !== null) setMediaBaseInput(savedBase);
        void applyMediaSource().catch(() => undefined);
        const isLoaded = await WordRepository.isLoaded();
        setLoaded(isLoaded);
        if (!isLoaded) return;
        await reload();
      } catch (e) {
        setError((e as Error).message);
      }
    })();
  }, [reload]);

  /** 导入词库（只做一次）。 */
  async function runImport(): Promise<void> {
    setImporting(true);
    setError(null);
    try {
      await ensureWordData((progress) => setImportRatio(progress.ratio));
      setLoaded(true);
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setImporting(false);
    }
  }

  /**
   * 组出今天的一组词并预取媒体。
   *
   * 这一步是「只缓存当前组」的关键：先把这一组的插画和发音拉下来，
   * 做题时就完全离线可用。
   */
  async function startSession(): Promise<void> {
    setError(null);
    try {
      const now = Date.now();
      const due = await WordRepository.dueCards(now, 40);
      const fresh = await WordRepository.nextNewEntries(DAILY_NEW_DEFAULT);
      if (due.length === 0 && fresh.length === 0) {
        setError('今天没有要学的词了 —— 已完成全部新词，等复习到期再来。');
        return;
      }
      const entries = [...due.map((item) => item.entry), ...fresh];
      const nextGroup: WordGroup = {
        due,
        fresh,
        entries,
        minutes: estimateMinutes(due.length, fresh.length),
      };

      // 干扰项从更大的一批词里取，选项才不会总是同样的几个词。
      const pool = await WordRepository.nextNewEntries(POOL_SIZE);
      const poolEntries = pool.length >= POOL_SIZE ? pool : [...pool, ...entries];

      const cards = new Map<string, WordCard>();
      for (const item of due) cards.set(item.card.word_id, item.card);

      // 预取：先让用户看到进度，再进做题。
      // 先确保媒体源已就绪（页面 effect 里可能还没跑完）。
      await applyMediaSource().catch(() => undefined);
      setPrefetch({ done: 0, total: entries.length });
      await wordMedia.prefetch(entries, (done, total) => setPrefetch({ done, total }));
      setPrefetch(null);

      setGroup(nextGroup);
      setQuestions(buildQuestions(nextGroup, poolEntries, cards));
      setQuestionIndex(0);
      setSessionStart(Date.now());
      setSessionDone(0);
      setSessionCorrect(0);
      setView('quiz');
    } catch (e) {
      setPrefetch(null);
      setError((e as Error).message);
    }
  }

  /** 记一次评分并推进卡片。 */
  async function handleGrade(grade: Grade): Promise<void> {
    const question = questions[questionIndex];
    if (question === undefined || group === null) return;
    const now = Date.now();
    const entry = question.entry;
    const existing = await WordRepository.cardById(entry.id);
    const prev = existing ?? undefined;
    const next = reviewWord(prev, grade, now);

    await WordRepository.upsertCard({
      word_id: entry.id,
      ...next,
      bookmarked: prev?.bookmarked ?? 0,
      updated_at: new Date().toISOString(),
    });

    const isNew = prev === undefined;
    const correct = grade !== 1;
    await WordRepository.bumpDay({
      new_count: isNew ? 1 : 0,
      review_count: 1,
      correct_count: correct ? 1 : 0,
    });
    if (!correct) await WordRepository.recordMistake(entry.id, now);

    setSessionDone((value) => value + 1);
    if (correct) setSessionCorrect((value) => value + 1);
  }

  /** 下一题；最后一题则结束会话。 */
  function handleNext(): void {
    if (questionIndex + 1 < questions.length) {
      setQuestionIndex((value) => value + 1);
      return;
    }
    void (async () => {
      // 会话结束：把用时记进统计，清掉媒体缓存（下一组会重新预取）。
      const seconds = Math.round((Date.now() - sessionStart) / 1000);
      if (seconds > 0) await WordRepository.bumpDay({ active_seconds: seconds });
      wordMedia.clear();
      setView('today');
      setGroup(null);
      setQuestions([]);
      await reload();
      await refresh();
    })();
  }

  /** 搜索词表。 */
  React.useEffect(() => {
    if (view !== 'list') return;
    let alive = true;
    void (async () => {
      const rows = await searchWords(listQuery);
      if (alive) setListItems(rows);
    })();
    return () => {
      alive = false;
    };
  }, [view, listQuery]);

  if (loaded === null) {
    return <div className="panel"><p className="card__empty">正在读取词库…</p></div>;
  }

  if (!loaded) {
    return (
      <div className="panel wa-page">
        <div className="list-head"><h3>词光 atlas</h3></div>
        <div className="wa-intro">
          <p className="wa-intro__lead">
            7,298 个雅思核心词，每个词一幅插画、英美发音、原创例句，配 FSRS 复习节奏。
          </p>
          <p className="wa-intro__note">
            词条和例句来自开源项目 <b>word-atlas</b>（CC BY 4.0）。插画和音频不会进数据库，
            只在你学习时按需加载当前这一组（约 2 MB）。
          </p>
          {importing ? (
            <div className="wa-import">
              <div className="wa-import__bar"><i style={{ width: `${Math.round(importRatio * 100)}%` }} /></div>
              <span>正在导入词库… {Math.round(importRatio * 100)}%</span>
            </div>
          ) : (
            <button type="button" className="primary" onClick={() => void runImport()}>
              导入词库（7,298 词，约 7 MB）
            </button>
          )}
          {error !== null && <div className="banner banner--bad">{error}</div>}
        </div>
      </div>
    );
  }

  const todayNewTarget = DAILY_NEW_DEFAULT;

  return (
    <div className="panel wa-page">
      <div className="list-head">
        <h3>词光 atlas</h3>
        <span className="list-head__count">
          已学 {summary.learned} / {summary.total} · 掌握 {summary.mastered}
        </span>
        <div className="wa-tabs">
          {(['today', 'list', 'stats'] as const).map((item) => (
            <button
              key={item}
              type="button"
              className={view === item ? 'is-active' : ''}
              onClick={() => setView(item)}
            >
              {item === 'today' ? '今日' : item === 'list' ? '词表' : '统计'}
            </button>
          ))}
        </div>
      </div>

      {error !== null && <div className="banner banner--bad">{error}</div>}

      {view === 'today' && (
        <section className="wa-today">
          <div className="wa-stats">
            <div><b>{summary.due}</b><span>待复习</span></div>
            <div><b>{day?.new_count ?? 0}</b><span>今日新学</span></div>
            <div><b>{day?.review_count ?? 0}</b><span>今日复习</span></div>
            <div><b>{summary.mastered}</b><span>已掌握</span></div>
          </div>
          <p className="wa-today__plan">
            今天计划：新词 {Math.min(todayNewTarget, Math.max(0, summary.total - summary.learned))} 个
            {summary.due > 0 && ` · 复习 ${summary.due} 个`}
          </p>
          {prefetch !== null ? (
            <div className="wa-import">
              <div className="wa-import__bar">
                <i style={{ width: `${prefetch.total === 0 ? 0 : Math.round((prefetch.done / prefetch.total) * 100)}%` }} />
              </div>
              <span>正在准备这一组的插画与发音… {prefetch.done}/{prefetch.total}</span>
            </div>
          ) : (
            <button type="button" className="primary wa-start" onClick={() => void startSession()}>
              开始学习
            </button>
          )}
          <p className="wa-today__hint">
            只缓存当前这一组（20–30 词）的插画和音频，约 2 MB；换组会自动清掉旧的。
          </p>
        </section>
      )}

      {view === 'quiz' && questions[questionIndex] !== undefined && (
        <Quiz
          question={questions[questionIndex] as QuizQuestion}
          index={questionIndex}
          total={questions.length}
          onGrade={handleGrade}
          onNext={handleNext}
        />
      )}

      {view === 'list' && (
        <section className="wa-list">
          <input
            className="wa-search"
            placeholder="搜索单词或中文释义…"
            value={listQuery}
            onChange={(e) => setListQuery(e.target.value)}
            aria-label="搜索单词"
          />
          {sets.length > 0 && (
            <div className="wa-sets">
              {sets.map((set) => (
                <span key={set.id} className="wa-chip">
                  {set.name}
                </span>
              ))}
            </div>
          )}
          <ul className="wa-words">
            {listItems.map((entry) => (
              <li key={entry.id}>
                <div className="wa-words__main">
                  <span className="wa-words__word">{entry.word}</span>
                  <span className="wa-words__ipa">{entry.ipa_uk}</span>
                  <span className="wa-tag wa-tag--cefr">{entry.cefr}</span>
                  {hasMedia(entry, 'img') && <span className="wa-tag">🖼</span>}
                </div>
                <span className="wa-words__zh">{primaryZh(entry)}</span>
              </li>
            ))}
          </ul>
          {listItems.length === 0 && <p className="card__empty">没有匹配的词</p>}
        </section>
      )}

      {view === 'stats' && (
        <section className="wa-stats-view">
          <div className="wa-stats">
            <div><b>{summary.learned}</b><span>已学词数</span></div>
            <div><b>{summary.mastered}</b><span>已掌握</span></div>
            <div><b>{summary.bookmarked}</b><span>收藏</span></div>
            <div><b>{summary.due}</b><span>待复习</span></div>
          </div>
          <h4 className="wa-section-title">最近 14 天</h4>
          <div className="wa-heat">
            {recent.map((item) => {
              const total = item.new_count + item.review_count;
              const level = total === 0 ? 0 : total < 10 ? 1 : total < 25 ? 2 : 3;
              return (
                <span
                  key={item.day}
                  className={`wa-heat__cell wa-heat__cell--${level}`}
                  title={`${item.day} · 新 ${item.new_count} · 复习 ${item.review_count}`}
                />
              );
            })}
            {recent.length === 0 && <p className="card__empty">还没有记录</p>}
          </div>
          <h4 className="wa-section-title">错词本</h4>
          {mistakes.length === 0 ? (
            <p className="card__empty">还没有错词</p>
          ) : (
            <ul className="wa-mistakes">
              {mistakes.map((item) => (
                <li key={item.entry.id}>
                  <span className="wa-words__word">{item.entry.word}</span>
                  <span className="wa-words__zh">{primaryZh(item.entry)}</span>
                  <span className="wa-mistake-count">错 {item.count} 次</span>
                </li>
              ))}
            </ul>
          )}

          <h4 className="wa-section-title">词集</h4>
          {sets.length === 0 ? (
            <p className="card__empty">
              还没有词集。在<b>笔记</b>里点「提取生词」，或给<b>读书目标</b>的书写笔记，就会自动建集。
            </p>
          ) : (
            <ul className="wa-mistakes">
              {sets.map((set) => (
                <li key={set.id}>
                  <span className="wa-words__word">{set.name}</span>
                  <span className="wa-tag">
                    {set.kind === 'note' ? '笔记' : set.kind === 'goal' ? '读书' : '自建'}
                  </span>
                  <span className="wa-mistake-count">{setSizes.get(set.id) ?? 0} 词</span>
                </li>
              ))}
            </ul>
          )}

          <h4 className="wa-section-title">复习提醒</h4>
          <p className="wa-today__hint">
            把复习计划加进倒计时，到点提醒你回来背。
          </p>
          <div className="form__actions">
            <button
              type="button"
              className="primary"
              disabled={summary.learned === 0 || reminderBusy}
              onClick={() => void addReviewReminder()}
            >
              {reminderBusy
                ? '添加中…'
                : summary.learned === 0
                  ? '先学几个词再来'
                  : `添加提醒（${summary.due > 0 ? `${summary.due} 个待复习` : `已学 ${summary.learned} 词`}）`}
            </button>
            {reminderAdded && <span className="wa-tag">已加入倒计时</span>}
          </div>

          <h4 className="wa-section-title">媒体源</h4>
          <p className="wa-today__hint">
            插画和音频从哪取。留空 = 自动（先试远端，连不上用本地）；填 local 强制本地。
            当前：<b>{wordMedia.sourceName}</b> · 已缓存 {wordMedia.size} 个媒体文件。
          </p>
          <div className="wa-mediabase">
            <input
              className="wa-search"
              placeholder="留空自动 / https://media.example.com / local"
              value={mediaBase}
              onChange={(e) => setMediaBaseInput(e.target.value)}
              aria-label="媒体基地址"
            />
            <button type="button" className="btn" disabled={mediaBusy} onClick={() => void testMedia()}>
              {mediaBusy ? '检测中…' : '测试连接'}
            </button>
            <button type="button" className="primary" disabled={mediaBusy} onClick={() => void saveMedia()}>
              保存
            </button>
          </div>
          {mediaHint !== null && <p className="wa-today__hint">{mediaHint}</p>}
        </section>
      )}
    </div>
  );
}

/**
 * 搜索词表。
 *
 * @param query - 关键词（单词或中文）。
 * @returns 最多 200 条。
 */
async function searchWords(query: string): Promise<WordEntry[]> {
  const trimmed = query.trim();
  if (trimmed === '') {
    return WordRepository.nextNewEntries(60);
  }
  return WordRepository.searchEntries(trimmed, 200);
}

/** 判断一个词是否已掌握（供词表标记用）。 */
export { isMastered };
