# Light-PS 接入说明

更新时间：2026-09-20

当前版本的通信核心是一个版本化命令协议。它不暴露 Fabric 对象，也不允许外部脚本直接操作 Canvas；接入方读取工程快照、提交带 `expectedRevision` 的操作，并通过导出接口取得图片或工程包。

## 1. 浏览器内 Agent：直接调用页面 API

当 Agent 能控制打开 Light-PS 的浏览器页面时，直接使用 `window.__LIGHT_PS__`。典型的浏览器 Agent 会把下面的代码放进页面 evaluate/API 调用中：

```js
await window.__LIGHT_PS__.ready;

const capabilities = window.__LIGHT_PS__.capabilities();
const state = window.__LIGHT_PS__.getState();
const layer = state.document.layers.at(-1);

if (layer) {
  await window.__LIGHT_PS__.request({
    id: crypto.randomUUID(),
    method: 'transaction.apply',
    params: {
      expectedRevision: state.revision,
      operations: [{
        type: 'layer.patch',
        id: layer.id,
        patch: { x: 240, y: 180, rotation: 5 }
      }]
    }
  });
}
```

导入图片时，把 `ArrayBuffer` 作为二进制参数传入：

```js
const bytes = await (await fetch('/assets/reference.png')).arrayBuffer();
const state = window.__LIGHT_PS__.getState();

const result = await window.__LIGHT_PS__.request({
  id: crypto.randomUUID(),
  method: 'layers.import',
  params: {
    expectedRevision: state.revision,
    bytes,
    type: 'image/png',
    name: 'reference.png'
  }
});
```

导出结果也是二进制：

```js
const result = await window.__LIGHT_PS__.request({
  id: crypto.randomUUID(),
  method: 'export.composite',
  params: { type: 'image/png' }
});

const file = new Blob([result.bytes], { type: result.type });
```

当前方法包括：

| 方法 | 用途 | 是否需要 `expectedRevision` |
|---|---|---:|
| `capabilities` | 查询协议、格式和限制 | 否 |
| `document.get` | 读取当前工程与 revision | 否 |
| `transaction.apply` | 批量修改图层、笔画、选区/裁切等 | 是 |
| `layers.import` | 导入图片图层 | 是 |
| `history.undo` / `history.redo` | 撤销与重做 | 是 |
| `export.composite` | 导出合成图 | 否 |
| `export.mask` | 导出严格黑白 Mask | 否 |
| `export.project` | 导出 `.lightps` 工程包 | 否 |

写入前必须重新读取 `document.get()`。如果 revision 已改变，服务会返回冲突，Agent 应重新读取后决定是否重试。相同 `id` 的请求可以安全重试；同一 `id` 换了参数会被拒绝。

## 2. 其他画布工具：iframe 宿主通信

如果节点画布允许嵌入 iframe，宿主页面加载 Light-PS 后发起握手：

```js
const LIGHT_PS_ORIGIN = 'http://127.0.0.1:5176';
const iframe = document.querySelector('#light-ps');
let port;
const pending = new Map();

window.addEventListener('message', event => {
  if (event.source !== iframe.contentWindow) return;
  if (event.origin !== LIGHT_PS_ORIGIN) return;
  if (event.data?.type !== 'lightps:connected') return;

  port = event.ports[0];
  port.onmessage = message => {
    if (message.data?.type === 'document.changed') {
      // 重新调用 document.get()，按 revision 更新节点状态
      return;
    }
    const callback = pending.get(message.data?.id);
    if (!callback) return;
    pending.delete(message.data.id);
    message.data.ok
      ? callback.resolve(message.data.result)
      : callback.reject(message.data.error);
  };
  port.start();
});

iframe.contentWindow.postMessage(
  { type: 'lightps:connect', version: 1 },
  LIGHT_PS_ORIGIN
);
```

Light-PS 会显示“允许连接当前工程？”的用户确认。用户允许后，宿主收到 `MessagePort`，之后的请求格式与同页 API 一致：

```js
function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    pending.set(id, { resolve, reject });
    port.postMessage({ id, method, params });
  });
}

const state = await call('document.get');
const result = await call('export.composite', { type: 'image/png' });
```

生产宿主必须使用明确的 `targetOrigin`，并校验 `event.source` 与 `event.origin`。不能用 `*` 接收任意页面的连接。

## 3. 节点画布如何映射

对 TapNow、LightAI 或其他节点画布，适配器只需要负责四件事：

1. 把节点输入图片转为 `layers.import` 的二进制素材。
2. 保存宿主侧的 `documentId`、任务 ID 和 Light-PS revision。
3. 监听 `document.changed`，用户点击完成后调用 `export.composite`、`export.mask` 或 `export.project`。
4. 把产物写回下游节点，并携带来源 revision，避免旧结果覆盖新编辑。

如果画布支持 iframe，使用上面的 MessageChannel；如果只支持自定义节点，则节点需要打开 Light-PS 页面并通过宿主自己的任务回调传递输入/输出。专用节点和 Figma 插件目前还没有写入本项目，不能仅凭通用 API 宣称已经完成。

## 4. 终端、Python 或云端 Agent

当前版本还没有本地 HTTP、WebSocket、CLI 或 `fs.watch` 守护进程，因此 Python/Node Agent 不能直接对一个独立浏览器页面发请求。现阶段有两个现实选择：

- Agent 同时具备浏览器控制能力，使用第 1 节的页面 API。
- 一个已有的宿主进程嵌入 iframe，使用第 2 节的消息桥接，再由宿主把请求转给 Agent。

后续如果要支持终端 Agent，建议增加一个很薄的本地 connector：负责 HTTP/WebSocket 或 stdio、任务身份、二进制传输和断线重连；所有业务命令仍转成同一套 `request`，不在 connector 里复制编辑器状态。云端 Agent 不能直接访问用户的 localhost，需要由用户侧宿主或授权中继转发。

## 5. 与早期 PRD 的差异

早期 PRD 中的 `isCompleted()`、`exportData()`、本地 `fs.watch` 和 `status.json` 尚未作为当前 API 发布。当前实现采用更适合多宿主通信的方式：

- 用 `revision` 表示工程版本，而不是全局完成布尔值。
- 用独立导出方法返回合成图、Mask 或工程包。
- 用 `document.changed` 事件通知变化，宿主再读取最新快照。
- 把本地目录工作区作为后续 connector，而不是让浏览器页面直接假设可以访问文件系统。
