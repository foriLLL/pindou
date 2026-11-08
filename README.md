# 拼豆图纸生成器 · Pindou

把一张照片（或一句描述）变成可以直接照着摆的**拼豆（熔融豆 / Perler beads）图纸**：AI 先把画面重绘成像素风贴纸，浏览器再把它转换成带真实品牌色号的图纸，支持 1:1 打印。

<p>
  <img src="public/presets/pixel-cute.webp" width="120" alt="像素萌系">
  <img src="public/presets/pixel-line.webp" width="120" alt="线条简笔">
  <img src="public/presets/pixel-rpg.webp" width="120" alt="复古游戏">
  <img src="public/presets/pixel-animal.webp" width="120" alt="变成小动物">
  <img src="public/presets/flat.webp" width="120" alt="扁平卡通">
</p>

## 功能

- **三种入口**：照片转换（上传照片 → AI 按风格重画）、文字创作（不用图片，描述想画的内容）、直接转换（已有的像素图 / 卡通图，不经过 AI）。
- **风格预设 + 可编辑提示词**：像素萌系、线条简笔、复古游戏、变成小动物、扁平卡通，也可以自己写。
- **像素对齐**：识别 AI 画出的像素网格，一个像素对应一颗豆；也可以手动指定尺寸重采样。
- **真实色卡**：MARD 221/291、COCO、漫漫、盼盼、咪小窝、优肯 Artkal、Perler、Hama，CIEDE2000 色差匹配，可限制颜色数。
- **图纸输出**：每格色号、5/10 格粗线、行列坐标、拼板分割线、色号清单与用量；下载 PNG、成品预览、CSV，以及按拼板分页的 **1:1 打印版 PDF**（带校准尺）。
- **手机优先**：点格子高亮同色位置，HEIC 照片可直接上传（服务端用 libheif 转换）。
- **无需注册**：自动分配匿名 ID，作品与图纸参数保存在服务端，扫码即可在多台设备间同步。
- **防滥用**：按 IP 限流、自建工作量证明（不依赖第三方验证码）、每 ID / 每 IP / 全站每日额度。

## 工作原理

```
浏览器 ── 上传图片 / 描述 + 风格 ──► server.mjs ──► OpenAI 兼容的图像接口（/images/edits、/images/generations）
   ▲                                    │  SQLite 记录任务，图片存本地磁盘
   └── 拉取生成图 ◄──────────────────────┘
   pattern.js（浏览器内）：去背景 → 像素网格检测 / 重采样 → 色卡匹配 → 限色 → 清理孤立豆 → 渲染图纸
```

- `server.mjs` + `lib/`：零依赖 Node.js 服务（静态文件、匿名用户、生图任务队列、持久化、防滥用）。
  - `lib/prompts.mjs`：风格预设与固定的「拼豆技术要求」提示词。
  - `lib/store.mjs`：`node:sqlite` 存储用户与作品，图片落盘，原图定期清理，数据库每日快照。
  - `lib/guard.mjs`：真实 IP、令牌桶限流、工作量证明、每日计数。
- `public/`：纯前端，无构建步骤。
  - `pattern.js`：转换引擎（纯函数，浏览器 / Node 通用）。
  - `print.js`：1:1 打印 PDF（浏览器内生成，零依赖）。
  - `pow.js`：工作量证明求解（精简 SHA-256）。
  - `palettes.json`：由 `tools/build-palettes.py` 从 pypindou 色卡数据生成。

### 转换算法要点

1. **先让 AI 把图变“好拼”**：提示词 = 用户可编辑的风格 + 服务端固定附加的技术要求（纯色平涂、少色、清晰描边、无文字、纯白背景）。这一步比任何后处理都有效。
2. **像素网格检测**：对行列边缘强度做傅里叶分析得到像素大小，再把网格线吸附到真实边界（AI 画的像素并不严格等距）；格内深色细节占比够高时保留为深色，避免眼睛、镜框等细线丢失。
3. **非像素图重采样**：每格多点子采样、逐点匹配色卡后取众数，不取平均色，边缘不混色。
4. **不做抖动**：抖动会产生大量棋盘格杂点，手工摆豆很痛苦。
5. **限色与清理**：反复合并“用量 × 与最近色色差”最小的颜色；只替换与周围色差小的孤立豆，保留高光等高对比细节。

## 快速开始

需要 **Node.js ≥ 22.13**（使用内置的 `node:sqlite`），无需 `npm install`。

```bash
cp .env.example .env      # 填入 OPENAI_API_KEY（以及可选的 OPENAI_BASE_URL）
node --disable-warning=ExperimentalWarning server.mjs
# 打开 http://127.0.0.1:8645
```

