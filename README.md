# dsh-draft-saver · 草稿保险箱

> 输入框里**打了字还没发**，切去别的会话看一眼回来，字就没了——这个插件专门治它。

## 它解决的是什么问题

DSH 的输入草稿是**按会话 ID**存在浏览器里的（键名 `dsh.conversation.<会话ID>`）。而点「新会话」时：

1. DSH 会**新建一个空白会话**（不会复用你上一次那个新会话）；
2. **空白会话不出现在侧栏**，所以你切走以后就没有入口再回到它。

结果就是：你刚敲的那段字其实还躺在浏览器里（挂在那个旧会话名下），但界面把门藏了，看起来就是"没了"。桌面版和 Web 版是同一套前端逻辑，**两个都有这个毛病**。

## 它怎么做的

在 `localStorage` 上加一层守卫，只做两件事：

| 时机 | 动作 |
|---|---|
| 任何草稿被写入（非重放） | 原样镜像一份到全局备份键 `dsh-draft-saver.backup.v1`，它就是"最新的那份草稿" |
| 任何会话读草稿 | 只要和"最新的那份"不一样，就把最新那份交出去 |

交出去之后，DSH 用它**自己原本的恢复路径**把草稿放回输入框——不碰编辑器，所以中文输入法、`@文件` 引用胶囊的行为跟官方路径完全一致。

同时输入框上方会浮出一条提示：

> 已恢复上次未发送的草稿（128 字）　[复制] [清空] [知道了]

**[复制]** 把输入框里**当前**的草稿整段复制到剪贴板（不是恢复时那份，你改过之后复制的是改过后的）。复制成功按钮会变成「已复制」；提示条本身 20 秒后退场，你点任意按钮会重新计时。

**发不发、留不留，由你决定。** 你一旦把它发出去或清空，共享的那份草稿就变成"空"，各处都不会再冒出旧内容。

**一份草稿，所有输入框共用。** 你在任何一个会话的输入框里改动（增加、删减都算），最新的**全量内容**会跟着你走到你接着点开的任何会话——新会话、旧会话都一样。

**清空也同步。** 点[清空]或手动删光之后，共享的那份草稿就是"空"，所以**别的会话点开也是空白**；你随后在任何一个会话里重新打字，它又会同步到各处。

**更旧的副本不会"诈尸"。** 打开一个已有草稿的会话时，DSH 会把那份草稿**原样写回存储一遍**。插件能识别这种"读出来又写回去"的重放（比较草稿文本），不把它当成新内容——否则你去翻一眼旧会话，它手里那份旧文本就会把最新内容顶掉（v0.1.0 的真实 bug，已由 `test/draft.test.mjs` 的回归测试钉住）。

## 怎么装

插件与 profile 无关（宿主半边是空的，全在浏览器半边），但**要装在你在用的那个 profile 里**。

### Web 版（127.0.0.1:3080）

在 Web 版里新开一个会话，对 AI 说一句：

> 把 dsh-draft-saver 这个插件装到当前 profile（它在 `dsh-plugins` 目录下）

AI 会用 `plugin_manager` 的 `install_bundle` 装上（会弹一次授权）。宿主半边立即生效，**浏览器半边刷新一次页面即可**。

### 桌面版（Electron 应用）

桌面版 profile **不能用命令行装**——`dsh plugin --profile desktop ...` 会被 CLI 直接拒绝：

```
error: profile "desktop" is managed exclusively by the Electron application
```

只能在**桌面版应用内的会话**里让 AI 用 `plugin_manager` 装（同样是上面那句），装完刷新界面。

### 另一台机器（Linux / macOS）从 GitHub 装

先把仓库拉下来：

```bash
git clone https://github.com/LianbinZhou/dsh-draft-saver.git
```

然后**在那个 profile 的会话里**把路径告诉 AI：

> 把 /你放它的路径/dsh-draft-saver 装到当前 profile

（该 profile 允许命令行的话，也可以直接：`dsh plugin --profile <profile名> add /你放它的路径/dsh-draft-saver`。
注意 `desktop` 这个 profile 例外——它只能由桌面版应用自己管理。）

⚠️ 装完**刷新浏览器页面**（Ctrl+F5 / Cmd+Shift+R）才生效——插件的实现全在浏览器那一半。

## 怎么验证它真的在工作

1. 随便开一个新会话，输入框里打几个字（**别发**）；
2. 切到另一个旧会话（或直接再点一次「新会话」）；
3. 如果出现「已恢复上次未发送的草稿」提示条，且输入框里就是刚才那段字 —— 成功。

想确认备份本身，可以在浏览器按 F12 → Console 输入：

```js
localStorage.getItem('dsh-draft-saver.backup.v1')
```

## 边界（提前说清楚）

- **只保一份**：备份槽里永远是"最近一次未发送的草稿"，不做历史版本。
- **发送或清空即作废**：这是设计如此——备份的存在意义就是"你还没决定怎么处理它"。
- **同一浏览器 profile 内共享**：两个标签页看到的是同一份备份。
- 浏览器的**隐私模式、清空站点数据**会把备份一起清掉，这层保护救不了。
- 插件**不负责把旧会话找回来**（磁盘上那个空白会话仍在，只是侧栏不给入口），它保的是**内容**：换到新会话，内容跟着你走。
- 一切存储访问都包在 try/catch 里：配额满、隐私模式只会让守卫失效，**不会影响输入框正常工作**。

## 文件清单

| 文件 | 作用 |
|---|---|
| `index.js` | 宿主半边（空壳，只为让 bundle 有一行插件条目） |
| `client.js` | 浏览器半边：存储守卫 + 恢复提示条 |
| `cordis.patch.yml` | bundle 的 patch 入口（插入 `draft-saver` 一行） |
| `locale/zh.json`、`locale/en.json` | 插件列表里显示的描述文案 |
| `test/draft.test.mjs` | 用假 `localStorage` 驱动真实 `client.js` 的测试 |

## 测试

```powershell
node test/draft.test.mjs
```

覆盖：镜像写入、清空即作废、新会话继承、同会话不自我注入、字符串/空白/垃圾数据、卸载后原型还原。

## 原理出处（改之前先看）

- 草稿的持久化键与写入时机在 `@deepseek-ai/dsh-client-ui-conversation`（`CONVERSATION_STORE_KEY = "dsh.conversation"`，按 sessionId 作 scopeKey）与 `@deepseek-ai/dsh-client-store`（整值 JSON 写 `localStorage`）里。
- 「新会话不复用空白会话」的逻辑在 `@deepseek-ai/dsh-client-ui-workspace` 的 `startSession()`：它调用 `openWorkspaceSession(target, undefined, false)`，第三个参数 `reuse = false`。

## License

MIT © 2026 Lianbin Zhou
