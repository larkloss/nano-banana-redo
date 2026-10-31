# 部署到云端（免费，带密码）

用 Cloudflare 的免费 Workers 托管，不用买任何服务，也不用绑卡。

- 打开网址先要输密码，没密码的人连页面都看不到。
- prompt、各项设置、参考照片在所有设备间自动同步，三个页面（生成、局部重绘、视频）都算。
- **API key 不会上传**：每台设备第一次打开时在设置里填一次，只存在那台设备的浏览器里。
- 双击本地 `nano-banana.html` 的用法不受影响，照旧可用。

## 一次性设置（约 10 分钟，全在浏览器里完成）

1. **注册 Cloudflare**：打开 <https://dash.cloudflare.com/sign-up>，用邮箱注册免费账号。
2. **从 GitHub 导入这个仓库**：左侧菜单 **Workers & Pages** → **Create application** →
   **Import a repository**（第一次会让你授权 Cloudflare 访问 GitHub）→ 选 `nano-banana-redo`。
   - 分支：选放着最新代码的分支（`main`，或者还没合并时选 `claude/jolly-ride-8g2e2e`）。
   - 项目名保持 `nano-banana-studio`（要和仓库里 `wrangler.jsonc` 的 `name` 一致）。
   - Build command 留空；Deploy command 保持默认的 `npx wrangler deploy`。
   - 点 **Deploy**，等它跑完。
   - 推送到其他分支时 Cloudflare 会顺便做一个「预览」版本，它没有密码，只会显示「Not set up yet」，不用管。
     不想要的话：Settings → Build → 关掉 Preview builds。
3. **设置密码**：进入刚建好的 `nano-banana-studio` → **Settings** → **Variables and Secrets** →
   **Add** → Type 选 **Secret**，Name 填 `APP_PASSWORD`，Value 填你的密码 → **Deploy**。
   - 至少 8 位，建议 12 位以上。没设密码之前，网页只会显示「Not set up yet」，什么都不给看。
4. **打开网址**：Worker 页面上有地址，形如 `https://nano-banana-studio.<你的子域>.workers.dev`。输入密码进入。
   三个页面的地址（建议各存一个书签）：
   - 生成：`https://nano-banana-studio.<你的子域>.workers.dev/`
   - 局部重绘：`…workers.dev/edit`
   - 视频：`…workers.dev/video`
5. **把现有的 prompt 搬上去**：设置面板最上面的「☁️ Cloud sync」→ **Import a saved file…** →
   选你之前「Save as…」存的那个 `.json` 文件。页面会刷新，里面的 prompt 和设置就都在云端了。
6. 在「🔑 API keys」里填好 key（每台新设备填一次）。

以后往这个分支推送代码，Cloudflare 会自动重新部署，云端数据不受影响。

## 日常使用

- **换设备**：打开同一个网址，输密码，prompt 和设置都在。只需要再填一次 API key。
- **两台设备都开着**：切回某台设备的页面时，如果另一台改过东西，顶部会提示刷新。
  两边改了同一处，会问你保留哪一边，不会悄悄覆盖。
- **断网或者关得太快**：还没传上去的修改会记在这台设备上，下次打开时自动补传。
- **登录被拒「Too many wrong tries」**：15 分钟内密码错太多次会暂时锁住登录，等 15 分钟即可。
  已经登录的设备不受影响。
- **退出登录**：设置里的「Sign out」。登录状态保持 30 天。
- **改密码**：在 Cloudflare 里改 `APP_PASSWORD`，所有设备都会被登出，用新密码重新登录。
- **备份**：「Download backup」下载一份 `.json`，随时可以再导入。
- **不会同步的**：生成出来的图片（和以前一样只在当前页面里，记得下载）和 API key。

## 免费额度（个人用远远够）

| 项目 | 免费额度 |
| --- | --- |
| 请求次数 | 每天 10 万次 |
| 同步数据存储 | 5 GB |
| 单张参考照片 | 超过 8 MB 的会自动压成 JPEG 再同步（本机保留原图） |

## 不想用网页导入？也可以在电脑上用命令行部署

```sh
npx wrangler login
npx wrangler deploy
npx wrangler secret put APP_PASSWORD
```
