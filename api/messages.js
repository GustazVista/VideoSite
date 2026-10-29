// Vercel serverless function: shared guestbook messages stored in Upstash Redis.
//   GET    /api/messages            -> { messages: [...], admin: true|false }
//   POST   /api/messages  {text}    -> adds a message (anyone)
//   DELETE /api/messages  {id}      -> deletes a message (owner only)
// The owner is whoever sends the header  x-admin-password  equal to the
// ADMIN_PASSWORD environment variable you set in Vercel.
import { Redis } from "@upstash/redis";

// Vercel's Redis integration injects one of these pairs of variables.
const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL   || process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const redis = REDIS_URL && REDIS_TOKEN ? new Redis({ url: REDIS_URL, token: REDIS_TOKEN }) : null;

const INDEX = "msg:index";   // sorted set: id scored by time (for ordering)
const DATA  = "msg:data";    // hash: id -> { text }
const MAX_LEN = 200;
const MAX_KEEP = 500;        // keep only the newest 500 messages

const isAdmin = req =>
  !!process.env.ADMIN_PASSWORD && req.headers["x-admin-password"] === process.env.ADMIN_PASSWORD;

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  // Diagnostics: open /api/messages in your browser to see which of these you get.
  if (!redis) {
    return res.status(500).json({ error: "no database", hint: "Connect an Upstash Redis database to this Vercel project, then redeploy." });
  }
  try {
    if (req.method === "GET") {
      const ids = (await redis.zrange(INDEX, 0, 199, { rev: true })).map(String);
      const rows = ids.length ? (await redis.hmget(DATA, ...ids)) || {} : {};
      const messages = ids
        .filter(id => rows[id] && typeof rows[id].text === "string")
        .map(id => ({ id, text: rows[id].text, time: Number(id.split("-")[0]) }));
      return res.status(200).json({ messages, admin: isAdmin(req) });
    }

    if (req.method === "POST") {
      const text = String((req.body && req.body.text) ?? "").trim();
      if (!text || text.length > MAX_LEN) return res.status(400).json({ error: "bad text" });

      // Simple spam guard: one message per visitor every 4 seconds
      const ip = String(req.headers["x-forwarded-for"] || "unknown").split(",")[0].trim();
      const ok = await redis.set(`rl:${ip}`, 1, { nx: true, ex: 4 });
      if (!ok) return res.status(429).json({ error: "too fast" });

      const now = Date.now();
      const id = `${now}-${Math.random().toString(36).slice(2, 8)}`;
      await redis.hset(DATA, { [id]: { text } });
      await redis.zadd(INDEX, { score: now, member: id });

      // Trim old messages beyond MAX_KEEP
      const extra = await redis.zrange(INDEX, 0, -(MAX_KEEP + 1));
      if (extra.length) { await redis.zrem(INDEX, ...extra); await redis.hdel(DATA, ...extra.map(String)); }
      return res.status(201).json({ id });
    }

    if (req.method === "DELETE") {
      if (!isAdmin(req)) return res.status(403).json({ error: "forbidden" });
      const id = String((req.body && req.body.id) ?? "");
      if (!id) return res.status(400).json({ error: "no id" });
      await redis.zrem(INDEX, id);
      await redis.hdel(DATA, id);
      return res.status(200).json({ ok: true });
    }

    res.setHeader("Allow", "GET, POST, DELETE");
    return res.status(405).json({ error: "method not allowed" });
  } catch (e) {
    return res.status(500).json({ error: "server error", hint: String((e && e.message) || e).slice(0, 120) });
  }
}
