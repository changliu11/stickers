import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE
} from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";

const PORT = Number(process.env.PORT || 8787);

const OWNER = "changliu11";
const REPO = "stickers";
const BRANCH = "main";

const BASE =
  `https://cdn.jsdelivr.net/gh/${OWNER}/${REPO}@${BRANCH}/`;

const FILE_API =
  `https://data.jsdelivr.com/v1/package/gh/${OWNER}/${REPO}@${BRANCH}`;

let cached = [];
let cachedAt = 0;

const IMAGE_RE = /\.(png|jpe?g|gif|webp)$/i;

function makeSticker(name) {
  return {
    name,
    url: BASE + encodeURIComponent(name)
  };
}

function collectFiles(node, result = []) {
  if (!Array.isArray(node)) return result;

  for (const item of node) {
    if (!item || typeof item !== "object") continue;

    if (item.type === "file" && IMAGE_RE.test(item.name || "")) {
      result.push(item.name);
    }

    if (Array.isArray(item.files)) {
      collectFiles(item.files, result);
    }
  }

  return result;
}

async function refreshStickers() {
  const r = await fetch(FILE_API, {
    headers: {
      "User-Agent": "lili-sticker-sender"
    }
  });

  if (!r.ok) {
    throw new Error(`jsDelivr file listing failed: ${r.status}`);
  }

  const data = await r.json();

  const names = collectFiles(data.files)
    .filter(name => !name.includes("/"))
    .sort((a, b) => a.localeCompare(b));

  cached = names.map(makeSticker);
  cachedAt = Date.now();

  return cached;
}

function listStickers() {
  return cached;
}

function score(name, query) {
  const n = name.toLowerCase();
  const q = query.toLowerCase().trim();

  if (!q) return 0;

  if (
    n === q ||
    n.replace(/\.[^.]+$/, "") === q
  ) {
    return 100;
  }

  if (n.includes(q)) {
    return 80;
  }

  const terms = q
    .split(/\s+/)
    .filter(Boolean);

  return terms.reduce(
    (s, t) => s + (n.includes(t) ? 15 : 0),
    0
  );
}

const UI_URI = "ui://lili-sticker/v1.html";

const widgetHtml = `
<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta
  name="viewport"
  content="width=device-width,initial-scale=1"
>
<style>
body{
  margin:0;
  font-family:system-ui,-apple-system,sans-serif
}
.wrap{
  padding:10px
}
.card{
  border:none;
  border-radius:16px;
  padding:4px;
  background:transparent
}
img{
  display:block;
  max-width:120px;
  max-height:120px;
  width:auto;
  height:auto;
  margin:0;
  border-radius:12px
}
.name{
  font-size:12px;
  color:#6b7280;
  text-align:center;
  margin-top:7px;
  word-break:break-all
}
.error{
  padding:12px;
  color:#6b7280;
  font-size:13px;
  text-align:center
}
</style>
</head>

<body>

<div id="root">
  <div class="error">加载中…</div>
</div>

<script>
const root = document.getElementById("root");
let requestId = 1;

function sendRequest(method, params) {
  const id = requestId++;

  window.parent.postMessage({
    jsonrpc: "2.0",
    id,
    method,
    params
  }, "*");

  return new Promise((resolve, reject) => {
    function listener(event) {
      const m = event.data;

      if (!m || m.id !== id) return;

      window.removeEventListener(
        "message",
        listener
      );

      if (m.error) {
        reject(
          new Error(
            m.error.message || "MCP error"
          )
        );
        return;
      }

      resolve(m.result);
    }

    window.addEventListener(
      "message",
      listener
    );
  });
}

function sendNotification(method, params) {
  window.parent.postMessage({
    jsonrpc: "2.0",
    method,
    params
  }, "*");
}

function render(data) {
  const s = data?.sticker;

  if (!s?.url) {
    root.innerHTML =
      '<div class="error">没有收到表情图片</div>';
    return;
  }

  root.innerHTML = "";

  const wrap = document.createElement("div");
  wrap.className = "wrap";

  const card = document.createElement("div");
  card.className = "card";

  const img = document.createElement("img");

  img.src = s.url;
  img.alt = s.name || "";

  img.onerror = () => {
    root.innerHTML =
      '<div class="error">图片加载失败</div>';
  };

  const name = document.createElement("div");
  name.className = "name";
  name.textContent = s.name || "";

  card.append(img);
  wrap.append(card);
  root.append(wrap);
}

function handleToolResult(params) {
  if (params?.isError) {
    root.innerHTML =
      '<div class="error">表情工具执行失败</div>';
    return;
  }

  let data = params?.structuredContent;

  if (!data && params?.content) {
    for (const item of params.content) {
      if (
        item?.type === "text" &&
        typeof item.text === "string"
      ) {
        try {
          const parsed = JSON.parse(item.text);

          if (parsed?.sticker) {
            data = parsed;
            break;
          }
        } catch {}
      }
    }
  }

  render(data);
}

window.addEventListener("message", event => {
  const m = event.data;

  if (!m || m.jsonrpc !== "2.0") return;

  if (
    m.method ===
    "ui/notifications/tool-result"
  ) {
    handleToolResult(m.params);
  }

  if (
    m.method ===
    "ui/notifications/tool-cancelled"
  ) {
    root.innerHTML =
      '<div class="error">已取消</div>';
  }
});

async function init() {
  try {
    await sendRequest("ui/initialize", {
      protocolVersion: "2026-01-26",
      appCapabilities: {},
      appInfo: {
        name: "LiLi Sticker",
        version: "1.0.0"
      }
    });

    sendNotification(
      "ui/notifications/initialized",
      {}
    );
  } catch (err) {
    root.innerHTML =
      '<div class="error">UI 初始化失败</div>';
  }
}

init();
</script>

</body>
</html>
`;

