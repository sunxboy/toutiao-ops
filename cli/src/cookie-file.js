/**
 * Netscape HTTP Cookie File 解析与加载。
 *
 * 支持浏览器插件（如 EditThisCookie / Get cookies.txt）或 curl 导出的
 * Netscape 格式登录态文件，用于 `auth login --cookies <文件>` 导入头条登录态。
 *
 * Netscape 格式（每行 7 个 Tab 分隔字段）：
 *   domain  include-subdomains  path  secure  expires  name  value
 *
 * 本模块是纯函数，不依赖 Playwright，可独立测试。
 */
import { readFileSync } from 'fs';

/** 能证明已登录头条的会话 Cookie 名（至少要命中一个）。 */
export const SESSION_COOKIE_NAMES = [
  'sessionid',
  'sessionid_ss',
  'sid_tt',
  'uid_tt',
  'uid_tt_ss',
  'sso_uid_tt',
  'toutiao_sso_user',
];

const TOUTIAO_SUFFIX = 'toutiao.com';
const MAX_WARNINGS = 50;

/**
 * 判断一个 Cookie 域名是否属于头条（toutiao.com 及其子域）。
 */
function isToutiaoDomain(domain) {
  const d = domain.startsWith('.') ? domain.slice(1) : domain;
  return d === TOUTIAO_SUFFIX || d.endsWith(`.${TOUTIAO_SUFFIX}`);
}

/**
 * 解析 Netscape 格式 Cookie 文本，返回 Playwright 可用的 Cookie 数组。
 *
 * @param {string} text Cookie 文件全文
 * @param {object} [opts]
 * @param {number} [opts.now] 当前 Unix 时间戳（秒），默认 Date.now()/1000，用于过期判断；测试可注入
 * @returns {{ cookies: object[], stats: object, warnings: string[] }}
 */
export function parseNetscapeCookies(text, opts = {}) {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const cookies = [];
  const warnings = [];
  const stats = { total: 0, loaded: 0, expired: 0, nonToutiao: 0, malformed: 0 };

  const pushWarning = (msg) => {
    if (warnings.length < MAX_WARNINGS) warnings.push(msg);
  };

  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim()) continue;
    // 注释行跳过；#HttpOnly_ 开头的是数据行（curl 对 HttpOnly Cookie 的标记）。
    if (line.startsWith('#') && !line.startsWith('#HttpOnly_')) continue;

    stats.total += 1;
    const lineNo = stats.total;

    // Netscape 标准用 Tab 分隔；容忍空格分隔的导出。
    let fields = line.split('\t');
    if (fields.length < 7) {
      fields = line.trim().split(/\s+/);
      // 空格分隔时 value 本身含空格会被切开，把多余部分拼回 value。
      if (fields.length > 7) fields = [...fields.slice(0, 6), fields.slice(6).join(' ')];
    }
    if (fields.length < 7) {
      stats.malformed += 1;
      pushWarning(`第 ${lineNo} 行字段不足（需要 7 个字段），已跳过`);
      continue;
    }

    let [domain, , path, secure, expiresRaw, name, value] = fields;
    let httpOnly = false;
    if (domain.startsWith('#HttpOnly_')) {
      httpOnly = true;
      domain = domain.slice('#HttpOnly_'.length);
    }
    domain = domain.trim();
    path = (path || '/').trim() || '/';
    name = (name || '').trim();
    value = value ?? '';

    if (!domain || !name) {
      stats.malformed += 1;
      pushWarning(`第 ${lineNo} 行域名或 Cookie 名为空，已跳过`);
      continue;
    }
    if (!isToutiaoDomain(domain)) {
      stats.nonToutiao += 1;
      pushWarning(`第 ${lineNo} 行域名 ${domain} 不是头条域名，已跳过`);
      continue;
    }

    const expires = parseInt(expiresRaw, 10);
    if (Number.isNaN(expires)) {
      stats.malformed += 1;
      pushWarning(`第 ${lineNo} 行（${name}）过期时间不是数字，已跳过`);
      continue;
    }
    // expires 为 0 表示会话 Cookie；过期 Cookie 不导入（Playwright 会拒绝）。
    if (expires !== 0 && expires < now) {
      stats.expired += 1;
      pushWarning(`第 ${lineNo} 行（${name}）已过期，已跳过`);
      continue;
    }

    const cookie = {
      name,
      value,
      domain,
      path,
      secure: String(secure).trim().toUpperCase() === 'TRUE',
    };
    if (httpOnly) cookie.httpOnly = true;
    if (expires !== 0) cookie.expires = expires;
    cookies.push(cookie);
    stats.loaded += 1;
  }

  const omitted = stats.expired + stats.nonToutiao + stats.malformed - warnings.length;
  if (omitted > 0) pushWarning(`另有 ${omitted} 条跳过原因未逐条列出`);

  return { cookies, stats, warnings };
}

/**
 * 读取并校验 Netscape Cookie 文件。
 *
 * @param {string} filePath Cookie 文件路径
 * @returns {{ cookies: object[], stats: object, warnings: string[] }}
 * @throws 文件不存在 / 格式不是 Netscape / 没有可用 Cookie / 缺少会话 Cookie 时抛出带说明的错误
 */
export function loadCookieFile(filePath) {
  let text;
  try {
    text = readFileSync(filePath, 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error(`Cookie 文件不存在：${filePath}`);
    throw new Error(`读取 Cookie 文件失败（${filePath}）：${err.message}`);
  }

  const trimmed = text.trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    throw new Error(
      '该文件是 JSON 格式，不是 Netscape 格式。请用浏览器插件导出为 Netscape HTTP Cookie File ' +
      '格式（通常为 cookies.txt），或用 curl -c 导出的文件，再重新导入。'
    );
  }

  const result = parseNetscapeCookies(text);
  const { cookies, stats } = result;

  if (cookies.length === 0) {
    throw new Error(
      `Cookie 文件中没有可用的头条 Cookie（共 ${stats.total} 行：` +
      `过期 ${stats.expired} 个，非头条域名 ${stats.nonToutiao} 个，格式错误 ${stats.malformed} 个）。` +
      '请确认导出的文件包含 toutiao.com 域下的 Cookie 且未过期。'
    );
  }

  const names = new Set(cookies.map((c) => c.name));
  const hasSession = SESSION_COOKIE_NAMES.some((n) => names.has(n));
  if (!hasSession) {
    throw new Error(
      'Cookie 文件缺少头条登录会话 Cookie（需要至少包含以下之一：' +
      `${SESSION_COOKIE_NAMES.join('、')}）。请确认已在浏览器中登录头条号后，再导出 mp.toutiao.com / toutiao.com 的 Cookie。`
    );
  }

  return result;
}