上传 iPhone 的 HEIC 照片时，Chrome / Firefox 无法在浏览器内解码，服务端会调用 `heif-dec` 转换；如需该功能请安装 libheif（Ubuntu：`apt install libheif-examples libheif-plugin-libde265`）。

只测试转换引擎：

```bash
node tools/try.mjs in.rgba W H out.ppm [长边] [颜色数] [色卡id]
```

## 配置

全部通过环境变量（或项目根目录的 `.env`）设置：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `OPENAI_API_KEY` | — | 必填，图像接口的密钥 |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | 任意 OpenAI 兼容的图像接口地址 |
| `IMAGE_MODELS` | `gpt-image-2.5-flare,gpt-image-2.5-sunburst` | 使用第一个；请改成你的服务商实际支持的图像模型名 |
| `PORT` / `HOST` | `8645` / `127.0.0.1` | 监听地址 |
| `DATA_DIR` | `./data` | 数据库与图片目录 |
| `POW_SECRET` | 启动时随机 | 工作量证明签名密钥，固定后重启不失效 |
| `POW_BITS` | `18` | 工作量证明难度 |
| `USER_DAILY` / `IP_DAILY` / `GLOBAL_DAILY` | `20` / `40` / `200` | 每 ID / 每 IP / 全站每日 AI 生成次数 |
| `USER_FAIL_DAILY` / `IP_FAIL_DAILY` | `10` / `20` | 每 ID / 每 IP 每日失败次数上限（失败不计入生成次数） |
| `MIN_FREE_MB` | `500` | 磁盘剩余低于此值时拒绝新的照片任务 |
| `TRUST_PROXY` | 空 | 额外信任的反向代理地址（逗号分隔）；默认只信任来自 127.0.0.1 / ::1 的 `X-Forwarded-For` |
| `USER_ACTIVE` / `MAX_RUNNING` / `MAX_QUEUE` | `2` / `3` / `20` | 每 ID 进行中任务、全站并发、排队上限 |
| `NEW_USERS_PER_IP` / `CONVERT_PER_IP` | `10` / `30` | 每 IP 每日新建 ID 数、HEIC 转换次数 |
| `SRC_KEEP_DAYS` | `30` | 原图保留天数 |
| `LOG_HEADERS` | 空 | 记录到日志的上游响应头（逗号分隔），便于观察额度 |

### 关于图像接口

- 照片模式调用 `POST /images/edits`，以 **JSON** 发送参考图：`{"model", "prompt", "images": [{"image_url": "data:image/jpeg;base64,..."}], "size", "quality"}`；文字模式调用 `POST /images/generations`。
- 部分 OpenAI 兼容服务的 `/images/edits` 只接受 multipart 表单，接入前请确认，必要时修改 `server.mjs` 的 `callModel`。
- 上游返回 `b64_json` 或 `url` 均可；`url` 只接受 https，大小上限 20MB。

## 部署

推荐放在反向代理（Caddy / Nginx）后面，服务只监听 `127.0.0.1`，由反向代理负责 HTTPS，并把客户端 IP 写入 `X-Forwarded-For`（限流依赖它；只有来自本机的连接才会被信任）。

systemd 示例：

```ini
[Unit]
Description=Pindou web app
After=network-online.target
StartLimitIntervalSec=0

[Service]
DynamicUser=yes
StateDirectory=pindou
Environment=DATA_DIR=/var/lib/pindou
EnvironmentFile=/etc/pindou/env
WorkingDirectory=/opt/pindou
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning /opt/pindou/server.mjs
Restart=always
RestartSec=2
MemoryMax=600M
TasksMax=64
UMask=0077
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes

[Install]
WantedBy=multi-user.target
```

Caddy 示例：

```
pindou.example.com {
    reverse_proxy 127.0.0.1:8645
}
```

## 隐私

- 用户上传的照片和描述会发送给配置的图像接口处理。
- 生成的图片和作品记录保存在 `DATA_DIR`；原图默认 30 天后自动删除。
- 匿名 ID 即访问凭证，持有 ID 的人可以看到该 ID 下的作品。

## 致谢与第三方许可

- 拼豆色卡数据：[HansBug/pypindou](https://github.com/HansBug/pypindou)（Apache-2.0，许可证全文见 `third_party/pypindou-LICENSE.txt`），`tools/pypindou-palettes.json` 为原始数据，`public/palettes.json` 为裁剪结果。
- 二维码生成：[qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator)（MIT，Kazuhiko Arase），位于 `public/vendor/qrcode.js`。
- 风格示例图为 AI 生成，示例中的人物与宠物照片同样由 AI 生成，不涉及真实个人。

## License

[MIT](LICENSE)
