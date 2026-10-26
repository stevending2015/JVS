/**
 * 做题界面。
 *
 * 四种题型共用一套外壳：题干在上、选项在下、答完立刻给反馈并显示完整词条。
 * 媒体（插画 / 音频）从当前组的缓存里取 —— 进组时已经预取过，这里不会卡。
 */

import * as React from 'react';
import { checkSpelling, type QuizQuestion } from '../../core/word/session.js';
import { formatInterval } from '../../core/word/srs.js';
import type { Grade } from '../../core/word/srs.js';
import { Rating } from '../../core/word/srs.js';
import { wordMedia } from '../../core/word/media.js';
import type { WordEntry } from '../../core/word/types.js';

/** 评分按钮的中文标签。 */
const GRADE_LABEL: Record<number, string> = {
  [Rating.Again]: '忘了',
  [Rating.Hard]: '勉强',
  [Rating.Good]: '记得',
  [Rating.Easy]: '很熟',
};

/** 取一个词的媒体 URL。 */
function useMediaUrl(wordId: string, kind: 'img' | 'uk' | 'us' | 'ex'): string | null {
  const [url, setUrl] = React.useState<string | null>(null);
  React.useEffect(() => {
    let alive = true;
    void wordMedia.get(wordId, kind).then((value) => {
      if (alive) setUrl(value);
    });
    return () => {
      alive = false;
    };
  }, [wordId, kind]);
  return url;
}

/** 插画。 */
function Picture({ entry, size }: { entry: WordEntry; size: 'card' | 'thumb' }): React.ReactElement {
  const url = useMediaUrl(entry.id, 'img');
  if (url === null) {
    return <div className={`wa-picture wa-picture--${size} wa-picture--empty`} aria-hidden="true">🖼</div>;
  }
  return <img className={`wa-picture wa-picture--${size}`} src={url} alt={entry.word} />;
}

/** 发音按钮。 */
function SpeakButton({ entry, accent }: { entry: WordEntry; accent: 'uk' | 'us' }): React.ReactElement | null {
  const url = useMediaUrl(entry.id, accent);
  if (url === null) return null;
  return (
    <button
      type="button"
      className="wa-speak"
      onClick={() => {
        const audio = new Audio(url);
        void audio.play().catch(() => undefined);
      }}
      aria-label={accent === 'uk' ? '播放英音' : '播放美音'}
    >
      {accent === 'uk' ? '🇬🇧' : '🇺🇸'}
    </button>
  );
}

/** 答完之后的词条详情。 */
function Reveal({ entry }: { entry: WordEntry }): React.ReactElement {
  const exampleUrl = useMediaUrl(entry.id, 'ex');
  return (
    <div className="wa-reveal">
      <div className="wa-reveal__head">
        <span className="wa-reveal__word">{entry.word}</span>
        <span className="wa-reveal__ipa">{entry.ipa_uk}</span>
        <SpeakButton entry={entry} accent="uk" />
        <SpeakButton entry={entry} accent="us" />
        <span className="wa-tag wa-tag--cefr">{entry.cefr}</span>
      </div>
      {entry.senses.map((sense, index) => (
        <p key={index} className="wa-reveal__sense">
          <span className="wa-pos">{sense.pos}</span> {sense.zh}
          <span className="wa-reveal__en"> {sense.en}</span>
        </p>
      ))}
      {entry.examples[0] !== undefined && (
        <p className="wa-reveal__ex">
          {exampleUrl !== null && (
            <button
              type="button"
              className="wa-speak wa-speak--inline"
              onClick={() => {
                const audio = new Audio(exampleUrl);
                void audio.play().catch(() => undefined);
              }}
              aria-label="播放例句"
            >
              🔊
            </button>
          )}
          {entry.examples[0].en}
          <span className="wa-reveal__exzh">{entry.examples[0].zh}</span>
        </p>
      )}
      {entry.tip !== '' && <p className="wa-reveal__tip">💡 {entry.tip}</p>}
    </div>
  );
}

export interface QuizProps {
  question: QuizQuestion;
  /** 第几题 / 共几题。 */
  index: number;
  total: number;
  /** 每题答完给分。 */
  onGrade: (grade: Grade) => Promise<void> | void;
  /** 到下一题；已经最后一题时由上层结束会话。 */
  onNext: () => void;
}

