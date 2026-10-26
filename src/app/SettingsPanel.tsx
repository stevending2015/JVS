/**
 * 设置面板：应用锁 + 数据备份/导入 + 媒体源。
 *
 * 三个标签页分开，因为它们的性质完全不同 —— 「安全」是随手能改的开关，
 * 「数据」里有会清空一切的操作，需要额外的确认步骤，「媒体」则只跟词光模块有关。
 *
 * 「媒体」单独占一个标签页而不是塞进「数据」：它以前只藏在词光 atlas 的统计页最底下，
 * 没人找得到；放一个一级标签页，用户在 ⚙ 里一眼就能看见。
 */

import * as React from 'react';
import { Modal } from './Modal.js';
import { CountdownRingSetting } from './CountdownRingSetting.js';
import { MediaSourceSetting } from './MediaSourceSetting.js';
import { listModules } from '../core/module/registry.js';
import {
  ALL_MODULES,
  AUTO_LOCK_CHOICES,
  DEFAULT_AUTO_LOCK_MS,
  MIN_PASSWORD_LENGTH,
  clearPassword,
  clearSessionUnlock,
  readSecurityConfig,
  setAutoLockMs,
  setPassword,
  setProtectedModules,
  verifyPassword,
  verifyFingerprint,
  type SecurityConfig,
} from '../core/security/password.js';
import {
  BACKUP_EXTENSION,
  backupFileName,
  exportBackupText,
  inspectBackupText,
  restoreBackup,
  type BackupEnvelope,
  type BackupInspection,
} from '../core/backup/backup.js';

type Tab = 'security' | 'data' | 'media';

/** 设置面板。 */
export function SettingsPanel({ open, onClose }: { open: boolean; onClose: () => void }): React.ReactElement {
  const [tab, setTab] = React.useState<Tab>('security');
  return (
    <Modal open={open} title="设置" onClose={onClose} width={560}>
      <div className="settings">
        <div className="settings__tabs" role="tablist" aria-label="设置分类">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'security'}
            className={tab === 'security' ? 'is-active' : ''}
            onClick={() => setTab('security')}
          >
            🔒 安全
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'data'}
            className={tab === 'data' ? 'is-active' : ''}
            onClick={() => setTab('data')}
          >
            💾 数据
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'media'}
            className={tab === 'media' ? 'is-active' : ''}
            onClick={() => setTab('media')}
          >
            🖼 媒体
          </button>
        </div>
        {tab === 'security' ? <SecurityTab /> : tab === 'data' ? <DataTab /> : <MediaTab />}
      </div>
    </Modal>
  );
}

// ────────────────────────────── 媒体 ──────────────────────────────

/**
 * 媒体源标签页。
 *
 * 复用了共享的 MediaSourceSetting —— 和词光 atlas 统计页里那份是同一个组件，
 * 两边不会各存一份状态、改了一边另一边不知道。
 *
 * 倒计时到期响铃也放在这里：它同样是一种「声音」，而开关和音量原来只做在
 * 倒计时页最底部，用户几乎找不到。
 *
 * @returns 媒体设置界面。
 */
function MediaTab(): React.ReactElement {
  return (
    <div className="settings__pane">
      <h4 className="settings__sub">媒体源</h4>
      <p className="settings__hint">
        词光 atlas 的插画和音频不进数据库，学习时按需从远端（或本地目录）拉取。
        这里填媒体服务器的基地址；留空则自动选择，填 <code>local</code> 强制使用本地目录。
        部署方式见 <code>docs/word-media-deploy.md</code>。
      </p>
      <MediaSourceSetting />

      <hr className="settings__rule" />

      <CountdownRingSetting />
    </div>
  );
}

// ────────────────────────────── 安全 ──────────────────────────────

