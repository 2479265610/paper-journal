# 纸间 · Paper Journal

> 一个有纸张手感的本地优先日记本。3D 翻页、纸声、封面掀开，支持 HTML / PDF / 照片 / 视频，
> 数据留在你自己手里，通过 WebDAV 在电脑和安卓之间同步。

灵感来自 [Paper](https://www.productcool.com/product/paper-1193) 那类"少即是多"的纸感笔记本。
本项目不依赖任何框架、不依赖任何后端、不依赖任何第三方服务。

---

## 它能做什么

**纸的部分**

- 打开日记本时，封面绕书脊掀起（0.9s 缓动），配一声纸响
- **双页摊开**：左页是上一篇、右页是当前这篇，纸绕中缝翻转
- 翻页四种方式：拖拽跟手 / 滚轮或触控板横滑 / 鼠标拖 / 点书页外侧的「‹ 上一页 / 下一页 ›」
- 翻动过程中纸面有一道扫光、投影随角度加深、翻过去背面的内容自然透出
- 纸张摩擦声由 Web Audio 实时合成，没有一个音频文件
- 书架：竖排书名的封面（内框虚线、四角花草、底部草地摇曳）、书本悬浮呼吸、影子随浮沉缩放
- 三套纸：米白、牛皮、夜墨；可关掉纹理和音效

**日记的部分**

| 能力 | 说明 |
| --- | --- |
| 内容形态 | 文字（富文本）、照片、视频、录音、PDF、**HTML 网页** |
| 阅读 / 书写 | 默认只读；点右上角的笔才进入书写（Ctrl/⌘+E 同效） |
| 页内排版 | 日期 + 星期/天气/字数胶囊、段首缩进、34% 宽表情包环绕正文 |
| 照片 | 放在该篇末尾（等比、点击放大）；没有日期的照片归到「照片墙」整页 |
| 组织 | 书架分本、时间轴、月历、相册、全文搜索 + 标签 |
| 元信息 | 心情、天气、标签、收藏、字数、时间 |
| 统计 | 连续记录天数、有记录的日子在日历上打点 |
| 回顾 | 书架顶部显示「去年今日」 |
| 安全 | 4 位 PIN 锁 |
| 数据 | 回收站（30 天）、JSON / Markdown 导出、自动草稿 |
| 离线 | Service Worker，断网照常用 |
| AI（MCP） | 接入 MCP 客户端后，AI 可直接写/读/搜日记，并按内置写作规则写 |

**导入**

| 类型 | 结果 |
| --- | --- |
| PDF | 每一页渲染成图像，**一页 PDF = 一页日记**，装订成一本新书（带进度条） |
| HTML 网站（可多选） | **原样成书**：文件存进库，Service Worker 提供虚拟文件系统，站内相对链接与动画全部照旧 |
| 单个 HTML | 可选「原样成书」或「转成一篇日记」 |
| Markdown 文件夹 | 读 `YYYY-MM-DD.md` + 图片，**按月自动装订**成「十月」「十一月」；未被引用的照片生成照片墙 |

**同步的部分**

数据默认只在本机 IndexedDB。点「同步」才会上传到你自己的 WebDAV：

```
<你填的目录>/
  manifest.json        索引（单点真相）
  entries/<id>.json    每篇独立文件
  media/<hash>.<ext>   附件，按内容哈希去重
  raw/index.json       网页书总索引
  raw/<书id>/          网页书的清单与文件
```

增量同步：只传变化的条目和缺失的附件；两边同时改过的，**保留冲突副本**而不是覆盖。
网页书按 SHA-256 逐文件比对，缺谁补谁；删除以墓碑跨设备传播（已删的书不会被别的设备同步复活）。

---

## 接入 AI（MCP）

`mcp-server.mjs` 是一个零依赖的 stdio MCP 服务器，暴露 8 个工具：

`get_diary_guide`、`write_diary`、`append_to_diary`、`list_books`、`list_entries`、`read_entry`、`search_diary`、`diary_stats`

客户端配置（WorkBuddy / Claude Desktop / Cursor）：

```json
{
  "mcpServers": {
    "paper-journal": {
      "command": "node",
      "args": ["<仓库路径>/mcp-server.mjs"]
    }
  }
}
```

架构：MCP → 本机 `127.0.0.1:8787/api/op` → 应用内 AI 桥（桌面走 IPC、网页走 SSE）→ IndexedDB。
**纸间需要保持打开**——数据始终在本机，AI 走的是本机通道。
写作规则写在 `diary-style.md`，可直接编辑；`get_diary_guide` 会把当前规则交给 AI。

---

## 四种用法

### 0. Windows 桌面版（exe，数据随软件走）

下载 `PaperJournal-Portable-x.x.x.exe`（Release → `windows`），双击即用，**不需要 Node**。

- **便携模式**：所有数据存在 exe 旁边的 `data/` 文件夹里 —— 拷走「exe + data」= 搬走全部日记
- 打包版内置 WebDAV 直连（主进程 IPC 代发），同样不受跨域限制
- 想要安装版（开始菜单/桌面快捷方式）用 `PaperJournal-Setup-x.x.x.exe`
- 未做代码签名，首次运行若 SmartScreen 拦截：点「更多信息 → 仍要运行」

本地开发调试：`cd desktop && npm install && npm start`（需要 Node）；
打包：`npm run dist`（产物在 `desktop/release/`）。

### 1. 电脑端（网页版）

```bash
node server.mjs        # 需要 Node 18+
```

然后打开 http://localhost:8787 。

Windows 直接双击 `start-windows.bat`。

`server.mjs` 同时干三件事：静态服务、给静态资源注入时间戳版本号（改代码立刻生效）、
**WebDAV 反向代理**（绕过浏览器跨域）。

想让它像个独立软件：在 Chrome / Edge 里打开后点地址栏右侧的「安装」——
会得到一个独立窗口、有自己图标、没有地址栏的桌面应用。手机上同理「添加到主屏幕」。

### 3. 安卓端（APK）

仓库自带 GitHub Actions，**云端打包，本地不需要 JDK / Android SDK**。

推到 `main` 后自动构建，产物在：

- Actions 页面 → 最新一次 run → Artifacts → `paper-journal-apk`
- 或 Releases → `latest` → `paper-journal.apk`

装好后：设置里填 WebDAV，安卓版走**原生通道**（OkHttp 代发请求），完全不受 CORS 限制，不需要代理。

也支持直接装网页版：手机浏览器打开你的部署地址 → 菜单 → 添加到主屏幕。### 4. GitHub Pages（在线版）

推送 `main` 后自动部署（`.github/workflows/pages.yml`）。
在仓库 Settings → Pages 里把 Source 选成 GitHub Actions 即可。

---

## WebDAV 怎么填

支持坚果云、Nextcloud、群晖、Alist、InfiniCLOUD 等任何标准 WebDAV。

| 字段 | 示例 |
| --- | --- |
| 服务器地址 | `https://dav.jianguoyun.com/dav/纸间/` |
| 账号 | 你的邮箱 / 用户名 |
| 应用密码 | **专用应用密码**，不是你登录密码 |

**关于跨域**：浏览器直连第三方 WebDAV 会被 CORS 拦住（尤其 `PROPFIND` / `MKCOL` 会触发预检）。
三条路，任选其一：

1. 电脑端用 `node server.mjs`，代理地址填 `http://127.0.0.1:8787/dav?url=`（最省事）
2. 安卓 APK —— 自带原生通道，不用管
3. 自建 WebDAV（Nextcloud / Alist）时在服务端放开 CORS

---

## 目录结构

```
paper-journal/
├── index.html              单页应用
├── css/paper.css           纸张视觉 + 双页跨页 + 三套主题
├── js/
│   ├── util.js             工具、富文本消毒、弹层
│   ├── audio.js            纸声合成（Web Audio）
│   ├── store.js            IndexedDB（条目 / 媒体 / 网页书文件 / 设置）
│   ├── flip.js             3D 翻页引擎（中缝翻转 / 弹簧 / 拖拽 / 扫光）
│   ├── sync.js             WebDAV 增量同步（含网页书）+ 原生桥
│   ├── import.js           导入：PDF → 成书、HTML → 原样书、Markdown 文件夹 → 按月装订
│   ├── aibridge.js         AI 桥（MCP 操作在本机的执行端）
│   └── app.js              视图路由、读写模式、附件、锁屏
├── mcp-server.mjs          零依赖 stdio MCP 服务器（8 个工具）
├── diary-style.md          日记写作规则（可编辑，MCP 会交给 AI）
├── server.mjs              零依赖静态服务 + WebDAV 代理 + AI 桥 SSE
├── sw.js                   离线缓存 + 网页书虚拟文件系统（/raw/…）
├── desktop/                Electron 桌面壳（便携数据、AI 桥、文件夹导入 IPC）
├── android/                原生 WebView 壳（Gradle）
├── tools/
│   ├── gen-icons.mjs       手写 PNG 编码生成全套图标
│   ├── pre-build.mjs       桌面版打包预处理（生成图标 + 复制网页资源）
│   ├── make-sample-pdf.mjs 生成自检用样例 PDF
│   ├── test-mcp.mjs        MCP 端到端测试
│   └── selftest.js         页面自检（?selftest=1）
└── .github/workflows/      云端构建 exe / APK / 部署 Pages
```

---

## 一些实现上的取舍

**为什么不用现成的翻页库**（`page-flip` / `turn.js`）？
它们把页面渲染到 canvas 上做扭曲，代价是页面里的视频、iframe、可编辑正文全部失去交互。
日记的每一页必须是活的 DOM，所以翻页自己写：`rotateY` + 动态光影 + rAF 驱动，
拖拽时跟手、松手按速度决定翻不翻、不到阈值回弹。

**为什么每篇日记是独立文件**？
一个几 MB 的聚合 JSON 在手机上同步容易半路失败，重传整个库。
拆成 `entries/<id>.json` 后，改一篇只传一篇；附件按内容哈希命名，两端天然去重。

**冲突怎么办**？
两边 `updatedAt` 相差 400ms 以内且内容不同，判定为并发修改：
保留较新的一份，另一份另存为「冲突副本」新条目。不静默丢数据。

---

## 开发

```bash
node server.mjs                # 起服务
# 打开 http://localhost:8787/?selftest=1   看运行时自检结果（会打在服务端控制台）
# 打开 http://localhost:8787/?reset=1      清空 Service Worker 与缓存
node tools/gen-icons.mjs       # 重新生成图标（含 Android mipmap）
```

安卓工程单独构建：

```bash
cd android
gradle assembleRelease
# 产物：app/build/outputs/apk/release/app-release.apk
```

`app/build.gradle` 里的 `syncWebAssets` 任务会把根目录的网页自动拷进 `assets/www`，
所以改完前端直接重新打包即可，不需要手动复制。

---

## 边界

- 加密只做了 PIN 锁（挡手滑，不是密码学意义上的加密）。真要藏东西，把 WebDAV 目录放在加密盘上。
- PDF 在移动端 WebView 里依赖系统查看器，部分机型可能提示下载而非内嵌预览。
- WebDAV 没有实现 `ETag` 乐观锁，极端并发下靠冲突副本兜底，不是强一致。
- 附件不进 JSON 导出（只导出文字结构），完整备份请用 WebDAV 目录。

## License

MIT
