import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
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

const BASE = `https://cdn.jsdelivr.net/gh/${OWNER}/${REPO}@${BRANCH}/`;
const API = `https://api.github.com/repos/${OWNER}/${REPO}/contents/`;

let cached = null;
let cachedAt = 0;

async function listStickers() {
  if (cached && Date.now() - cachedAt < 5 * 60_000) {
    return cached;
  }

  const r = await fetch(API, {
    headers: {
      "User-Agent": "lili-sticker-sender",
      "Accept": "application/vnd.github+json"
    }
  });

  if (!r.ok) {
    throw new Error(`GitHub listing failed: ${r.status}`);
  }

  const items = await r.json();

  cached = items
    .filter(
      x =>
        x.type === "file" &&
        /\.(png|jpe?g|gif|webp)$/i.test(x.name)
    )
    .map(x => ({
      name: x.name,
      url: BASE + encodeURIComponent(x.name)
    }));

  cachedAt = Date.now();

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

  const terms = q.split(/\s+/).filter(Boolean);

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
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{
  margin:0;
  font-family:system-ui,-apple-system,sans-serif
}
.wrap{
  padding:10px
}
.card{
  border:1px solid #e5e7eb;
  border-radius:16px;
  padding:10px;
  background:#fff
}
img{
  display:block;
  max-width:100%;
  max-height:360px;
  width:auto;
  height:auto;
  margin:auto;
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

      window.removeEventListener("message", listener);

      if (m.error) {
        reject(new Error(m.error.message || "MCP error"));
        return;
      }

      resolve(m.result);
    }

    window.addEventListener("message", listener);
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

  card.append(img, name);
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

  if (m.method === "ui/notifications/tool-result") {
    handleToolResult(m.params);
  }

  if (m.method === "ui/notifications/tool-cancelled") {
    root.innerHTML =
      '<div class="error">已取消</div>';
  }
});

async function init() {
  try {
    await sendRequest("ui/initialize", {
      appCapabilities: {
        availableDisplayModes: ["inline"]
      },
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
    version: "0.1.0"
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
      "Search LiLi's personal sticker library by filename or phrase. Use this before rendering when the requested sticker is not an exact filename.",
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
        resourceUri: UI_URI
      }
    }
  },
  async ({ query }) => {
      const all = await listStickers();

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
        "Render one sticker inside ChatGPT. Pass the exact filename returned by search_stickers. Use this after search_stickers when the user wants to see/send a sticker.",
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
      const all = await listStickers();

      const sticker = all.find(
        x => x.name === name
      );

      if (!sticker) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `找不到：${name}`
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

  return server;
}

/*
 * Legacy SSE transports.
 *
 * Each SSE connection gets its own transport/session.
 */
const sseTransports = new Map();

/*
 * HTTP server
 */
const http = createServer(async (req, res) => {
  const url = new URL(
    req.url || "/",
    `http://${req.headers.host || "localhost"}`
  );

  /*
   * Health check
   */
  if (
    req.method === "GET" &&
    url.pathname === "/health"
  ) {
    res.writeHead(200, {
      "content-type": "text/plain; charset=utf-8"
    });

    res.end("ok");
    return;
  }

  /*
   * Modern Streamable HTTP MCP
   *
   * https://.mcp
   */
  if (url.pathname === "/mcp") {
    res.setHeader(
      "Access-Control-Allow-Origin",
      "*"
    );

    res.setHeader(
      "Access-Control-Allow-Methods",
      "POST, GET, DELETE, OPTIONS"
    );

    res.setHeader(
      "Access-Control-Allow-Headers",
      "content-type, mcp-session-id, mcp-protocol-version"
    );

    res.setHeader(
      "Access-Control-Expose-Headers",
      "Mcp-Session-Id"
    );

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const server = makeServer();

    const transport =
      new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true
      });

    res.on("close", () => {
      transport.close();
      server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error(
        "MCP request error:",
        error
      );

      if (!res.headersSent) {
        res.writeHead(500, {
          "content-type":
            "text/plain; charset=utf-8"
        });

        res.end("Internal server error");
      }
    }

    return;
  }

  /*
   * Legacy SSE MCP
   *
   * https://.sse
   */
  if (
    req.method === "GET" &&
    url.pathname === "/sse"
  ) {
    const server = makeServer();

    const transport =
      new SSEServerTransport(
        "/messages",
        res
      );

    sseTransports.set(
      transport.sessionId,
      {
        transport,
        server
      }
    );

    res.on("close", () => {
      sseTransports.delete(
        transport.sessionId
      );

      server.close();
    });

    try {
      await server.connect(transport);
    } catch (error) {
      console.error(
        "SSE connection error:",
        error
      );

      sseTransports.delete(
        transport.sessionId
      );

      if (!res.headersSent) {
        res.writeHead(500, {
          "content-type":
            "text/plain; charset=utf-8"
        });

        res.end("SSE connection failed");
      }
    }

    return;
  }

  /*
   * Legacy SSE message endpoint
   *
   * https://.messages?sessionId=...
   */
  if (
    req.method === "POST" &&
    url.pathname === "/messages"
  ) {
    const sessionId =
      url.searchParams.get("sessionId");

    if (!sessionId) {
      res.writeHead(400, {
        "content-type":
          "text/plain; charset=utf-8"
      });

      res.end("Missing sessionId");
      return;
    }

    const entry =
      sseTransports.get(sessionId);

    if (!entry) {
      res.writeHead(400, {
        "content-type":
          "text/plain; charset=utf-8"
      });

      res.end(
        "No transport found for sessionId"
      );

      return;
    }

    try {
      await entry.transport.handlePostMessage(
        req,
        res
      );
    } catch (error) {
      console.error(
        "SSE message error:",
        error
      );

      if (!res.headersSent) {
        res.writeHead(500, {
          "content-type":
            "text/plain; charset=utf-8"
        });

        res.end(
          "SSE message handling failed"
        );
      }
    }

    return;
  }

  /*
   * Not found
   */
  res.writeHead(404, {
    "content-type":
      "text/plain; charset=utf-8"
  });

  res.end("Not found");
});

http.listen(PORT, () => {
  console.log(
    `LiLi Sticker Sender listening on :${PORT}`
  );
});
