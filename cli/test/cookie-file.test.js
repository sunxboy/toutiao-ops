/**
 * cookie-file.js 单元测试（纯函数，无需浏览器 / Playwright）。
 * 运行：npm test（或在 cli/ 目录下执行 node --test）
 * 注意：测试用 Cookie 值均为虚构值，切勿填入真实登录态。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseNetscapeCookies, loadCookieFile } from '../src/cookie-file.js';

const NOW = 1795000000; // 固定“当前时间”，让过期判断可复现
const FUTURE = 1893456000; // 2030 年
const PAST = 1000000000; // 2001 年

function netscapeLine(domain, path, secure, expires, name, value) {
  return [domain, 'TRUE', path, secure ? 'TRUE' : 'FALSE', String(expires), name, value].join('\t');
}

describe('parseNetscapeCookies', () => {
  it('解析标准 Netscape 文件：跳过注释/空行，保留会话 Cookie', () => {
    const text = [
      '# Netscape HTTP Cookie File',
      '# https://curl.haxx.se/rfc/cookie_spec.html',
      '',
      netscapeLine('.toutiao.com', '/', true, FUTURE, 'sessionid', 'fake-session-id'),
      netscapeLine('mp.toutiao.com', '/', true, 0, 'csrf_session_id', 'fake-csrf'),
      netscapeLine('.toutiao.com', '/', false, FUTURE, 'uid_tt', 'fake-uid'),
    ].join('\n');

    const { cookies, stats, warnings } = parseNetscapeCookies(text, { now: NOW });
    assert.equal(stats.total, 3);
    assert.equal(stats.loaded, 3);
    assert.deepEqual(warnings, []);
    assert.equal(cookies[0].name, 'sessionid');
    assert.equal(cookies[0].secure, true);
    assert.equal(cookies[0].expires, FUTURE);
    assert.equal(cookies[0].domain, '.toutiao.com');
    // 会话 Cookie（expires 为 0）不带 expires 字段
    assert.equal(cookies[1].name, 'csrf_session_id');
    assert.equal('expires' in cookies[1], false);
    assert.equal(cookies[2].secure, false);
  });

  it('识别 #HttpOnly_ 前缀', () => {
    const text = netscapeLine('#HttpOnly_.toutiao.com', '/', true, FUTURE, 'sessionid_ss', 'fake-ss');
    const { cookies } = parseNetscapeCookies(text, { now: NOW });
    assert.equal(cookies.length, 1);
    assert.equal(cookies[0].domain, '.toutiao.com');
    assert.equal(cookies[0].httpOnly, true);
  });

  it('跳过过期 Cookie、非头条域名、格式错误行，并分别计数', () => {
    const text = [
      netscapeLine('.toutiao.com', '/', true, PAST, 'sessionid', 'expired-value'),
      netscapeLine('.example.com', '/', true, FUTURE, 'sid', 'other-site'),
      '只有三个字段\tTRUE\t/',
      netscapeLine('.toutiao.com', '/', true, 'not-a-number', 'bad_expires', 'x'),
      netscapeLine('.toutiao.com', '/', true, FUTURE, 'sessionid', 'good-value'),
    ].join('\n');

    const { cookies, stats, warnings } = parseNetscapeCookies(text, { now: NOW });
    assert.equal(stats.total, 5);
    assert.equal(stats.expired, 1);
    assert.equal(stats.nonToutiao, 1);
    assert.equal(stats.malformed, 2);
    assert.equal(stats.loaded, 1);
    assert.equal(cookies[0].value, 'good-value');
    assert.equal(warnings.length, 4);
  });

  it('接受空格分隔的导出（容忍非标准格式）', () => {
    const text = '.toutiao.com TRUE / TRUE 1893456000 sessionid fake-value';
    const { cookies, stats } = parseNetscapeCookies(text, { now: NOW });
    assert.equal(stats.loaded, 1);
    assert.equal(cookies[0].name, 'sessionid');
  });

  it('不解码 Cookie 值（含 % 编码原样保留）', () => {
    const text = netscapeLine('.toutiao.com', '/', false, FUTURE, 'sid_guard', 'abc%7C123%7Cdef');
    const { cookies } = parseNetscapeCookies(text, { now: NOW });
    assert.equal(cookies[0].value, 'abc%7C123%7Cdef');
  });

  it('只认 toutiao.com 及其子域，不认相似域名', () => {
    const text = [
      netscapeLine('.toutiao.com.evil.com', '/', true, FUTURE, 'sessionid', 'x'),
      netscapeLine('mp.toutiao.com', '/', true, FUTURE, 'sessionid', 'ok'),
    ].join('\n');
    const { cookies, stats } = parseNetscapeCookies(text, { now: NOW });
    assert.equal(stats.nonToutiao, 1);
    assert.equal(stats.loaded, 1);
    assert.equal(cookies[0].domain, 'mp.toutiao.com');
  });
});

describe('loadCookieFile', () => {
  const dir = mkdtempSync(join(tmpdir(), 'toutiao-cookie-test-'));
  const writeTmp = (name, content) => {
    const p = join(dir, name);
    writeFileSync(p, content);
    return p;
  };

  it('文件不存在时报错', () => {
    assert.throws(() => loadCookieFile(join(dir, 'no-such-file.txt')), /Cookie 文件不存在/);
  });

  it('JSON 文件报错并提示导出 Netscape 格式', () => {
    const p = writeTmp('cookies.json', '[{"name": "sessionid"}]');
    assert.throws(() => loadCookieFile(p), /JSON 格式/);
  });

  it('没有可用头条 Cookie 时报错', () => {
    const p = writeTmp('empty.txt', '# Netscape HTTP Cookie File\n.example.com\tTRUE\t/\tFALSE\t1893456000\tsid\tx\n');
    assert.throws(() => loadCookieFile(p), /没有可用的头条 Cookie/);
  });

  it('缺少会话 Cookie 时报错', () => {
    const p = writeTmp('no-session.txt', netscapeLine('.toutiao.com', '/', false, FUTURE, '_ga', 'GA1.1.fake') + '\n');
    assert.throws(() => loadCookieFile(p), /缺少头条登录会话 Cookie/);
  });

  it('合法文件正常加载', () => {
    const p = writeTmp(
      'ok.txt',
      [
        '# Netscape HTTP Cookie File',
        netscapeLine('.toutiao.com', '/', true, FUTURE, 'sessionid', 'fake-session'),
        netscapeLine('.toutiao.com', '/', false, FUTURE, 'uid_tt', 'fake-uid'),
      ].join('\n')
    );
    const { cookies, stats } = loadCookieFile(p);
    assert.equal(stats.loaded, 2);
    assert.equal(cookies[0].name, 'sessionid');
  });

  // 清理临时目录
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
});
