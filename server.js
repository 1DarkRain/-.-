// Backend: يستخرج لقطات من رابط الفيديو، ثم:
//  1) trace.moe  -> مطابقة حقيقية للأنمي (الحلقة + الدقيقة + نسبة التشابه)
//  2) Claude Vision -> لأفلام ومسلسلات حقيقية (يحتاج ANTHROPIC_API_KEY)
// المتطلبات: Node 18+ ، yt-dlp ، ffmpeg مثبتين على السيرفر
import express from "express";
import multer from "multer";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const run = promisify(execFile);
const app = express();
const upload = multer({ limits: { fileSize: 10 * 1024 * 1024 } });
app.use(express.json());
app.use(express.static("public")); // ضع index.html (واجهة الموقع) داخل مجلد public

// ---------- trace.moe (أنمي) ----------
async function traceMoe(buf) {
  const r = await fetch("https://api.trace.moe/search?anilistInfo&cutBorders", {
    method: "POST",
    headers: { "Content-Type": "image/jpeg" },
    body: buf,
  });
  if (!r.ok) return null;
  const j = await r.json();
  const top = j.result?.[0];
  if (!top || top.similarity < 0.87) return null; // أقل من هذا غالباً خطأ
  const t = top.anilist?.title || {};
  return {
    source: "trace.moe",
    found: true,
    type: "أنمي",
    title: t.english || t.romaji,
    title_native: t.native,
    episode: top.episode,
    at_second: Math.round(top.from),
    similarity: Math.round(top.similarity * 1000) / 10 + "%",
    preview_video: top.video,
    anilist: top.anilist?.id ? `https://anilist.co/anime/${top.anilist.id}` : null,
  };
}

// ---------- Claude Vision (أفلام ومسلسلات) ----------
async function claudeVision(bufs) {
  if (!process.env.ANTHROPIC_API_KEY) return { found: false, error: "ANTHROPIC_API_KEY غير موجود" };
  const content = bufs.map((b) => ({
    type: "image",
    source: { type: "base64", media_type: "image/jpeg", data: b.toString("base64") },
  }));
  content.push({
    type: "text",
    text: 'هذه لقطات من نفس المقطع. حدد العمل (فيلم/مسلسل/أنمي) من المشهد والنصوص والشخصيات، دون التعرف على أشخاص من وجوههم. أجب JSON فقط: {"found":bool,"title":"","title_ar":"","type":"","year":"","season_episode":"","plot":"","confidence":"","reasoning":""}',
  });
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1000, messages: [{ role: "user", content }] }),
  });
  const j = await r.json();
  const txt = (j.content || []).map((c) => c.text || "").join("").replace(/```json|```/g, "").trim();
  try { return { source: "claude", ...JSON.parse(txt) }; } catch { return { found: false, raw: txt }; }
}

async function identify(frames) {
  // جرّب كل لقطة على trace.moe، وإن فشل الكل استخدم Claude
  for (const f of frames) {
    const hit = await traceMoe(f).catch(() => null);
    if (hit) return hit;
  }
  return claudeVision(frames.slice(0, 4));
}

// ---------- من رابط ----------
app.post("/api/link", async (req, res) => {
  const url = String(req.body?.url || "");
  if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: "رابط غير صالح" });
  const dir = await mkdtemp(path.join(tmpdir(), "tf-"));
  try {
    // حمّل أول 90 ثانية فقط بجودة منخفضة (سريع وخفيف)
    await run("yt-dlp", ["-f", "worst[ext=mp4]/worst", "--download-sections", "*0-90",
      "--no-playlist", "--max-filesize", "80M", "-o", path.join(dir, "v.%(ext)s"), url], { timeout: 120000 });
    const vid = (await readdir(dir)).find((f) => f.startsWith("v."));
    // لقطة كل 10 ثواني
    await run("ffmpeg", ["-i", path.join(dir, vid), "-vf", "fps=1/10,scale=640:-1",
      "-frames:v", "8", path.join(dir, "f%02d.jpg")], { timeout: 60000 });
    const names = (await readdir(dir)).filter((f) => f.startsWith("f")).sort();
    const frames = await Promise.all(names.map((n) => readFile(path.join(dir, n))));
    res.json(await identify(frames));
  } catch (e) {
    res.status(500).json({ error: "تعذّر معالجة الرابط (قد يكون محمي أو خاص)", detail: String(e.message).slice(0, 200) });
  } finally {
    rm(dir, { recursive: true, force: true });
  }
});

// ---------- من صورة ----------
app.post("/api/image", upload.single("image"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "لا توجد صورة" });
  res.json(await identify([req.file.buffer]));
});

app.listen(process.env.PORT || 3000, () => console.log("جاهز على http://localhost:3000"));
