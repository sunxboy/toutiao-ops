# 登录与会话管理

## 概述

头条号登录通过浏览器持久化上下文实现，支持多账号管理。每个账号的会话独立保存在 `~/.toutiao-ops/accounts/<账号名>/` 下，互不影响。

## 多账号

所有命令通过全局 `--account <name>` 参数指定账号，省略时使用 `default`。

```bash
# 操作默认账号
toutiao-ops auth check

# 操作指定账号
toutiao-ops --account work auth check
toutiao-ops --account personal auth login
```

数据目录结构：

```
~/.toutiao-ops/accounts/
├── default/
│   ├── browser-data/    # 浏览器会话
│   ├── screenshots/     # 二维码截图
│   └── meta.json        # 账号元信息（昵称、头像、上次登录时间）
├── work/
│   ├── browser-data/
│   ├── screenshots/
│   └── meta.json
└── ...
```

## 命令

### 检测登录状态

```bash
toutiao-ops [--account <name>] auth check
```

输出示例（已登录）：

```json
{
  "logged_in": true,
  "account": "default",
  "username": "番茄3580433091797615",
  "avatar": "https://sf3-cdn-tos.toutiaostatic.com/img/...",
  "userId": "3580433091797615",
  "profileUrl": "https://www.toutiao.com/c/user/3580433091797615/",
  "url": "https://mp.toutiao.com/profile_v4/index"
}
```

输出示例（未登录）：

```json
{ "logged_in": false, "account": "default", "message": "未登录，请执行 auth login 扫码登录" }
```

### 扫码登录

```bash
toutiao-ops [--account <name>] auth login
```

登录流程分两阶段输出：

**阶段一：等待扫码（stdout 输出 JSON）**

```json
{
  "status": "waiting_for_scan",
  "account": "default",
  "message": "请使用今日头条 APP 扫描二维码登录",
  "qr_screenshot": "/Users/xxx/.toutiao-ops/accounts/default/screenshots/qrcode-xxx.png",
  "attempt": 1,
  "max_attempts": 6
}
```

**收到此输出后，必须立刻将 `qr_screenshot` 路径指向的图片发送/展示给用户，并提示用户打开今日头条 APP 扫码登录。** 二维码有效期约 60 秒，过期后自动刷新并输出新截图路径。

**阶段二：登录结果（stdout 输出 JSON）**

```json
{
  "logged_in": true,
  "account": "default",
  "message": "登录成功，会话已保存",
  "username": "番茄3580433091797615",
  "avatar": "https://sf3-cdn-tos.toutiaostatic.com/img/...",
  "userId": "3580433091797615"
}
```

登录成功后会自动保存账号元信息（昵称、头像、登录时间）到 `meta.json`。

### Cookie 文件登录

已在浏览器中登录头条号时，可导出登录态（Cookie 文件）直接导入，无需扫码，适合无显示器环境。

```bash
toutiao-ops [--account <name>] auth login --cookies <Cookie 文件路径>
```

**导出 Cookie 文件**：在已登录头条号的浏览器中，用 `Get cookies.txt LOCALLY` / `EditThisCookie` 等插件导出 `mp.toutiao.com` 或 `toutiao.com` 的 Cookie，选择 **Netscape HTTP Cookie File** 格式（通常为 `cookies.txt`）。文件格式示例（每行 7 个 Tab 分隔字段）：

```
# Netscape HTTP Cookie File
.toutiao.com	TRUE	/	TRUE	1799394583	sessionid	example-session-id
mp.toutiao.com	FALSE	/	TRUE	0	csrf_session_id	example-csrf-token
```

**导入流程**：CLI 解析文件后清空该账号旧 Cookie，导入新 Cookie，再打开头条号后台验证登录状态，成功后保存会话，后续命令直接复用，无需再次导入。

成功输出示例：

```json
{
  "logged_in": true,
  "account": "default",
  "message": "Cookie 登录成功，会话已保存",
  "cookie_file": "/path/to/cookies.txt",
  "cookies_loaded": 34,
  "cookies_skipped": { "expired": 0, "non_toutiao": 2, "malformed": 0 },
  "warnings": [],
  "username": "番茄3580433091797615",
  "userId": "3580433091797615"
}
```

**解析规则**：

- 只导入 `toutiao.com` 及其子域的 Cookie，其他域名自动跳过
- 过期的 Cookie 自动跳过（Playwright 会拒绝过期 Cookie）
- `expires` 为 0 的会话 Cookie 正常导入
- 支持 `#HttpOnly_` 前缀（curl 导出的 HttpOnly Cookie 标记）
- 文件中至少要包含一个会话 Cookie（`sessionid` / `sid_tt` / `uid_tt` / `sso_uid_tt` / `toutiao_sso_user` 等），否则报错
- JSON 格式的 Cookie 导出暂不支持，会报错提示改导 Netscape 格式

**常见失败**：

| 现象 | 原因与处理 |
|------|-----------|
| `Cookie 文件缺少头条登录会话 Cookie` | 导出时浏览器未登录头条号，或只导出了部分域名；确认登录后重新导出 `toutiao.com` 全站 Cookie |
| `Cookie 登录失败：导入后仍在登录页` | Cookie 已过期或不完整；在浏览器中确认仍处于登录状态后重新导出 |
| `该文件是 JSON 格式` | 插件导出时选错格式，改选 Netscape HTTP Cookie File 格式 |

**安全提示**：Cookie 文件等同于账号密码，可直接登录你的头条号。请勿发送给他人、勿提交到 Git（仓库 `.gitignore` 已忽略 `cookies.txt` / `*.cookies.txt`），用完可删除本地文件——登录态已保存在浏览器会话中，删除文件不影响已登录的账号。

### 退出登录

```bash
toutiao-ops [--account <name>] auth logout
```

清除指定账号的浏览器缓存、截图和元信息。

```json
{
  "success": true,
  "account": "work",
  "message": "已清除账号 [work] 的登录缓存",
  "cleared": ["work"]
}
```

### 列出所有账号

```bash
toutiao-ops auth list
```

```json
{
  "accounts": [
    { "account": "default", "has_session": true, "username": "番茄xxx", "lastLogin": "2026-03-31T..." },
    { "account": "work", "has_session": true, "username": "工作号", "lastLogin": "2026-03-31T..." }
  ],
  "count": 2
}
```

## Agent 调用规范

1. 执行 `auth login` 后监听 stdout
2. 解析到 `status: "waiting_for_scan"` 的 JSON 行时，**读取 `qr_screenshot` 图片并发送给用户**，附带提示："请使用今日头条 APP 扫描二维码登录"
3. 如果收到 `attempt > 1` 的输出，说明二维码已刷新，需再次将新截图发送给用户
4. 解析到 `logged_in: true` 时，登录完成
5. 如果命令以非零退出码结束，说明登录超时（5 分钟内未完成扫码）
6. 操作多账号时，始终在命令中带上 `--account <name>`

## 注意事项

- 任何其他操作前，都应先调用 `auth check` 确认登录状态
- 如果未登录，执行 `auth login` 并将二维码截图展示给用户；或在已有浏览器登录态时用 `auth login --cookies <文件>` 导入登录
- `auth login --cookies` 会清空该账号旧 Cookie 后再导入，导入成功即完成登录，无需扫码
- 切换账号：直接用 `--account <新账号名>` 即可，无需先 logout
- 彻底删除某账号：`--account <name> auth logout`
- 不要对同一个账号同时运行多个命令（会争抢浏览器上下文锁文件）
- 不同账号的命令可以并行运行
- 二维码有效期约 60 秒，CLI 会自动刷新，每次刷新都会输出新截图路径
