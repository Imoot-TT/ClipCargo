# ClipCargo 发布清单

## 发布前

1. 更新 `package.json`、`extension/manifest.json`、`src-tauri/tauri.conf.json` 和 `src-tauri/Cargo.toml` 的同一版本号。
2. 运行 `npm run check:release`、`npm run check` 和 `npm run package:store-extension`。
3. 确认源码、扩展包、安装包、许可证清单和第三方声明均来自同一提交。
4. 运行一次打包程序启动检查；再验证收集、下载、取消、失败恢复、媒体处理和扩展桥接主流程。

## 推送和发布

```powershell
git status --short
git add -A
git commit -m "release: ClipCargo vX.Y.Z"
git push origin main
git tag vX.Y.Z
git push origin vX.Y.Z
```

推送版本标签后，GitHub Actions 会在 Windows runner 上构建安装包和商店扩展，并在 GitHub Release 中附加 `SHA256SUMS.txt`。发布完成后检查安装包名称、版本、扩展包和校验值是否一致。

## 发布后

- 打开 GitHub Release 下载页，确认资产可以下载。
- 在一台没有组件缓存的 Windows 机器上验证首次启动、组件安装和扩展连接。
- 保留构建提交、标签和发布资产的对应关系；不要覆盖已发布版本。
