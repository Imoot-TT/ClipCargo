# ClipCargo 浏览器扩展

该扩展会在受支持网站的视频卡片和播放区域左上角显示 ClipCargo 浮标。点击浮标可以选择项目，并把对应视频页面发送到 ClipCargo 收集箱。浏览器工具栏弹窗和右键菜单仍作为备用入口。

扩展不会读取浏览历史，也不会自行下载视频；只有用户点击某个浮标、弹窗按钮或右键菜单后，才会发送该页面链接。

若桌面端暂未运行，请求会以原始 `requestId` 暂存在扩展本地存储中；浏览器下次启动或后续成功发送时自动重试。收到桌面 ACK 后才删除，避免重复或丢失。

本地测试扩展使用固定开发 ID `dpogajmenckmdbpacaoilnhhdcjpbheb`；Chrome Web Store 草稿的正式 ID 为 `maenmnckhgckmkcaijmpeghkcfhchiha`。ClipCargo 桌面端发布构建同时登记两者的 Native Messaging 连接，不需要用户复制 ID 或运行脚本。

## 当前版本的安装边界

仓库中的扩展是本地测试包，不是 Chrome Web Store 已签名版本。Windows 上关闭开发者模式后，Chrome 会按安全规则停用这种“加载已解压的扩展”；这不是 ClipCargo 收集逻辑故障。

正式使用需要把 ZIP 包上传到 Chrome Web Store，用户从商店安装；企业环境也可以由管理员通过 Chrome 企业策略部署。当前 ZIP 包可用 `npm run package:extension` 生成到 `reports/package/`，但本地 ZIP/CRX 不能替代商店签名安装。

已注册 Chrome Web Store 开发者账号时，请使用 [CHROME_WEB_STORE_LISTING.md](CHROME_WEB_STORE_LISTING.md) 中的上架资料，并先把 [PRIVACY_POLICY.md](PRIVACY_POLICY.md) 发布到一个公开 HTTPS 地址。上传后确认商店扩展 ID 为 `maenmnckhgckmkcaijmpeghkcfhchiha`，然后从商店安装一次并在 ClipCargo 设置页检测连接。

### 测试版安装步骤

1. 在 ClipCargo 设置中点击“安装测试扩展”，软件会打开已经准备好的扩展文件夹。
2. 在 Chrome 或 Edge 扩展管理页开启开发者模式，选择“加载已解压的扩展程序”。
3. 选择刚打开的文件夹，并确认 ClipCargo 扩展处于开启状态。
4. 保持开发者模式开启，返回 ClipCargo 点击“检测连接”；打开受支持的视频网站后，视频区域会出现 ClipCargo 浮标。

关闭开发者模式会停用本地测试扩展；要继续使用，请从 Chrome Web Store 安装正式版。

受支持的网站：YouTube、小红书、抖音、TikTok、Bilibili、X/Twitter。页面动态加载的新视频卡片也会自动获得浮标。
