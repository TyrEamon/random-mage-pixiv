type ImageRow = {
  id: number;
  illust_id: number;
  page_index: number;
  ext: string;
  width: number | null;
  height: number | null;
  orientation: number | null;
  pixels: number | null;
  x_restrict: number | null;
  ai_type: number | null;
  illust_type: number | null;
  bookmark_count: number | null;
  view_count: number | null;
  comment_count: number | null;
  user_id: number | null;
  user_name: string | null;
  title: string | null;
  created_at_pixiv: string | null;
  original_url: string | null;
  random_key: number;
};

type Candidate = { row: ImageRow; shard: D1Database };

const MAX_LIMIT = 200;
const SHARD_NAMES = ["DB_00", "DB_01", "DB_02", "DB_03", "DB_04", "DB_05", "DB_06", "DB_07"] as const;

function requestId(): string {
  return `req_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

function json(data: unknown, status = 200, id = requestId()): Response {
  return Response.json(data, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-request-id": id,
    },
  });
}

function error(code: string, message: string, status = 400): Response {
  const id = requestId();
  return json({ ok: false, code, message, request_id: id }, status, id);
}

function shards(env: Env): D1Database[] {
  return SHARD_NAMES.slice(0, Number.parseInt(env.SHARD_COUNT, 10)).map((name) => env[name]);
}

function intParam(params: URLSearchParams, name: string, fallback = 0): number {
  const raw = params.get(name);
  if (raw === null || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`Unsupported ${name}`);
  return Number.parseInt(raw, 10);
}

function enumParam(params: URLSearchParams, name: string, allowed: ReadonlySet<string>, fallback: string): string {
  const value = (params.get(name) ?? fallback).trim().toLowerCase();
  if (!allowed.has(value)) throw new Error(`Unsupported ${name}`);
  return value;
}

async function randomUnit(seed: string | null): Promise<number> {
  if (seed) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed));
    return new DataView(digest).getUint32(0, false) / 0x1_0000_0000;
  }
  const values = new Uint32Array(1);
  crypto.getRandomValues(values);
  return values[0] / 0x1_0000_0000;
}

function parseTagGroups(params: URLSearchParams, name: string): string[][] {
  return params.getAll(name)
    .map((group) => [...new Set(group.split("|").map((tag) => tag.trim()).filter(Boolean))])
    .filter((group) => group.length > 0)
    .slice(0, 20);
}

function buildFilters(params: URLSearchParams): { sql: string; values: Array<string | number> } {
  const clauses = ["i.enabled = 1"];
  const values: Array<string | number> = [];
  const r18 = intParam(params, "r18", 0);
  if (![0, 1, 2].includes(r18)) throw new Error("Unsupported r18");
  if (r18 !== 2) {
    clauses.push("i.x_restrict = ?");
    values.push(r18);
  }

  const aiType = enumParam(params, "ai_type", new Set(["any", "0", "1"]), "any");
  if (aiType !== "any") {
    clauses.push("i.ai_type = ?");
    values.push(Number.parseInt(aiType, 10));
  }

  const illustType = enumParam(params, "illust_type", new Set(["any", "illust", "illustration", "manga", "ugoira", "0", "1", "2"]), "any");
  const illustTypes: Record<string, number> = { illust: 0, illustration: 0, manga: 1, ugoira: 2, "0": 0, "1": 1, "2": 2 };
  if (illustType !== "any") {
    clauses.push("i.illust_type = ?");
    values.push(illustTypes[illustType]);
  }

  const orientation = enumParam(params, "orientation", new Set(["any", "portrait", "landscape", "square"]), "any");
  const orientations: Record<string, number> = { portrait: 1, landscape: 2, square: 3 };
  if (orientation !== "any") {
    clauses.push("i.orientation = ?");
    values.push(orientations[orientation]);
  }

  const numericFilters: Array<[string, string]> = [
    ["min_width", "width"], ["min_height", "height"], ["min_pixels", "pixels"],
    ["min_bookmarks", "bookmark_count"], ["min_views", "view_count"], ["min_comments", "comment_count"],
  ];
  for (const [param, column] of numericFilters) {
    const value = intParam(params, param, 0);
    if (value > 0) {
      clauses.push(`COALESCE(i.${column}, 0) >= ?`);
      values.push(value);
    }
  }

  for (const [param, column] of [["user_id", "user_id"], ["illust_id", "illust_id"]] as const) {
    const value = intParam(params, param, 0);
    if (value > 0) {
      clauses.push(`i.${column} = ?`);
      values.push(value);
    }
  }

  for (const group of parseTagGroups(params, "included_tags")) {
    clauses.push(`EXISTS (SELECT 1 FROM image_tags it WHERE it.image_id = i.id AND it.tag IN (${group.map(() => "?").join(",")}))`);
    values.push(...group);
  }
  for (const group of parseTagGroups(params, "excluded_tags")) {
    clauses.push(`NOT EXISTS (SELECT 1 FROM image_tags it WHERE it.image_id = i.id AND it.tag IN (${group.map(() => "?").join(",")}))`);
    values.push(...group);
  }

  return { sql: clauses.join(" AND "), values };
}

async function candidateFromShard(db: D1Database, where: string, values: Array<string | number>, key: number): Promise<Candidate | null> {
  const base = `SELECT i.* FROM images i WHERE ${where}`;
  const first = await db.prepare(`${base} AND i.random_key >= ? ORDER BY i.random_key ASC LIMIT 1`).bind(...values, key).first<ImageRow>();
  if (first) return { row: first, shard: db };
  const wrapped = await db.prepare(`${base} ORDER BY i.random_key ASC LIMIT 1`).bind(...values).first<ImageRow>();
  return wrapped ? { row: wrapped, shard: db } : null;
}

function circularDistance(key: number, value: number): number {
  return value >= key ? value - key : 1 - key + value;
}

async function pickRandom(env: Env, params: URLSearchParams): Promise<Candidate | null> {
  const key = await randomUnit(params.get("seed"));
  const filter = buildFilters(params);
  const candidates = await Promise.all(shards(env).map((db) => candidateFromShard(db, filter.sql, filter.values, key)));
  return candidates
    .filter((item): item is Candidate => item !== null)
    .sort((a, b) => circularDistance(key, a.row.random_key) - circularDistance(key, b.row.random_key))[0] ?? null;
}

async function tagsFor(candidate: Candidate): Promise<string[]> {
  const result = await candidate.shard.prepare("SELECT tag FROM image_tags WHERE image_id = ? ORDER BY tag").bind(candidate.row.id).all<{ tag: string }>();
  return result.results.map((row) => row.tag);
}

function publicImage(row: ImageRow, tags: string[], origin: string): object {
  return {
    image: {
      id: String(row.id), illust_id: String(row.illust_id), page_index: row.page_index, ext: row.ext,
      width: row.width, height: row.height, x_restrict: row.x_restrict, ai_type: row.ai_type,
      bookmark_count: row.bookmark_count, view_count: row.view_count, comment_count: row.comment_count,
      user: { id: row.user_id === null ? null : String(row.user_id), name: row.user_name },
      illust_type: row.illust_type, title: row.title, created_at_pixiv: row.created_at_pixiv,
    },
    tags,
    urls: {
      proxy: `${origin}/i/${row.id}.${row.ext}`,
      local: `/i/${row.id}.${row.ext}`,
      origin: null,
      imgproxy: null,
      legacy_single: `/${row.illust_id}.${row.ext}`,
      legacy_multi: `/${row.illust_id}-${row.page_index + 1}.${row.ext}`,
    },
  };
}

function mirrorUrl(source: string, params: URLSearchParams): string {
  const proxy = (params.get("proxy") ?? "").trim().toLowerCase();
  const mirror = proxy === "re" || proxy === "i-pixiv-re" ? "i.pixiv.re" : proxy === "cat" || proxy === "i-pixiv-cat" ? "i.pixiv.cat" : "";
  if (!mirror) return source;
  const url = new URL(source);
  if (url.hostname === "i.pximg.net") url.hostname = mirror;
  return url.toString();
}

async function streamImage(row: ImageRow, request: Request): Promise<Response> {
  if (!row.original_url) return error("ORIGIN_UNAVAILABLE", "Original image URL is not available", 503);
  const target = mirrorUrl(row.original_url, new URL(request.url).searchParams);
  const headers = new Headers({ Referer: "https://www.pixiv.net/", "User-Agent": "Mozilla/5.0" });
  const range = request.headers.get("range");
  if (range) headers.set("range", range);
  const upstream = await fetch(target, { headers, redirect: "follow" });
  if (!upstream.ok && upstream.status !== 206) return error("UPSTREAM_ERROR", `Image upstream returned ${upstream.status}`, upstream.status === 404 ? 404 : 502);
  const responseHeaders = new Headers();
  for (const name of ["content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified"]) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  responseHeaders.set("cache-control", "public, max-age=86400, stale-while-revalidate=604800");
  responseHeaders.set("x-image-edge", "cloudflare-worker");
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}

async function findImage(env: Env, id: number): Promise<Candidate | null> {
  const found = await Promise.all(shards(env).map(async (db) => {
    const row = await db.prepare("SELECT * FROM images WHERE id = ? AND enabled = 1").bind(id).first<ImageRow>();
    return row ? { row, shard: db } : null;
  }));
  return found.find((item): item is Candidate => item !== null) ?? null;
}

async function listImages(env: Env, url: URL): Promise<Response> {
  const limit = Math.min(MAX_LIMIT, Math.max(1, intParam(url.searchParams, "limit", 50)));
  const cursor = intParam(url.searchParams, "cursor", Number.MAX_SAFE_INTEGER);
  const filter = buildFilters(url.searchParams);
  const rows = await Promise.all(shards(env).map((db) => db.prepare(
    `SELECT i.* FROM images i WHERE i.id < ? AND ${filter.sql} ORDER BY i.id DESC LIMIT ?`,
  ).bind(cursor, ...filter.values, limit).all<ImageRow>()));
  const merged = rows.flatMap((result) => result.results).sort((a, b) => b.id - a.id).slice(0, limit);
  const id = requestId();
  return json({
    ok: true,
    request_id: id,
    items: merged.map((row) => ({
      id: String(row.id), illust_id: String(row.illust_id), page_index: row.page_index, ext: row.ext,
      width: row.width, height: row.height, x_restrict: row.x_restrict, ai_type: row.ai_type,
      bookmark_count: row.bookmark_count, view_count: row.view_count, comment_count: row.comment_count,
      user: { id: row.user_id === null ? null : String(row.user_id), name: row.user_name },
      title: row.title, created_at_pixiv: row.created_at_pixiv,
    })),
    next_cursor: merged.length === limit ? String(merged[merged.length - 1].id) : null,
  }, 200, id);
}

async function status(env: Env): Promise<Response> {
  const rows = await env.META_DB.prepare("SELECT key, value, updated_at FROM catalog_state ORDER BY key").all<{ key: string; value: string; updated_at: string }>();
  const state = Object.fromEntries(rows.results.map((row) => [row.key, row.value]));
  return json({ ok: true, service: "random-mage-pixiv", version: env.APP_VERSION, shards: Number(env.SHARD_COUNT), catalog: state });
}

function page(title: string, body: string): Response {
  return new Response(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{max-width:920px;margin:48px auto;padding:0 20px;background:#0d1117;color:#e6edf3;font:16px/1.7 system-ui}a{color:#58a6ff}code{background:#161b22;padding:.15em .4em;border-radius:6px}.card{border:1px solid #30363d;border-radius:14px;padding:22px;margin:18px 0}</style></head><body>${body}</body></html>`, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" },
  });
}

