/**
 * 家族树 module.
 *
 * Data model: GEDCOM's two-record model (`family` = a union, `family_child` =
 * children with an explicit pedigree). "Sibling" is never stored — siblings are
 * just other children of the same family.
 *
 * Three views: 世系图 (tidy SVG tree, ancestors above / descendants below),
 * 世代列表 (齿录, grouped by 世次) and a relation detail panel. Person edits reuse
 * one full form so the 中式著录 fields are available everywhere.
 */

import * as React from 'react';
import { Modal } from '../../app/Modal.js';
import { NoteRepository } from '../../core/note/repository.js';
import type { Note } from '../../core/note/types.js';
import { hub, USER_TIMEZONE } from '../../core/calendar/instance.js';
import { PersonRepository } from '../../core/person/repository.js';
import type { Person, PersonInput } from '../../core/person/types.js';
import { FamilyRepository } from '../../core/family/repository.js';
import { BOX, MARRIAGE_NODE, layoutTree } from '../../core/family/layout.js';
import { exportGedcom } from '../../core/family/gedcom.js';
import {
  FAMILY_KIND_LABELS,
  FAMILY_KINDS,
  PEDIGREE_LABELS,
  PEDIGREES,
  type Family,
  type FamilyChild,
  type FamilyKind,
  type Pedigree,
} from '../../core/family/types.js';
import { timezoneGroups } from '../../core/util/timezones.js';
import { getSetting, setSetting } from '../../core/setting/repository.js';
import { readFamilyRoot, writeFamilyRoot } from '../../core/family/root.js';
import { useStore } from '../../core/store.js';

/** Setting key: whether daughters' descendants are expanded (traditional 族谱 keep them collapsed). */
const KEY_EXPAND_FEMALE = 'family.expandFemale';

const persons = new PersonRepository(hub);
const repo = new FamilyRepository(persons);

