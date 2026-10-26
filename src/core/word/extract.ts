/**
 * 从文本里提取「词库里有的英文单词」。
 *
 * 用在「笔记 → 生词集」这条链路上：读完一篇笔记，把它里面出现过的、词库收录
 * 的词挑出来，组成一个私人词集。
 *
 * 只挑词库里有的词，是因为我们要的是「可背的词条」—— 把 is / the / 人名也
 * 当成生词没有意义，而词库本身已经筛过雅思核心词。
 */

/** 一个匹配到的词。 */
export interface ExtractedWord {
  /** 原文里的写法（保持大小写）。 */
  surface: string;
  /** 小写形式，用于词库匹配。 */
  normalized: string;
}

/**
 * 把文本切成候选英文单词。
 *
 * 处理几种常见情况：
 *   - 连字符：`well-known` → `well` + `known`
 *   - 所有格：`Charles'` / `Charles's` → `charles`
 *   - 缩写：`don't` → `don` + `t`
 *
 * @param text - 任意文本。
 * @returns 候选词（可能重复，交给调用方去重）。
 */
export function tokenizeWords(text: string): ExtractedWord[] {
  const out: ExtractedWord[] = [];
  // 先抓出可能带连字符或撇号的片段，再按内部分隔符拆开。
  const pattern = /[A-Za-z][A-Za-z'’-]{1,23}/g;
  const matches = text.match(pattern);
  if (matches === null) return out;

  for (const raw of matches) {
    // 撇号 / 连字符 / 弯引号都当作分隔符：well-known → well, known；don't → don, t
    for (const part of raw.split(/['’\-]+/)) {
      const surface = part.replace(/['’]$/, '');
      const normalized = surface.toLowerCase();
      // 丢掉空片段、单字母（t / s 这类缩写残片）和纯非字母。
      if (normalized.length < 2 || !/^[a-z]+$/.test(normalized)) continue;
      out.push({ surface, normalized });
    }
  }
  return out;
}

/**
 * 在文本里挑出属于词库的词（去重，保持出现顺序）。
 *
 * @param text - 笔记正文等。
 * @param known - 词库里的词，小写的 id 集合。
 * @returns 命中的词条 id，按首次出现顺序。
 */
export function extractKnownWords(text: string, known: Set<string>): string[] {
  const tokens = tokenizeWords(text);
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const token of tokens) {
    if (!known.has(token.normalized)) continue;
    if (seen.has(token.normalized)) continue;
    seen.add(token.normalized);
    ids.push(token.normalized);
  }
  return ids;
}

/**
 * 从 Markdown 里挑词，跳过代码块和链接地址。
 *
 * 代码块里的标识符、URL 里的路径都不是要背的词。
 *
 * @param markdown - 笔记正文。
 * @param known - 词库 id 集合。
 * @returns 命中的词条 id。
 */
export function extractFromMarkdown(markdown: string, known: Set<string>): string[] {
  const withoutCode = markdown
    // 围栏代码块
    .replace(/```[\s\S]*?```/g, ' ')
    // 行内代码
    .replace(/`[^`]*`/g, ' ')
    // 图片和链接的 URL 部分，保留可见文字
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    // 裸 URL
    .replace(/https?:\/\/\S+/g, ' ')
    // HTML 标签
    .replace(/<[^>]+>/g, ' ');
  return extractKnownWords(withoutCode, known);
}