function docsPage(): Response {
  return page("Random Mage", `<h1>Random Mage · Cloudflare</h1><div class="card"><p>Cloudflare 免费 D1 分片版本已经运行。</p><p><a href="/status">状态</a> · <a href="/random?format=json&r18=2">随机 JSON</a> · <a href="/images?r18=2">图片列表</a> · <a href="/wtf">瀑布流</a></p></div><h2>常用接口</h2><p><code>/random</code> 直接出图；<code>/random?format=json</code> 返回元数据；<code>/random?r18=0&amp;orientation=portrait</code> 支持筛选。</p>`);
}

function statusPage(): Response {
  return page("Random Mage Status", `<h1>运行状态</h1><div class="card"><p>Worker 正常运行。图库数据将按免费 D1 每日额度持续导入。</p><p><a href="/status.json">查看 JSON 状态</a></p></div>`);
}

function waterfallPage(): Response {
  return page("Random Mage Gallery", `<h1>随机瀑布流</h1><div id="grid"></div><script>const g=document.querySelector('#grid');async function add(){const r=await fetch('/random?format=json&r18=0');const j=await r.json();if(!j.ok){g.textContent='图库数据尚未导入';return}const i=document.createElement('img');i.src=j.data.urls.proxy;i.style='max-width:100%;margin:8px 0;border-radius:12px';g.append(i)}for(let n=0;n<8;n++)add()</script>`);
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== "GET" && request.method !== "HEAD") return error("METHOD_NOT_ALLOWED", "Method not allowed", 405);
  if (url.pathname === "/" || url.pathname === "/docs") return docsPage();
  if (url.pathname === "/healthz") return json({ ok: true });
  if (url.pathname === "/version") return json({ ok: true, version: env.APP_VERSION });
  if (url.pathname === "/status") return statusPage();
  if (url.pathname === "/status.json") return status(env);
  if (url.pathname === "/wtf") return waterfallPage();
  if (url.pathname === "/images") return listImages(env, url);

  const imageMatch = url.pathname.match(/^\/images\/(\d+)$/);
  if (imageMatch) {
    const candidate = await findImage(env, Number.parseInt(imageMatch[1], 10));
    if (!candidate) return error("NOT_FOUND", "Image not found", 404);
    const tags = await tagsFor(candidate);
    return json({ ok: true, code: "OK", data: publicImage(candidate.row, tags, url.origin) });
  }

  const proxyMatch = url.pathname.match(/^\/i\/(\d+)\.[a-zA-Z0-9]+$/);
  if (proxyMatch) {
    const candidate = await findImage(env, Number.parseInt(proxyMatch[1], 10));
    if (!candidate) return error("NOT_FOUND", "Image not found", 404);
    return streamImage(candidate.row, request);
  }

  if (url.pathname === "/random") {
    const candidate = await pickRandom(env, url.searchParams);
    if (!candidate) return error("NO_MATCH", "No image matched the filters", 404);
    const format = enumParam(url.searchParams, "format", new Set(["image", "json", "simple_json"]), "image");
    if (format === "image") return streamImage(candidate.row, request);
    const tags = format === "json" ? await tagsFor(candidate) : [];
    const id = requestId();
    return json({ ok: true, code: "OK", request_id: id, data: publicImage(candidate.row, tags, url.origin) }, 200, id);
  }

  return error("NOT_FOUND", "Route not found", 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Unexpected error";
      console.error(JSON.stringify({ event: "request_failed", path: new URL(request.url).pathname, message }));
      return error(message.startsWith("Unsupported") ? "BAD_REQUEST" : "INTERNAL_ERROR", message, message.startsWith("Unsupported") ? 400 : 500);
    }
  },
} satisfies ExportedHandler<Env>;