export function Quiz({ question, index, total, onGrade, onNext }: QuizProps): React.ReactElement {
  const [chosen, setChosen] = React.useState<number | null>(null);
  const [typed, setTyped] = React.useState('');
  const [answered, setAnswered] = React.useState(false);
  const [correct, setCorrect] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  // 换题就重置本地状态。
  React.useEffect(() => {
    setChosen(null);
    setTyped('');
    setAnswered(false);
    setCorrect(false);
    if (question.kind === 'spell') inputRef.current?.focus();
  }, [question]);

  const entry = question.entry;

  function answer(optionIndex: number): void {
    if (answered) return;
    setChosen(optionIndex);
    setAnswered(true);
    setCorrect(optionIndex === question.answer);
  }

  function submitSpelling(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (answered) return;
    const ok = checkSpelling(typed, entry);
    setAnswered(true);
    setCorrect(ok);
  }

  /** 答对给 Good，答错给 Again —— 选项题只有对错，所以不给 Hard/Easy。 */
  async function grade(score: Grade): Promise<void> {
    await onGrade(score);
    onNext();
  }

  const progress = total === 0 ? 0 : Math.round((index / total) * 100);

  return (
    <div className="wa-quiz">
      <div className="wa-quiz__bar">
        <span>{index + 1} / {total}</span>
        <div className="wa-quiz__progress"><i style={{ width: `${progress}%` }} /></div>
        <span className="wa-tag wa-tag--cefr">{entry.cefr}</span>
      </div>

      <div className="wa-quiz__prompt">
        {question.kind === 'meaning' && (
          <>
            <span className="wa-quiz__label">这个词是什么意思？</span>
            <span className="wa-quiz__word">{entry.word}</span>
            <span className="wa-quiz__ipa">{entry.ipa_uk}</span>
          </>
        )}
        {question.kind === 'picture' && (
          <>
            <span className="wa-quiz__label">看图选词</span>
            <Picture entry={entry} size="card" />
          </>
        )}
        {question.kind === 'listen' && (
          <>
            <span className="wa-quiz__label">听发音选词</span>
            <div className="wa-quiz__listen">
              <SpeakButton entry={entry} accent="uk" />
              <SpeakButton entry={entry} accent="us" />
            </div>
          </>
        )}
        {question.kind === 'spell' && (
          <>
            <span className="wa-quiz__label">根据中文写出英文</span>
            <span className="wa-quiz__zh">{entry.senses[0]?.zh ?? ''}</span>
            <span className="wa-quiz__ipa">{entry.ipa_uk}</span>
          </>
        )}
      </div>

      {question.kind === 'spell' ? (
        <form className="wa-spell" onSubmit={submitSpelling}>
          <input
            ref={inputRef}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            disabled={answered}
            placeholder="拼出这个单词"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            aria-label="拼写"
          />
          {!answered && <button type="submit" className="primary" disabled={typed.trim() === ''}>确认</button>}
        </form>
      ) : (
        <div className="wa-options">
          {question.options.map((option, optionIndex) => {
            const state = !answered
              ? ''
              : optionIndex === question.answer
                ? 'is-correct'
                : optionIndex === chosen
                  ? 'is-wrong'
                  : 'is-dim';
            return (
              <button
                key={option}
                type="button"
                className={`wa-option ${state}`}
                disabled={answered}
                onClick={() => answer(optionIndex)}
              >
                {option}
              </button>
            );
          })}
        </div>
      )}

      {answered && (
        <>
          <div className={`wa-verdict ${correct ? 'is-ok' : 'is-bad'}`}>
            {correct ? '✓ 答对了' : `✗ 答错了，正确答案是「${entry.senses[0]?.zh ?? entry.word}」`}
          </div>
          <Reveal entry={entry} />
          <div className="wa-grades">
            <span className="wa-grades__hint">这次记得怎么样？</span>
            {(Object.keys(GRADE_LABEL).map(Number) as Grade[]).map((score) => (
              <button
                key={score}
                type="button"
                className={`wa-grade wa-grade--${score === Rating.Again ? 'again' : score === Rating.Hard ? 'hard' : score === Rating.Good ? 'good' : 'easy'}`}
                onClick={() => void grade(score)}
              >
                {GRADE_LABEL[score]}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export { formatInterval };