function downloadText(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

/** Load the whole graph; the tree is small enough to keep in memory. */
function useFamilyData() {
  const [state, setState] = React.useState<{
    persons: Person[];
    families: Family[];
    children: FamilyChild[];
    loading: boolean;
    error: string | null;
  }>({ persons: [], families: [], children: [], loading: true, error: null });

  const readGraph = React.useCallback(async () => {
    const [nextPersons, nextFamilies, nextChildren] = await Promise.all([
      repo.listPersons(),
      repo.listFamilies(),
      repo.listChildren(),
    ]);
    setState({ persons: nextPersons, families: nextFamilies, children: nextChildren, loading: false, error: null });
  }, []);

  const reload = React.useCallback(async () => {
    try {
      // Paint first, then settle 世次: deriving it costs a handful of writes, and on a
      // cold start that must not hold the tree hostage ("正在读取族谱…" forever).
      await readGraph();
      const changed = await repo.syncGenerations().catch(() => 0);
      // Only re-read when the derivation actually rewrote something.
      if (changed > 0) await readGraph();
    } catch (e) {
      setState((prev) => ({ ...prev, loading: false, error: (e as Error).message }));
    }
  }, [readGraph]);

  React.useEffect(() => {
    void reload();
  }, [reload]);

  return { ...state, reload };
}

/** Short line shown under a name: 生卒 + 世次. */
function personMeta(person: Person): string {
  const parts: string[] = [];
  if (person.generation !== null) parts.push(`${person.generation}世`);
  if (person.gregorian_local_date !== null) parts.push(person.gregorian_local_date.slice(0, 4));
  if (person.death_date !== null) parts.push(`–${person.death_date.slice(0, 4)}`);
  return parts.join(' ') || '—';
}

// --------------------------------------------------------------- person form ---

interface PersonFormProps {
  open: boolean;
  title: string;
  initial?: Person;
  defaultGeneration?: number | null;
  defaultRelation?: string;
  onCancel: () => void;
  onSubmit: (input: PersonInput) => Promise<void>;
  /** When set, offers a shortcut to attach an existing person instead. */
  onPickExisting?: () => void;
}

function PersonForm({
  open, title, initial, defaultGeneration, defaultRelation, onCancel, onSubmit, onPickExisting,
}: PersonFormProps): React.ReactElement | null {
  const calendars = React.useMemo(() => hub.listCalendars(), []);
  const tzGroups = React.useMemo(() => timezoneGroups(), []);
  const [calendarSystem, setCalendarSystem] = React.useState(
    initial?.calendar_system ?? calendars[0]?.id ?? 'gregorian',
  );
  const calendar = React.useMemo(
    () => calendars.find((c) => c.id === calendarSystem),
    [calendars, calendarSystem],
  );
  const [fields, setFields] = React.useState<Record<string, unknown>>({});
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    const active = hub.listCalendars().find((c) => c.id === calendarSystem);
    if (initial !== undefined && initial !== null && calendarSystem === initial.calendar_system) {
      setFields(PersonRepository.fieldsOf(initial));
      return;
    }
    const defaults: Record<string, unknown> = {};
    for (const field of active?.fields ?? []) {
      if (field.defaultValue !== undefined) defaults[field.key] = field.defaultValue;
    }
    setFields(defaults);
  }, [open, calendarSystem, initial]);

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const generationRaw = String(data.get('generation') ?? '').trim();
    const input: PersonInput = {
      name: String(data.get('name') ?? ''),
      gender: String(data.get('gender') ?? 'unspecified'),
      relationLabel: String(data.get('relation') ?? ''),
      note: String(data.get('note') ?? ''),
      calendarSystem,
      fields,
      birthTimezone: String(data.get('timezone') ?? USER_TIMEZONE),
      generation: generationRaw === '' ? null : Number(generationRaw),
      generationChar: String(data.get('generationChar') ?? ''),
      courtesyName: String(data.get('courtesyName') ?? ''),
      artName: String(data.get('artName') ?? ''),
      ranking: String(data.get('ranking') ?? ''),
      nativePlace: String(data.get('nativePlace') ?? ''),
      burialPlace: String(data.get('burialPlace') ?? ''),
      deathDate: String(data.get('deathDate') ?? ''),
    };
    setBusy(true);
    setError(null);
    try {
      await onSubmit(input);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;
  return (
    <Modal open={open} title={title} onClose={onCancel} width={620}>
      <form className="form" onSubmit={(e) => void submit(e)}>
        <div className="form__row">
          <label>姓名<input name="name" required autoFocus defaultValue={initial?.name ?? ''} /></label>
          <label>
            性别
            <select name="gender" defaultValue={initial?.gender ?? 'unspecified'}>
              <option value="male">男</option>
              <option value="female">女</option>
              <option value="other">其他</option>
              <option value="unspecified">不填</option>
            </select>
          </label>
          <label>关系称呼<input name="relation" defaultValue={initial?.relation_label ?? defaultRelation ?? ''} placeholder="如 父亲" /></label>
        </div>

        <h4 className="form__section">中式著录</h4>
        <div className="form__row form__row--three">
          <label>
            世次
            <input
              type="text"
              readOnly
              value={
                initial?.generation !== null && initial?.generation !== undefined
                  ? `第 ${initial.generation} 世`
                  : '保存后按关系自动推算'
              }
            />
          </label>
          <label>字辈<input name="generationChar" defaultValue={initial?.generation_char ?? ''} /></label>
          <label>排行<input name="ranking" defaultValue={initial?.ranking ?? ''} /></label>
        </div>
        <div className="form__row">
          <label>字<input name="courtesyName" defaultValue={initial?.courtesy_name ?? ''} /></label>
          <label>号<input name="artName" defaultValue={initial?.art_name ?? ''} /></label>
          <label>籍贯<input name="nativePlace" defaultValue={initial?.native_place ?? ''} /></label>
        </div>
        <div className="form__row">
          <label>卒（日期或年份）<input name="deathDate" defaultValue={initial?.death_date ?? ''} /></label>
          <label>葬处<input name="burialPlace" defaultValue={initial?.burial_place ?? ''} /></label>
          <span />
        </div>

        <h4 className="form__section">出生（可留空：先人常无生卒记载）</h4>
        <div className="form__row">
          <label>
            历法
            <select value={calendarSystem} onChange={(e) => setCalendarSystem(e.target.value)}>
              {calendars.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <span />
          <span />
        </div>
        <div className="form__row form__row--date">
          {(calendar?.fields ?? []).map((field) => (
            <label key={field.key}>
              {field.label}
              {field.type === 'boolean' ? (
                <input
                  type="checkbox"
                  checked={Boolean(fields[field.key])}
                  onChange={(e) => setFields((prev) => ({ ...prev, [field.key]: e.target.checked }))}
                />
              ) : field.type === 'number' ? (
                <input
                  type="number"
                  name={'f_' + field.key}
                  value={fields[field.key] === undefined ? '' : String(fields[field.key])}
                  onChange={(e) =>
                    setFields((prev) => ({
                      ...prev,
                      [field.key]: e.target.value === '' ? undefined : Number(e.target.value),
                    }))
                  }
                />
              ) : field.options !== undefined ? (
                <select
                  name={'f_' + field.key}
                  value={String(fields[field.key] ?? field.defaultValue ?? '')}
                  onChange={(e) => setFields((prev) => ({ ...prev, [field.key]: e.target.value }))}
                >
                  {field.options.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              ) : (
                <input
                  name={'f_' + field.key}
                  value={String(fields[field.key] ?? '')}
                  onChange={(e) => setFields((prev) => ({ ...prev, [field.key]: e.target.value }))}
                />
              )}
            </label>
          ))}
        </div>
        <label>
          出生时区
          <select name="timezone" defaultValue={initial?.birth_timezone ?? USER_TIMEZONE}>
            {tzGroups.map((group) => (
              <optgroup key={group.label} label={group.label}>
                {group.options.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>

        <label>备注<input name="note" defaultValue={initial?.note ?? ''} /></label>
        {error !== null && <div className="banner banner--bad">{error}</div>}
        <div className="form__actions">
          <button type="submit" className="primary" disabled={busy}>{busy ? '保存中…' : '保存'}</button>
          {onPickExisting !== undefined && (
            <button type="button" className="link link--edit" onClick={onPickExisting} disabled={busy}>
              从已有成员中选择
            </button>
          )}
          <button type="button" onClick={onCancel} disabled={busy}>取消</button>
        </div>
      </form>
    </Modal>
  );
}

// ------------------------------------------------------------------ tree view ---

function TreeView({
  persons: allPersons, families, children, focusId, expandFemale, onSelect,
}: {
  persons: Person[];
  families: Family[];
  children: FamilyChild[];
  focusId: string;
  expandFemale: boolean;
  onSelect: (id: string) => void;
}): React.ReactElement {
  const layout = React.useMemo(
    () => layoutTree({ focusId, persons: allPersons, families, children, ancestorDepth: 4, expandFemale }),
    [focusId, allPersons, families, children, expandFemale],
  );
  const [zoom, setZoom] = React.useState(1);
  const byId = React.useMemo(() => new Map(allPersons.map((p) => [p.id, p])), [allPersons]);
  const scrollRef = React.useRef<HTMLDivElement | null>(null);

  const pad = 40;
  const width = Math.max(320, layout.maxX - layout.minX + pad * 2);
  const height = Math.max(240, layout.maxY - layout.minY + pad * 2);
  const offsetX = pad - layout.minX;
  const offsetY = pad - layout.minY;

  // Switching the root changes the canvas size. Without this the scroll offset is
  // left pointing at where the OLD tree used to be, so the view shows stale or
  // empty space and the switch looks like it did nothing.
  React.useEffect(() => {
    const element = scrollRef.current;
    if (element === null) return;
    const rootBox = layout.boxes.find((box) => box.personId === focusId);
    if (rootBox === undefined) return;
    const centerX = (rootBox.x + rootBox.width / 2 + offsetX) * zoom;
    element.scrollLeft = Math.max(0, centerX - element.clientWidth / 2);
    element.scrollTop = 0;
    // Only on a root change: re-running for zoom would fight the user's panning.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId]);

  return (
    <div className="ft-canvas">
      <div className="ft-zoom">
        <button type="button" onClick={() => setZoom((z) => Math.min(2, Number((z + 0.15).toFixed(2))))}>＋</button>
        <span>{Math.round(zoom * 100)}%</span>
        <button type="button" onClick={() => setZoom((z) => Math.max(0.4, Number((z - 0.15).toFixed(2))))}>－</button>
        <button type="button" onClick={() => setZoom(1)}>1:1</button>
      </div>
      <div className="ft-scroll" ref={scrollRef}>
        <div style={{ width: width * zoom, height: height * zoom }}>
          <svg
            className="ft-svg"
            width={width}
            height={height}
            style={{ transform: `scale(${zoom})`, transformOrigin: '0 0' }}
            role="img"
            aria-label="世系图"
          >
            <g transform={`translate(${offsetX}, ${offsetY})`}>
              {layout.ownerToMarriage.map((d, index) => (
                <path key={`om${index}`} d={d} className="ft-link" />
              ))}
              {layout.childPaths.map((d, index) => (
                <path key={`cp${index}`} d={d} className="ft-link" />
              ))}
              {layout.spouseTies.map((tie, index) => (
                <line
                  key={`st${index}`}
                  x1={tie.x1}
                  y1={tie.y1}
                  x2={tie.x2}
                  y2={tie.y2}
                  className={tie.divorced ? 'ft-tie ft-tie--divorced' : 'ft-tie'}
                />
              ))}

              {layout.marriages.map((marriage, index) => (
                <g key={`m${index}`} className={`ft-marriage${marriage.divorced ? ' is-divorced' : ''}`}>
                  <rect
                    x={marriage.x - MARRIAGE_NODE / 2}
                    y={marriage.y - MARRIAGE_NODE / 2}
                    width={MARRIAGE_NODE}
                    height={MARRIAGE_NODE}
                    transform={`rotate(45 ${marriage.x} ${marriage.y})`}
                  />
                  {marriage.divorced && (
                    <text x={marriage.x} y={marriage.y - MARRIAGE_NODE / 2 - 5} textAnchor="middle" className="ft-divorce">
                      离
                    </text>
                  )}
                  {marriage.spouseBox !== null && (
                    <text
                      x={marriage.x + MARRIAGE_NODE / 2 + 6}
                      y={marriage.y - MARRIAGE_NODE / 2 - 3}
                      className="ft-kind"
                    >
                      {FAMILY_KIND_LABELS[marriage.kind as FamilyKind] ?? marriage.kind}
                    </text>
                  )}
                </g>
              ))}

              {layout.boxes.map((box) => {
                const person = byId.get(box.personId);
                if (person === undefined) return null;
                return (
                  <g
                    key={`${box.personId}-${box.role}`}
                    transform={`translate(${box.x}, ${box.y})`}
                    className={`ft-node ft-node--${box.role}${box.personId === focusId ? ' is-focus' : ''}`}
                    onClick={() => onSelect(box.personId)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') onSelect(box.personId);
                    }}
                  >
                    <rect width={box.width} height={box.height} rx={box.role === 'spouse' ? 16 : 10} />
                    {box.personId === focusId && (
                      <text x={box.width - 9} y={13} textAnchor="end" className="ft-root-mark">
                        {person.is_self === 1 ? '本人' : '根'}
                      </text>
                    )}
                    <text x={box.width / 2} y={22} textAnchor="middle" className="ft-node__name">
                      {person.name}
                    </text>
                    <text x={box.width / 2} y={40} textAnchor="middle" className="ft-node__meta">
                      {personMeta(person)}
                    </text>
                  </g>
                );
              })}
            </g>
          </svg>
        </div>
      </div>
      <div className="ft-hint">
        滚轮缩放 · 点击成员查看关系 · ◇ 为婚次节点 · 实线初婚、虚线离异 · 主人重、配偶轻 · 带「本人」的为本人（族谱以 TA 为中心）；其余带「根」的为当前根
      </div>
    </div>
  );
}
// ------------------------------------------------------------------- the page ---


  /** Which relation an existing person is being attached as. */
  type PickRole = 'parent-father' | 'parent-mother' | 'spouse' | 'child';
type DialogState =
  | { kind: 'add-member' }
  | { kind: 'edit'; person: Person }
  | { kind: 'add-parent'; anchor: Person; role: 'father' | 'mother' }
  | { kind: 'add-spouse'; anchor: Person }
  | { kind: 'add-child'; anchor: Person; familyId?: string }
  | { kind: 'delete'; person: Person }
  | { kind: 'pick'; role: PickRole; anchor: Person; familyId?: string };

export function FamilyCard(): React.ReactElement {
  const { persons: list } = useStore();
  return (
    <div>
      <div className="mini-big">{list.length} 位成员</div>
      <div className="mini-list__meta">{list.length === 0 ? '还没有成员' : '点击进入世系图'}</div>
    </div>
  );
}

export function FamilyPage(): React.ReactElement {
  const { reload: reloadStore } = { reload: useStore().refresh };
  const data = useFamilyData();
  const [view, setView] = React.useState<'tree' | 'list'>('tree');
  const [focusId, setFocusId] = React.useState<string | null>(null);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [dialog, setDialog] = React.useState<DialogState | null>(null);
  const [search, setSearch] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [expandFemale, setExpandFemale] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const [personNotes, setPersonNotes] = React.useState<Note[]>([]);
  const [picking, setPicking] = React.useState(false);
  const [pickQuery, setPickQuery] = React.useState('');

  React.useEffect(() => {
    void (async () => {
      const saved = await getSetting(KEY_EXPAND_FEMALE).catch(() => null);
      if (saved === '1') setExpandFemale(true);
    })();
  }, []);

  const toggleExpandFemale = React.useCallback(() => {
    setExpandFemale((prev) => {
      const next = !prev;
      void setSetting(KEY_EXPAND_FEMALE, next ? '1' : '0').catch(() => undefined);
      return next;
    });
  }, []);

  // Changing the root is a navigation action: keep the detail panel from showing
  // somebody who may not even be in the new tree, which read as "nothing updated".
  React.useEffect(() => {
    setSelectedId(null);
  }, [focusId]);

  /**
   * Pick a sensible default root.
   *
   * Order: 记住的根（上次手动设的）, then 本人, then whoever is most CONNECTED,
   * then simply the first person.
   *
   * "Most connected" matters because the list is name-sorted and shared with the
   * birthday module: a person added there (say 「示例父辈乙」) can sort before the actual
   * family founder, become the root, and leave the tree showing a single box — the
   * family looks empty even though it is not.
   */
  React.useEffect(() => {
    if (focusId !== null) return;
    let cancelled = false;
    void (async () => {
      // 上次手动设的根：重启后族谱仍从这里展开。
      const saved = await readFamilyRoot().catch(() => null);
      if (cancelled) return;
      if (saved !== null && data.persons.some((person) => person.id === saved)) {
        setFocusId(saved);
        return;
      }
      const self = data.persons.find((p) => p.is_self === 1);
      if (self !== undefined) {
        setFocusId(self.id);
        return;
      }
      const score = (person: Person): number => {
        const own = data.families.filter(
          (family) => family.husband_id === person.id || family.wife_id === person.id,
        );
        const children = data.children.filter((row) => own.some((family) => family.id === row.family_id));
        const parents = data.children.filter((row) => row.child_id === person.id);
        return own.length * 2 + children.length * 2 + parents.length;
      };
      let chosen: Person | undefined;
      let bestScore = 0;
      for (const person of data.persons) {
        const personScore = score(person);
        if (personScore > bestScore) {
          bestScore = personScore;
          chosen = person;
        }
      }
      if (chosen === undefined) chosen = data.persons[0];
      if (chosen !== undefined) setFocusId(chosen.id);
    })();
    return () => { cancelled = true; };
  }, [data.persons, data.families, data.children, focusId]);

  const byId = React.useMemo(() => new Map(data.persons.map((p) => [p.id, p])), [data.persons]);
  const selected = selectedId === null ? undefined : byId.get(selectedId);

  /**
   * Change the root and remember it.
   *
   * The root is persisted, so reopening the app shows the same tree — unless it is
   * changed by hand. 「本人」(is_self) is a separate thing and is left alone.
   *
   * The root also anchors 世次: the root is the first generation, and everyone
   * below follows. So the generations are re-derived right away.
   *
   * @param personId - the new root.
   */
  const setRoot = React.useCallback(
    (personId: string) => {
      setFocusId(personId);
      void (async () => {
        await writeFamilyRoot(personId).catch(() => undefined);
        await repo.syncGenerations().catch(() => 0);
        await data.reload();
      })();
    },
    [repo, data],
  );

  const parentsOf = React.useCallback(
    (personId: string): { father: Person | null; mother: Person | null } => {
      let father: Person | null = null;
      let mother: Person | null = null;
      for (const row of data.children) {
        if (row.child_id !== personId || row.pedigree !== 'birth') continue;
        const family = data.families.find((f) => f.id === row.family_id);
        if (family === undefined) continue;
        father = family.husband_id === null ? null : byId.get(family.husband_id) ?? null;
        mother = family.wife_id === null ? null : byId.get(family.wife_id) ?? null;
      }
      return { father, mother };
    },
    [data.children, data.families, byId],
  );

  const spousesOf = React.useCallback(
    (personId: string): Array<{ person: Person; kind: string; familyId: string }> => {
      const result: Array<{ person: Person; kind: string; familyId: string }> = [];
      for (const family of data.families) {
        const isHusband = family.husband_id === personId;
        const isWife = family.wife_id === personId;
        if (!isHusband && !isWife) continue;
        const otherId = isHusband ? family.wife_id : family.husband_id;
        if (otherId === null) continue;
        const other = byId.get(otherId);
        if (other !== undefined) result.push({ person: other, kind: family.kind, familyId: family.id });
      }
      return result;
    },
    [data.families, byId],
  );

  const childrenOf = React.useCallback(
    (personId: string): Array<{ person: Person; pedigree: string }> => {
      const result: Array<{ person: Person; pedigree: string }> = [];
      const familyIds = data.families
        .filter((f) => f.husband_id === personId || f.wife_id === personId)
        .map((f) => f.id);
      for (const row of data.children) {
        if (!familyIds.includes(row.family_id)) continue;
        const child = byId.get(row.child_id);
        if (child !== undefined) result.push({ person: child, pedigree: row.pedigree });
      }
      return result;
    },
    [data.families, data.children, byId],
  );

  const generationOf = React.useCallback(
    (person: Person): number | null => {
      if (person.generation !== null) return person.generation;
      const parents = parentsOf(person.id);
      const parentGeneration = parents.father?.generation ?? parents.mother?.generation ?? null;
      return parentGeneration === null ? null : parentGeneration + 1;
    },
    [parentsOf],
  );

  const refreshAll = React.useCallback(async () => {
    // `data.reload` settles 世次 first, then re-reads the graph.
    await data.reload();
    await reloadStore();
  }, [data, reloadStore]);

  async function handleSubmit(input: PersonInput): Promise<void> {
    const current = dialog;
    if (current === null) return;
    if (current.kind === 'edit') {
      await repo.updatePerson(current.person.id, input);
    } else if (current.kind === 'add-parent') {
      await repo.addParent(current.anchor.id, input, current.role);
    } else if (current.kind === 'add-spouse') {
      await repo.addSpouse(current.anchor.id, input);
    } else if (current.kind === 'add-child') {
      await repo.addChild(current.anchor.id, input, 'birth', current.familyId);
    } else {
      const created = await repo.createPerson(input);
      // 第一位成员自动成为根，并记住。
      if (focusId === null) setRoot(created.id);
    }
    setDialog(null);
    await refreshAll();
  }

  async function handlePurge(): Promise<void> {
    const target = deleteTarget;
    if (target === null) return;
    setDeleting(true);
    setError(null);
    try {
      await repo.removePerson(target.id);
      // 根被删掉了：清掉记住的值，让下次启动重新挑一个。
      if (focusId === target.id) {
        setFocusId(null);
        void writeFamilyRoot(null).catch(() => undefined);
      }
      setSelectedId(null);
      setDialog(null);
      await refreshAll();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDeleting(false);
    }
  }

  /** Leave the tree but keep the person: they stay in the birthday / friends list. */
  async function handleDetach(): Promise<void> {
    const target = deleteTarget;
    if (target === null) return;
    setDeleting(true);
    setError(null);
    try {
      await repo.detachPerson(target.id);
      // 根被移出族谱了：同样清掉记住的值。
      if (focusId === target.id) {
        setFocusId(null);
        void writeFamilyRoot(null).catch(() => undefined);
      }
      setSelectedId(null);
      setDialog(null);
      await refreshAll();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDeleting(false);
    }
  }

  const filtered = React.useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (needle === '') return data.persons;
    return data.persons.filter((p) =>
      [p.name, p.courtesy_name ?? '', p.art_name ?? '', p.relation_label ?? '', p.note ?? '']
        .some((value) => value.toLowerCase().includes(needle)),
    );
  }, [data.persons, search]);

  const generations = React.useMemo(() => {
    const buckets = new Map<string, Person[]>();
    for (const person of filtered) {
      const generation = generationOf(person);
      const key = generation === null ? 'unknown' : String(generation);
      const list = buckets.get(key) ?? [];
      list.push(person);
      buckets.set(key, list);
    }
    return [...buckets.entries()]
      .sort(([a], [b]) => (a === 'unknown' ? 1 : b === 'unknown' ? -1 : Number(a) - Number(b)))
      .map(([key, list]) => ({
        key,
        label: key === 'unknown' ? '未分世次' : `第 ${key} 世`,
        items: list.sort((a, b) => (a.ranking ?? '').localeCompare(b.ranking ?? '') || a.name.localeCompare(b.name)),
      }));
  }, [filtered, generationOf]);

  const personDialog =
    dialog !== null && dialog.kind !== 'delete' && dialog.kind !== 'pick' ? dialog : null;
  const pickTarget = dialog !== null && dialog.kind === 'pick' ? dialog : null;
  // What the "pick an existing person" shortcut should open for the current dialog.
  const pickState: DialogState | null =
    personDialog === null ? null
    : personDialog.kind === 'add-parent'
      ? { kind: 'pick', role: personDialog.role === 'father' ? 'parent-father' : 'parent-mother', anchor: personDialog.anchor }
    : personDialog.kind === 'add-spouse'
      ? { kind: 'pick', role: 'spouse', anchor: personDialog.anchor }
    : personDialog.kind === 'add-child'
      ? { kind: 'pick', role: 'child', anchor: personDialog.anchor, familyId: personDialog.familyId }
    : null;
  const deleteTarget = dialog !== null && dialog.kind === 'delete' ? dialog.person : null;
  /** Existing people who could fill the picked role, minus the obvious repeats. */
  const pickCandidates = React.useMemo(() => {
    if (pickTarget === null) return [];
    const anchor = pickTarget.anchor;
    const excluded = new Set<string>([anchor.id]);
    const parents = parentsOf(anchor.id);
    if (pickTarget.role === 'parent-father' && parents.father !== null) excluded.add(parents.father.id);
    if (pickTarget.role === 'parent-mother' && parents.mother !== null) excluded.add(parents.mother.id);
    if (pickTarget.role === 'spouse') for (const entry of spousesOf(anchor.id)) excluded.add(entry.person.id);
    if (pickTarget.role === 'child') for (const entry of childrenOf(anchor.id)) excluded.add(entry.person.id);
    const needle = pickQuery.trim().toLowerCase();
    return data.persons
      .filter((person) => !excluded.has(person.id))
      .filter((person) => needle === ''
        || [person.name, person.relation_label ?? '', person.note ?? ''].some((value) => value.toLowerCase().includes(needle)))
      .slice(0, 60);
  }, [pickTarget, data.persons, parentsOf, spousesOf, childrenOf, pickQuery]);

  async function handlePick(target: Person): Promise<void> {
    const pick = pickTarget;
    if (pick === null) return;
    setPicking(true);
    setError(null);
    try {
      if (pick.role === 'parent-father') await repo.linkParent(pick.anchor.id, target.id, 'father');
      else if (pick.role === 'parent-mother') await repo.linkParent(pick.anchor.id, target.id, 'mother');
      else if (pick.role === 'spouse') await repo.linkSpouse(pick.anchor.id, target.id);
      else await repo.linkExistingChild(pick.anchor.id, target.id, 'birth', pick.familyId);
      setPickQuery('');
      setDialog(null);
      await refreshAll();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPicking(false);
    }
  }


  const selectedParents = selected === undefined ? null : parentsOf(selected.id);

  // Notes linked to the selected person (note.person_id).
  React.useEffect(() => {
    if (selected === undefined) {
      setPersonNotes([]);
      return;
    }
    let cancelled = false;
    void NoteRepository.notesOfPerson(selected.id)
      .then((rows) => { if (!cancelled) setPersonNotes(rows); })
      .catch(() => { if (!cancelled) setPersonNotes([]); });
    return () => { cancelled = true; };
  }, [selected]);
  const selectedSpouses = selected === undefined ? [] : spousesOf(selected.id);
  const selectedChildren = selected === undefined ? [] : childrenOf(selected.id);

  return (
    <div className="ft">
      <div className="list-head">
        <div className="ft-switch">
          <button type="button" className={view === 'tree' ? 'is-active' : ''} onClick={() => setView('tree')}>世系图</button>
          <button type="button" className={view === 'list' ? 'is-active' : ''} onClick={() => setView('list')}>世代列表</button>
        </div>
        <input
          type="search"
          className="search"
          placeholder="搜索姓名 / 字 / 号…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="搜索族谱成员"
        />
        <span className="list-head__count">{filtered.length} 人 · {generations.length} 世</span>
        <button type="button" className="btn" onClick={toggleExpandFemale}>
          女系：{expandFemale ? '已展开' : '不展开'}
        </button>
        <button type="button" className="btn" onClick={() => {
          downloadText('jvs-family.ged', exportGedcom({
            persons: data.persons, families: data.families, children: data.children,
          }));
        }}>导出 GEDCOM</button>
        <button type="button" className="btn btn--add" onClick={() => { setError(null); setDialog({ kind: 'add-member' }); }}>
          ＋ 添加成员
        </button>
      </div>

      {error !== null && <div className="banner banner--bad">{error}</div>}

      {data.loading && <div className="banner">正在读取族谱…</div>}

      {!data.loading && data.persons.length === 0 && (
        <div className="banner">还没有成员。点「＋ 添加成员」建立第一位（建议先添加自己并设为本人）。</div>
      )}

      {!data.loading && data.persons.length > 0 && (
        <div className={`ft-split${selected !== undefined ? ' has-detail' : ''}`}>
          <div className="ft-main">
            {view === 'tree' && focusId !== null && (
              <TreeView
                persons={data.persons}
                families={data.families}
                children={data.children}
                focusId={focusId}
                expandFemale={expandFemale}
                onSelect={(id) => setSelectedId(id)}
              />
            )}
            {view === 'tree' && focusId !== null && (
              <div className="ft-focus">
                以 <select value={focusId} onChange={(e) => setRoot(e.target.value)}>
                  {data.persons.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select> 为根
              </div>
            )}
            {view === 'list' && (
              <div className="ft-gens">
                {generations.map((group) => (
                  <section key={group.key} className="month-group">
                    <header className="month-group__head">
                      <span>{group.label}</span>
                      <span className="month-group__count">{group.items.length} 人</span>
                    </header>
                    <ul className="person-list">
                      {group.items.map((person) => (
                        <li key={person.id} className={selectedId === person.id ? 'is-editing' : ''}>
                          <div>
                            <button type="button" className="ft-name" onClick={() => setSelectedId(person.id)}>
                              {person.name}
                            </button>
                            {person.courtesy_name !== null && <span className="tag">字 {person.courtesy_name}</span>}
                            {person.art_name !== null && <span className="tag">号 {person.art_name}</span>}
                            {person.relation_label !== null && <span className="tag">{person.relation_label}</span>}
                            {person.is_self === 1 && <span className="tag tag--self">本人</span>}
                          </div>
                          <div className="person-list__meta">
                            {personMeta(person)}
                            {person.native_place !== null && ` · ${person.native_place}`}
                            {selectedParents !== null && person.id === selectedId && ' · 选中'}
                          </div>
                          <div className="person-list__actions">
                            <button type="button" className="link link--edit" onClick={() => setDialog({ kind: 'edit', person })}>
                              编辑
                            </button>
                          <button
                            type="button"
                            className="link"
                            onClick={() => { setError(null); setDialog({ kind: 'delete', person }); }}
                          >
                            删除
                          </button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            )}
          </div>

          {selected !== undefined && (
            <aside className="ft-detail">
              <div className="ft-detail__head">
                <strong>{selected.name}</strong>
                <button type="button" className="modal__close" onClick={() => setSelectedId(null)} aria-label="关闭">✕</button>
              </div>
              <dl className="facts">
                <dt>世次</dt><dd>{generationOf(selected) === null ? '—' : `第 ${generationOf(selected)} 世`}</dd>
                {selected.generation_char !== null && <><dt>字辈</dt><dd>{selected.generation_char}</dd></>}
                {selected.courtesy_name !== null && <><dt>字</dt><dd>{selected.courtesy_name}</dd></>}
                {selected.art_name !== null && <><dt>号</dt><dd>{selected.art_name}</dd></>}
                {selected.ranking !== null && <><dt>排行</dt><dd>{selected.ranking}</dd></>}
                {selected.gregorian_local_date !== null && <><dt>生</dt><dd>{selected.gregorian_local_date}</dd></>}
                {selected.death_date !== null && <><dt>卒</dt><dd>{selected.death_date}</dd></>}
                {selected.native_place !== null && <><dt>籍贯</dt><dd>{selected.native_place}</dd></>}
                {selected.burial_place !== null && <><dt>葬处</dt><dd>{selected.burial_place}</dd></>}
              </dl>

              <h4 className="ft-detail__section">父母</h4>
              <ul className="ft-rel">
                <li>父：{selectedParents?.father?.name ?? '—'}
                  {selectedParents?.father === null && (
                    <button type="button" className="link link--edit" onClick={() => setDialog({ kind: 'add-parent', anchor: selected, role: 'father' })}>添加</button>
                  )}
                </li>
                <li>母：{selectedParents?.mother?.name ?? '—'}
                  {selectedParents?.mother === null && (
                    <button type="button" className="link link--edit" onClick={() => setDialog({ kind: 'add-parent', anchor: selected, role: 'mother' })}>添加</button>
                  )}
                </li>
              </ul>

              <h4 className="ft-detail__section">配偶</h4>
              <ul className="ft-rel">
                {selectedSpouses.length === 0 && <li>—</li>}
                {selectedSpouses.map((entry) => (
                  <li key={entry.familyId}>
                    <span>{entry.person.name}</span>
                    <span className="tag">{FAMILY_KIND_LABELS[entry.kind as FamilyKind] ?? entry.kind}</span>
                    <button
                      type="button"
                      className="link link--edit"
                      onClick={() => setDialog({ kind: 'add-child', anchor: selected, familyId: entry.familyId })}
                    >
                      子女
                    </button>
                    <button
                      type="button"
                      className="link"
                      onClick={() => {
                        const family = data.families.find((f) => f.id === entry.familyId);
                        void repo.setDivorced(entry.familyId, family?.divorce_date === null || family?.divorce_date === undefined)
                          .then(refreshAll)
                          .catch((e: Error) => setError(e.message));
                      }}
                    >
                      {data.families.find((f) => f.id === entry.familyId)?.divorce_date === null ? '离异' : '复婚'}
                    </button>
                  </li>
                ))}
              </ul>
              <button type="button" className="btn btn--add ft-detail__add" onClick={() => setDialog({ kind: 'add-spouse', anchor: selected })}>
                ＋ 添加配偶
              </button>

              <h4 className="ft-detail__section">子女</h4>
              <ul className="ft-rel">
                {selectedChildren.length === 0 && <li>—</li>}
                {selectedChildren.map((entry) => (
                  <li key={entry.person.id}>
                    {entry.person.name}
                    <span className="tag">{PEDIGREE_LABELS[entry.pedigree as Pedigree] ?? entry.pedigree}</span>
                  </li>
                ))}
              </ul>
              <button type="button" className="btn btn--add ft-detail__add" onClick={() => setDialog({ kind: 'add-child', anchor: selected })}>
                ＋ 添加子女
              </button>

              <h4 className="ft-detail__section">相关笔记</h4>
              <ul className="ft-rel">
                {personNotes.length === 0 && <li>—</li>}
                {personNotes.map((note) => (
                  <li key={note.id}>
                    <button
                      type="button"
                      className="link"
                      onClick={() => { location.hash = `#/m/notes?note=${encodeURIComponent(note.id)}`; }}
                    >
                      {note.title}
                    </button>
                  </li>
                ))}
              </ul>

              <div className="ft-detail__actions">
                <button type="button" className="primary" onClick={() => setDialog({ kind: 'edit', person: selected })}>编辑资料</button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => setRoot(selected.id)}
                >
                  设为根
                </button>
                <button
                  type="button"
                  className="btn btn--danger"
                  onClick={() => { setError(null); setDialog({ kind: 'delete', person: selected }); }}
                >
                  删除
                </button>
              </div>
            </aside>
          )}
        </div>
      )}

      <PersonForm
        open={personDialog !== null}
        title={
          personDialog === null ? '' :
          personDialog.kind === 'edit' ? `编辑：${personDialog.person.name}` :
          personDialog.kind === 'add-parent' ? (personDialog.role === 'father' ? '添加父亲' : '添加母亲') :
          personDialog.kind === 'add-spouse' ? '添加配偶' :
          personDialog.kind === 'add-child' ? '添加子女' : '添加成员'
        }
        {...(personDialog?.kind === 'edit' ? { initial: personDialog.person } : {})}
        defaultGeneration={
          personDialog?.kind === 'add-child' && personDialog.anchor.generation !== null ? personDialog.anchor.generation + 1 :
          personDialog?.kind === 'add-parent' && personDialog.anchor.generation !== null ? Math.max(1, personDialog.anchor.generation - 1) :
          null
        }
        defaultRelation={
          personDialog?.kind === 'add-parent' ? (personDialog.role === 'father' ? '父亲' : '母亲') :
          personDialog?.kind === 'add-spouse' ? '配偶' :
          personDialog?.kind === 'add-child' ? '子女' : ''
        }
        onCancel={() => setDialog(null)}
        onSubmit={handleSubmit}
        {...(pickState !== null ? { onPickExisting: () => { setError(null); setPickQuery(''); setDialog(pickState); } } : {})}
      />

      <Modal
        open={deleteTarget !== null}
        title={deleteTarget === null ? '' : `从族谱移除：${deleteTarget.name}`}
        onClose={() => { setError(null); setDialog(null); }}
        width={560}
      >
        <div className="form">
          <p className="ft-confirm">请选择范围。两种方式都会<b>保留其子嗣</b>，子嗣继续挂在原家庭下并保留另一位亲长。</p>
          <ul className="scope-list">
            <li>
              <button
                type="button"
                className="scope"
                onClick={() => void handleDetach()}
                disabled={deleting}
              >
                <strong>仅移出族谱</strong>
                <span>
                  解除父子与配偶关系，<b>本人仍留在生日 / 亲友列表</b>中，生日、笔记等资料不受影响。
                </span>
              </button>
            </li>
            <li>
              <button
                type="button"
                className="scope scope--danger"
                onClick={() => void handlePurge()}
                disabled={deleting}
              >
                <strong>彻底删除</strong>
                <span>
                  同时从<b>生日 / 亲友列表</b>中删除，数据库不留副本、不可恢复。
                </span>
              </button>
            </li>
          </ul>
          {error !== null && <div className="banner banner--bad">{error}</div>}
          <div className="form__actions">
            <button type="button" onClick={() => { setError(null); setDialog(null); }} disabled={deleting}>取消</button>
          </div>
        </div>      </Modal>

      <Modal
        open={pickTarget !== null}
        title={
          pickTarget === null ? '' :
          pickTarget.role === 'parent-father' ? `选择父亲：${pickTarget.anchor.name}` :
          pickTarget.role === 'parent-mother' ? `选择母亲：${pickTarget.anchor.name}` :
          pickTarget.role === 'spouse' ? `选择配偶：${pickTarget.anchor.name}` :
          `选择子女：${pickTarget.anchor.name}`
        }
        onClose={() => { setError(null); setPickQuery(''); setDialog(null); }}
        width={520}
      >
        <div className="form">
          <p className="ft-confirm">
            从<b>已有成员</b>中选择（生日模块里的人也在列表中）。关联到同一个人，
            不会再新建一条记录。
          </p>
          <input
            className="search"
            type="search"
            placeholder="搜索姓名 / 关系 / 备注…"
            value={pickQuery}
            onChange={(e) => setPickQuery(e.target.value)}
            aria-label="搜索已有成员"
          />
          {error !== null && <div className="banner banner--bad">{error}</div>}
          <ul className="pick-list">
            {pickCandidates.length === 0 && <li className="card__empty">没有可选的成员</li>}
            {pickCandidates.map((candidate) => (
              <li key={candidate.id}>
                <button type="button" onClick={() => void handlePick(candidate)} disabled={picking}>
                  <strong>{candidate.name}</strong>
                  <span>
                    {candidate.relation_label ?? '—'}
                    {candidate.gregorian_local_date !== null ? ` · ${candidate.gregorian_local_date}` : ''}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <div className="form__actions">
            <button type="button" onClick={() => { setError(null); setPickQuery(''); setDialog(null); }}>取消</button>
          </div>
        </div>
      </Modal>
    </div>
  );
}