function makeServer() {
  const server = new McpServer({
    name: "LiLi Sticker Sender",
    version: "0.2.0"
  });

  registerAppResource(
    server,
    "lili-sticker",
    UI_URI,
    {},
    async () => ({
      contents: [
        {
          uri: UI_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: widgetHtml,
          _meta: {
            ui: {
              prefersBorder: false,
              csp: {
                connectDomains: [],
                resourceDomains: [
                  "https://cdn.jsdelivr.net",
                  "https://raw.githubusercontent.com"
                ]
              }
            }
          }
        }
      ]
    })
  );

  registerAppTool(
    server,
    "search_stickers",
    {
      title: "Search stickers",
      description:
        "Search LiLi's personal sticker library by filename or phrase. Uses the cached sticker list and does not contact GitHub during normal searches.",
      inputSchema: {
        query: z.string().min(1)
      },
      outputSchema: {
        stickers: z.array(
          z.object({
            name: z.string(),
            url: z.string()
          })
        )
      },
      _meta: {
        ui: {
          visibility: ["model"]
        }
      }
    },
    async ({ query }) => {
      const all = listStickers();

      if (!all.length) {
        return {
          structuredContent: {
            stickers: []
          },
          content: [
            {
              type: "text",
              text:
                "表情列表还没有加载，请先刷新表情列表。"
            }
          ]
        };
      }

      const hits = all
        .map(s => ({
          ...s,
          score: score(s.name, query)
        }))
        .filter(x => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 8)
        .map(({ name, url }) => ({
          name,
          url
        }));

      return {
        structuredContent: {
          stickers: hits
        },
        content: [
          {
            type: "text",
            text: hits.length
              ? hits.map(x => x.name).join("、")
              : "没有找到匹配的表情包。"
          }
        ]
      };
    }
  );

  registerAppTool(
    server,
    "render_sticker",
    {
      title: "Render sticker",
      description:
        "Render one sticker inside ChatGPT. Pass the exact filename returned by search_stickers.",
      inputSchema: {
        name: z.string().min(1)
      },
      outputSchema: {
        sticker: z.object({
          name: z.string(),
          url: z.string()
        })
      },
      _meta: {
        ui: {
          resourceUri: UI_URI
        }
      }
    },
    async ({ name }) => {
      const all = listStickers();

      const sticker = all.find(
        x => x.name === name
      );

      if (!sticker) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `找不到：${name}，请先刷新表情列表。`
            }
          ]
        };
      }

      return {
        structuredContent: {
          sticker
        },
        content: [
          {
            type: "text",
            text: `已渲染 ${name}`
          }
        ]
      };
    }
  );

  registerAppTool(
  server,
  "refresh_stickers",
  {
    title: "Refresh stickers",
    description:
      "Refresh the cached sticker filename list when new stickers have been uploaded.",
    inputSchema: {},
    outputSchema: {
      count: z.number(),
      stickers: z.array(z.string())
    },
    _meta: {
      ui: {
        visibility: ["model"]
      }
    }
  },
  async () => {
    try {
      const stickers = await refreshStickers();

      return {
        structuredContent: {
          count: stickers.length,
          stickers: stickers.map(x => x.name)
        },
        content: [
          {
            type: "text",
            text:
              "表情列表已刷新，共 " +
              stickers.length +
              " 个表情。"
          }
        ]
      };
    } catch (err) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text:
              "刷新失败：" +
              (err?.message || String(err))
          }
        ]
      };
    }
  }
);
  
    return server;
}

const http = createServer(
  async (req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, {
        "content-type": "text/plain"
      });
      res.end("ok");
      return;
    }

    if (req.url?.startsWith("/mcp")) {
      const server = makeServer();

      const transport =
        new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined
        });

      await server.connect(transport);
      await transport.handleRequest(
        req,
        res
      );
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  }
);

http.listen(
  PORT,
  () =>
    console.log(
      `LiLi Sticker Sender listening on :${PORT}`
    )
);
