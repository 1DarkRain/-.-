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
  if (!top || top.similarity < 0.87) return null;
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

// ---------- الذكاء الاصطناعي (Gemini المجاني أو Claude) ----------
const PROMPT = `هذه لقطات من نفس المقطع (فيلم أو مسلسل أو أنمي، أي لغة وأي بلد). حدد العمل من المشهد والأزياء والديكور والنصوص والترجمة والشعارات واللغة المنطوقة إن ظهرت. لا تتعرف على أي شخص من وجهه. إذا لم يكن هناك دليل كافٍ لا تخمّن، اجعل found=false. أجب JSON فقط بدون markdown: {"is_anime":bool,"found":bool,"title":"الاسم الأصلي بالإنجليزية","title_ar":"","type":"فيلم|مسلسل|أنمي","year":"","season_episode":"","plot":"نبذة قصيرة بدون حرق","confidence":"عالية|متوسطة|منخفضة","reasoning":"اذكر الأدلة التي اعتمدت عليها"}`;

async function askGemini(bufs) {
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const parts = bufs.map((b) => ({ inline_data: { mime_type: "image/jpeg", data: b.toString("base64") } }));
  parts.push({ text: PROMPT });
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
    body: JSON.stringify({ contents: [{ parts }], generationConfig: { responseMimeType: "application/json" } }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message || "gemini error");
  return j.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
}

async function askGroq(bufs) {
  const model = process.env.GROQ_MODEL || "meta-llama/llama-4-scout-17b-16e-instruct";
  const content = bufs.map((b) => ({ type: "image_url", image_url: { url: "data:image/jpeg;base64," + b.toString("base64") } }));
  content.push({ type: "text", text: PROMPT });
  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: "Bearer " + process.env.GROQ_API_KEY },
    body: JSON.stringify({ model, messages: [{ role: "user", content }], response_format: { type: "json_object" }, temperature: 0.2 }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message || "groq error");
  return j.choices?.[0]?.message?.content || "";
}

async function askClaude(bufs) {
  const content = bufs.map((b) => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: b.toString("base64") } }));
  content.push({ type: "text", text: PROMPT });
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1000, messages: [{ role: "user", content }] }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message || "claude error");
  return (j.content || []).map((c) => c.text || "").join("");
}

async function vision(bufs) {
  const E = process.env;
  const [name, ask] = E.GEMINI_API_KEY ? ["gemini", askGemini] : E.GROQ_API_KEY ? ["groq", askGroq] : E.ANTHROPIC_API_KEY ? ["claude", askClaude] : [null, null];
  if (!ask) return null;
  try {
    const txt = (await ask(bufs.slice(0, 4))).replace(/```json|```/g, "").trim();
    return { source: name, ...JSON.parse(txt) };
  } catch (e) {
    return { found: false, reasoning: "فشل التحليل: " + String(e.message).slice(0, 150) };
  }
}

// ---------- TMDB (تفاصيل وصورة للأفلام والمسلسلات) اختياري ----------
async function tmdb(d) {
  if (!process.env.TMDB_API_KEY || !d?.title) return d;
  try {
    const r = await fetch(`https://api.themoviedb.org/3/search/multi?language=ar&query=${encodeURIComponent(d.title)}`, {
      headers: { Authorization: "Bearer " + process.env.TMDB_API_KEY },
    });
    const m = (await r.json()).results?.find((x) => x.media_type !== "person");
    if (!m) return d;
    return {
      ...d,
      title_ar: m.title || m.name || d.title_ar,
      year: (m.release_date || m.first_air_date || d.year || "").slice(0, 4),
      plot: m.overview || d.plot,
      rating: m.vote_average ? m.vote_average.toFixed(1) + " / 10" : undefined,
      poster: m.poster_path ? "https://image.tmdb.org/t/p/w342" + m.poster_path : undefined,
      tmdb: `https://www.themoviedb.org/${m.media_type}/${m.id}`,
    };
  } catch { return d; }
}

async function identify(frames) {
  const [vis, trace] = await Promise.all([
    vision(frames),
    (async () => { for (const f of frames) { const h = await traceMoe(f).catch(() => null); if (h) return h; } return null; })(),
  ]);
  // الأنمي: قبل نتيجة trace.moe فقط إذا لم يقل الذكاء الاصطناعي إنه ليس أنمي
  if (trace && (!vis || vis.is_anime !== false) && parseFloat(trace.similarity) >= 90) {
    return { ...trace, plot: vis?.plot, confidence: "عالية" };
  }
  if (!vis) return { found: false, reasoning: "لازم تضيف GROQ_API_KEY (مجاني) أو GEMINI_API_KEY أو ANTHROPIC_API_KEY للتعرف على الأفلام والمسلسلات." };
  return vis.found ? tmdb(vis) : vis;
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