function SecurityTab(): React.ReactElement {
  const [config, setConfig] = React.useState<SecurityConfig | null>(null);
  const [loaded, setLoaded] = React.useState(false);
  const [password, setPasswordValue] = React.useState('');
  const [confirm, setConfirm] = React.useState('');
  const [oldPassword, setOldPassword] = React.useState('');
  const [scope, setScope] = React.useState<string[]>([]);
  const [autoLockMs, setAutoLockState] = React.useState<number>(DEFAULT_AUTO_LOCK_MS);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const modules = listModules();

  React.useEffect(() => {
    void (async () => {
      const current = await readSecurityConfig().catch(() => null);
      setConfig(current);
      setScope(current?.modules ?? []);
      setAutoLockState(current?.autoLockMs ?? DEFAULT_AUTO_LOCK_MS);
      setLoaded(true);
    })();
  }, []);

  async function save(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setMessage(null);
    if (password !== confirm) {
      setError('两次输入的口令不一致。');
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`口令至少 ${MIN_PASSWORD_LENGTH} 位。`);
      return;
    }
    if (config !== null && !(await verifyPassword(oldPassword, config))) {
      setError('当前口令不正确。');
      return;
    }
    setBusy(true);
    try {
      await setPassword(password, scope);
      await setAutoLockMs(autoLockMs);
      const next = await readSecurityConfig();
      setConfig(next);
      clearSessionUnlock();
      setPasswordValue('');
      setConfirm('');
      setOldPassword('');
      setMessage('应用锁已启用。下次打开（或刷新）需要输入口令。');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function updateScope(): Promise<void> {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await setProtectedModules(scope);
      await setAutoLockMs(autoLockMs);
      setConfig(await readSecurityConfig());
      setMessage('受保护范围与自动锁时长已更新。');
    } finally {
      setBusy(false);
    }
  }

  async function disable(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      if (!(await verifyPassword(oldPassword, config))) {
        setError('输入当前口令才能关闭应用锁。');
        return;
      }
      await clearPassword();
      clearSessionUnlock();
      setConfig(null);
      setOldPassword('');
      setScope([]);
      setMessage('应用锁已关闭。');
    } finally {
      setBusy(false);
    }
  }

  function toggleModule(id: string): void {
    setScope((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
  }

  if (!loaded) return <p className="settings__hint">正在读取…</p>;

  const enabled = config !== null && config.enabled;

  return (
    <div className="settings__pane">
      <p className="settings__hint">
        应用锁用来挡住「别人顺手打开你的 JVS」。它<span className="settings__warn-inline">不是数据库加密</span>
        —— 数据库文件在浏览器里仍是明文，能读开发者工具的人可以绕过。要真正的加密需要 SQLCipher
        构建，当前版本没有。
      </p>

      {!enabled && (
        <form className="form settings__form" onSubmit={(e) => void save(e)}>
          <label className="field">
            <span>新口令</span>
            <input
              type="password"
              value={password}
              autoComplete="new-password"
              placeholder={`至少 ${MIN_PASSWORD_LENGTH} 位`}
              onChange={(event) => setPasswordValue(event.target.value)}
            />
          </label>
          <label className="field">
            <span>再输一次</span>
            <input
              type="password"
              value={confirm}
              autoComplete="new-password"
              onChange={(event) => setConfirm(event.target.value)}
            />
          </label>

          <fieldset className="settings__scope">
            <legend>保护哪些模块</legend>
            <label className="settings__check">
              <input
                type="checkbox"
                checked={scope.includes(ALL_MODULES)}
                onChange={(event) =>
                  setScope(event.target.checked ? [ALL_MODULES] : [])
                }
              />
              <span><b>全部模块</b>（打开 JVS 就要求口令）</span>
            </label>
            <div className="settings__grid">
              {modules.map((module) => (
                <label key={module.id} className="settings__check">
                  <input
                    type="checkbox"
                    disabled={scope.includes(ALL_MODULES)}
                    checked={scope.includes(module.id)}
                    onChange={() => toggleModule(module.id)}
                  />
                  <span>{module.icon} {module.title}</span>
                </label>
              ))}
            </div>
            <p className="settings__hint settings__hint--small">
              一个都不勾 = 不启用应用锁。
            </p>
          </fieldset>

          <label className="field">
            <span>空闲自动上锁</span>
            <select
              value={String(autoLockMs)}
              onChange={(event) => setAutoLockState(Number(event.target.value))}
            >
              {AUTO_LOCK_CHOICES.map((choice) => (
                <option key={choice.ms} value={String(choice.ms)}>{choice.label}</option>
              ))}
            </select>
          </label>
          <p className="settings__hint settings__hint--small">
            超过这个时间没有任何点击/按键，受保护的模块会自动重新上锁。
          </p>

          {error !== null && <p className="form__error">{error}</p>}
          {message !== null && <p className="settings__ok">{message}</p>}
          <div className="form__actions">
            <button type="submit" className="btn btn--primary" disabled={busy || scope.length === 0}>
              {busy ? '设置中…' : '启用应用锁'}
            </button>
          </div>
        </form>
      )}

      {enabled && (
        <div className="settings__form">
          <p className="settings__ok">应用锁已启用（自 {new Date(config.since).toLocaleDateString('zh-CN')}）。</p>

          <fieldset className="settings__scope">
            <legend>受保护范围</legend>
            <label className="settings__check">
              <input
                type="checkbox"
                checked={scope.includes(ALL_MODULES)}
                onChange={(event) => setScope(event.target.checked ? [ALL_MODULES] : [])}
              />
              <span><b>全部模块</b>（打开 JVS 就要求口令）</span>
            </label>
            <div className="settings__grid">
              {modules.map((module) => (
                <label key={module.id} className="settings__check">
                  <input
                    type="checkbox"
                    disabled={scope.includes(ALL_MODULES)}
                    checked={scope.includes(module.id)}
                    onChange={() => toggleModule(module.id)}
                  />
                  <span>{module.icon} {module.title}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <label className="field">
            <span>空闲自动上锁</span>
            <select
              value={String(autoLockMs)}
              onChange={(event) => setAutoLockState(Number(event.target.value))}
            >
              {AUTO_LOCK_CHOICES.map((choice) => (
                <option key={choice.ms} value={String(choice.ms)}>{choice.label}</option>
              ))}
            </select>
          </label>
          <p className="settings__hint settings__hint--small">
            超过这个时间没有任何点击/按键，受保护的模块会自动重新上锁。
          </p>
          <div className="form__actions">
            <button type="button" className="btn" disabled={busy} onClick={() => void updateScope()}>
              保存范围
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                clearSessionUnlock();
                setMessage('已锁定，下次进入受保护模块需要口令。');
              }}
            >
              立即锁定
            </button>
          </div>

          <hr className="settings__rule" />

          <h4 className="settings__sub">修改口令</h4>
          <form className="form" onSubmit={(e) => void save(e)}>
            <label className="field">
              <span>当前口令</span>
              <input
                type="password"
                value={oldPassword}
                autoComplete="current-password"
                onChange={(event) => setOldPassword(event.target.value)}
              />
            </label>
            <label className="field">
              <span>新口令</span>
              <input
                type="password"
                value={password}
                autoComplete="new-password"
                onChange={(event) => setPasswordValue(event.target.value)}
              />
            </label>
            <label className="field">
              <span>再输一次</span>
              <input
                type="password"
                value={confirm}
                autoComplete="new-password"
                onChange={(event) => setConfirm(event.target.value)}
              />
            </label>
            {error !== null && <p className="form__error">{error}</p>}
            {message !== null && <p className="settings__ok">{message}</p>}
            <div className="form__actions">
              <button type="submit" className="btn btn--primary" disabled={busy}>
                {busy ? '保存中…' : '修改口令'}
              </button>
              <button type="button" className="btn btn--danger" disabled={busy} onClick={() => void disable()}>
                关闭应用锁
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

// ────────────────────────────── 数据 ──────────────────────────────

function DataTab(): React.ReactElement {
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  /** 待确认的导入。 */
  const [pending, setPending] = React.useState<{
    text: string;
    inspection: BackupInspection;
  } | null>(null);
  const [password, setPassword] = React.useState('');
  const [progress, setProgress] = React.useState<string | null>(null);

  async function download(): Promise<void> {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const text = await exportBackupText();
      const blob = new Blob([text], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = backupFileName();
      document.body.appendChild(link);
      link.click();
      link.remove();
      // 稍后再释放，避免下载还没开始就被撤销。
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      const kb = Math.round(text.length / 1024);
      setMessage(`已导出备份（约 ${kb} KB）。`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function pickFile(event: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file === undefined) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    setPending(null);
    setPassword('');
    try {
      const text = await file.text();
      const inspection = inspectBackupText(text);
      if (!inspection.ok) {
        setError(inspection.error ?? '备份文件不合法。');
        return;
      }
      setPending({ text, inspection });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function confirmImport(): Promise<void> {
    if (pending === null) return;
    setBusy(true);
    setError(null);
    try {
      const envelope = pending.inspection.envelope as BackupEnvelope;
      // 备份带口令指纹：必须先证明自己知道那个口令。
      if (pending.inspection.needsPassword && envelope.password !== null) {
        const ok = await verifyFingerprint(password, envelope.password);
        if (!ok) {
          setError('口令不正确，无法导入这份备份。');
          return;
        }
      }
      const result = await restoreBackup(envelope, (done, total) => {
        setProgress(`正在写入 ${done} / ${total} 行…`);
      });
      setProgress(null);
      setMessage(`导入完成，共写入 ${result.inserted} 行。正在重新载入…`);
      // 数据整体换掉了，让应用重新读一遍库。
      setTimeout(() => location.reload(), 900);
    } catch (e) {
      setProgress(null);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const preview = pending?.inspection;
  const tableLabels: Array<[string, string]> = [
    ['person', '生日与亲友'],
    ['family', '家族'],
    ['family_child', '亲子关系'],
    ['countdown', '倒计时'],
    ['note', '笔记'],
    ['note_image', '笔记图片'],
    ['focus_session', '专注记录'],
    ['goal', '目标'],
    ['goal_sub', '目标子项'],
    ['goal_log', '目标打卡'],
    ['word_entry', '词库词条'],
    ['word_card', '单词卡片'],
    ['word_day', '每日统计'],
    ['word_set', '词集'],
    ['word_set_item', '词集条目'],
    ['word_mistake', '错词'],
    ['setting', '偏好设置'],
    ['app_meta', '元数据'],
  ];

  return (
    <div className="settings__pane">
      <h4 className="settings__sub">导出备份</h4>
      <p className="settings__hint">
        把全部本地数据导出成一个 <code>.{BACKUP_EXTENSION}</code> 文件，可在另一台机器上用「导入」还原。
        媒体（插画、音频）不在备份里 —— 它们本来就不进数据库。
      </p>
      <div className="form__actions">
        <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void download()}>
          {busy ? '打包中…' : '导出全部数据'}
        </button>
      </div>

      <hr className="settings__rule" />

      <h4 className="settings__sub">导入备份</h4>
      <p className="settings__hint">
        导入会<span className="settings__warn-inline">先清空这台机器上的全部数据</span>，再写入备份里的内容。
        文件会先经过校验，确认是 JVS 的备份才允许继续。
      </p>
      <div className="form__actions">
        <label className="btn settings__filebtn">
          选择备份文件
          <input type="file" accept=".jvsbackup,.json,application/json" hidden onChange={(e) => void pickFile(e)} />
        </label>
      </div>

      {error !== null && <p className="form__error">{error}</p>}
      {message !== null && <p className="settings__ok">{message}</p>}
      {progress !== null && <p className="settings__ok">{progress}</p>}

      {preview !== undefined && pending !== null && (
        <div className="settings__preview">
          <p className="settings__preview-head">
            ✅ 文件校验通过：{preview.totalRows} 行数据，导出于{' '}
            {preview.envelope === undefined
              ? '未知时间'
              : new Date(preview.envelope.exportedAt).toLocaleString('zh-CN')}
          </p>
          {preview.warnings.length > 0 && (
            <ul className="settings__warnings">
              {preview.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          )}
          <details className="settings__counts">
            <summary>各表行数</summary>
            <table className="settings__table">
              <tbody>
                {tableLabels.map(([table, label]) => (
                  <tr key={table}>
                    <td>{label}</td>
                    <td className="settings__num">{preview.counts[table] ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>

          {preview.needsPassword && (
            <label className="field">
              <span>这份备份设有口令，请输入</span>
              <input
                type="password"
                value={password}
                autoComplete="current-password"
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
          )}

          <p className="settings__danger">
            ⚠️ 继续将<b>永久删除本机现有数据</b>，且无法撤销。建议先导出一份当前备份。
          </p>
          <div className="form__actions">
            <button
              type="button"
              className="btn btn--danger"
              disabled={busy || (preview.needsPassword && password === '')}
              onClick={() => void confirmImport()}
            >
              {busy ? '导入中…' : '清空本机数据并导入'}
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => setPending(null)}>
              取消
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
