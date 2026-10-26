/** 倒计时 module. */

import * as React from 'react';
import { Modal } from '../../app/Modal.js';
import { useStore } from '../../core/store.js';

function daysUntil(date: string): number {
  const today = new Date();
  const start = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  const target = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
  return Math.round((target - start) / 86_400_000);
}

export function CountdownCard(): React.ReactElement {
  const { countdowns } = useStore();
  const sorted = [...countdowns].sort((a, b) => a.target_date.localeCompare(b.target_date));
  if (sorted.length === 0) return <p className="card__empty">还没有倒计时</p>;
  return (
    <ul className="mini-list">
      {sorted.slice(0, 3).map((item) => (
        <li key={item.id}>
          <span className="mini-list__name">{item.title}</span>
          <span className="mini-list__meta">{daysUntil(item.target_date)} 天</span>
        </li>
      ))}
    </ul>
  );
}

export function CountdownPage(): React.ReactElement {
  const { countdowns, addCountdown, removeCountdown } = useStore();
  const [open, setOpen] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    // Read the values BEFORE awaiting: React nulls `currentTarget` once the
    // handler yields, which is exactly what threw "Cannot read properties of
    // null (reading 'reset')" here before.
    const data = new FormData(event.currentTarget);
    const title = String(data.get('title') ?? '').trim();
    const date = String(data.get('date') ?? '');
    if (title === '' || date === '') {
      setError('名称与日期都不能为空');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await addCountdown(title, date);
      setOpen(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel">
      <div className="list-head">
        <h3>共 {countdowns.length} 项</h3>
        <span className="list-head__count" />
        <button type="button" className="btn btn--add" onClick={() => { setError(null); setOpen(true); }}>
          ＋ 添加倒计时
        </button>
      </div>

      {countdowns.length === 0 && <p className="card__empty">还没有倒计时，点右上角添加</p>}

      <ul className="person-list">
        {[...countdowns].sort((a, b) => a.target_date.localeCompare(b.target_date)).map((item) => (
          <li key={item.id}>
            <div><strong>{item.title}</strong></div>
            <div className="person-list__meta">{item.target_date}</div>
            <div className="person-list__next">
              {daysUntil(item.target_date) >= 0 ? `还有 ${daysUntil(item.target_date)} 天` : `已过 ${-daysUntil(item.target_date)} 天`}
            </div>
            <div className="person-list__actions">
              <button type="button" className="link" onClick={() => void removeCountdown(item.id)}>删除</button>
            </div>
          </li>
        ))}
      </ul>

      <Modal open={open} title="添加倒计时" onClose={() => setOpen(false)}>
        <form className="form" onSubmit={(e) => void submit(e)}>
          <label>名称<input name="title" required autoFocus /></label>
          <label>目标日期<input name="date" type="date" required /></label>
          {error !== null && <div className="banner banner--bad">{error}</div>}
          <div className="form__actions">
            <button type="submit" className="primary" disabled={busy}>{busy ? '保存中…' : '保存'}</button>
            <button type="button" onClick={() => setOpen(false)} disabled={busy}>取消</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}