/**
 * 应用锁的两种界面。
 *
 * 交互模型（用户指定）：
 *  - 右上角有个锁形按钮，只有「设了口令 + 至少勾选了一个受保护模块」时才出现
 *  - 按下它 → 所有受保护模块上覆盖一把锁
 *  - 再按一次 → 弹出口令框，输对就解锁
 *  - 已解锁状态下再按 → 直接锁上（不需要口令）
 *
 * 所以模块页里只显示「被锁住」这个状态，不在这里输密码 —— 解锁入口统一在右上角。
 */

import * as React from 'react';
import { Modal } from './Modal.js';
import { verifyPassword, type SecurityConfig } from '../core/security/password.js';

/**
 * 盖在受保护模块上的锁。
 *
 * 主路径是仪表盘卡片上的锁；这个页面层的覆盖是给「直接打开深链」兜底的，
 * 所以它带一个按钮，点了就弹口令框。
 *
 * @param props.scopeLabel - 模块名，用于文案。
 * @param props.onUnlock - 点击解锁按钮。
 */
export function LockOverlay({
  scopeLabel,
  onUnlock,
}: {
  scopeLabel: string;
  onUnlock?: () => void;
}): React.ReactElement {
  return (
    <div className="lockoverlay" role="region" aria-label={`${scopeLabel} 已锁定`}>
      <div className="lockoverlay__card">
        <span className="lockoverlay__icon" aria-hidden="true">🔒</span>
        <h3 className="lockoverlay__title">{scopeLabel} 已锁定</h3>
        <p className="lockoverlay__hint">
          点右上角的锁形按钮，或下面的按钮，输入口令即可查看。
        </p>
        {onUnlock !== undefined && (
          <button type="button" className="btn btn--primary lockoverlay__btn" onClick={onUnlock}>
            输入口令解锁
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * 输入口令解锁的对话框。
 *
 * 两处都用它：解锁模块、以及打开设置。两者的口令是同一个，只是文案不同。
 *
 * @param props.config - 当前口令配置。
 * @param props.open - 是否显示。
 * @param props.onClose - 关闭。
 * @param props.onUnlock - 校验通过。
 * @param props.title - 对话框标题。
 * @param props.hint - 输入框上方的说明。
 */
export function UnlockDialog({
  config,
  open,
  onClose,
  onUnlock,
  title = '🔓 解锁',
  hint = '输入 JVS 口令以解锁受保护的模块。',
}: {
  config: SecurityConfig;
  open: boolean;
  onClose: () => void;
  onUnlock: () => void;
  title?: string;
  hint?: string;
}): React.ReactElement {
  const [password, setPassword] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  // 每次重新打开都清空，避免上次的错误/残留。
  React.useEffect(() => {
    if (!open) return;
    setPassword('');
    setError(null);
    setBusy(false);
  }, [open]);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (await verifyPassword(password, config)) {
        setPassword('');
        onUnlock();
      } else {
        setError('口令不正确。');
        setPassword('');
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} title={title} onClose={onClose} width={380}>
      <form className="form lockdialog" onSubmit={(event) => void submit(event)}>
        <p className="lockdialog__hint">{hint}</p>
        <label className="field">
          <span>口令</span>
          <input
            type="password"
            value={password}
            autoFocus
            autoComplete="current-password"
            placeholder="输入 JVS 口令"
            aria-label="JVS 口令"
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        {error !== null && <p className="form__error" role="alert">{error}</p>}
        <div className="form__actions">
          <button type="submit" className="btn btn--primary" disabled={busy || password === ''}>
            {busy ? '校验中…' : '确认'}
          </button>
          <button type="button" className="btn" onClick={onClose}>取消</button>
        </div>
      </form>
    </Modal>
  );
}
