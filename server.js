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

// يقبل أسماء المتغيرات بأي حالة أحرف (مثلاً Groq_Api_Key) ويحولها للأحرف الكبيرة
for (const k of Object.keys(process.env)) {
  const up = k.toUpperCase();
  if (up !== k && !process.env[up]) process.env[up] = process.env[k];
}

const run = promisify(execFile);
const app = express();
const upload = multer({ limits: { fileSize: 10 * 1024 * 1024 } });
app.use(express.json());
app.get("/api/health", (req, res) => {
  const E = process.env;
  res.json({
    groq: !!E.GROQ_API_KEY, gemini: !!E.GEMINI_API_KEY, anthropic: !!E.ANTHROPIC_API_KEY,
    saucenao: !!E.SAUCENAO_API_KEY, tmdb: !!E.TMDB_API_KEY,
    // أسماء المتغيرات التي تحتوي KEY/API فقط (بدون القيم)
    key_like_names: Object.keys(E).filter((k) => /KEY|API|TOKEN/i.test(k)),
  });
});
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
const PROMPT = `هذه لقطات من نفس المقطع (فيلم أو مسلسل أو أنمي، أي لغة وأي بلد). حدد العمل من المشهد والأزياء والديكور والنصوص والترجمة والشعارات واللغة المنطوقة إن ظهرت. لا تتعرف على أي شخص من وجهه. إذا لم يكن هناك دليل كافٍ لا تخمّن، اجعل found=false. لا تحدد اسم أنمي من شكل شخصية فقط؛ الخطأ أسوأ من عدم الإجابة. اجعل confidence "عالية" فقط إذا كنت متأكداً فعلاً. أجب JSON فقط بدون markdown: {"is_anime":bool,"found":bool,"title":"الاسم الأصلي بالإنجليزية","title_ar":"","type":"فيلم|مسلسل|أنمي","year":"","season_episode":"","plot":"نبذة قصيرة بدون حرق","confidence":"عالية|متوسطة|منخفضة","reasoning":"اذكر الأدلة التي اعتمدت عليها"}`;

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
  // يجرب الموديلات بالترتيب لحد ما يلاقي واحد شغال (أسماء الموديلات عند Groq بتتغير)
  const models = [process.env.GROQ_MODEL, "qwen/qwen3.8-27b", "qwen/qwen3.6-27b", "meta-llama/llama-4-scout-17b-16e-instruct"].filter(Boolean);
  const content = bufs.map((b) => ({ type: "image_url", image_url: { url: "data:image/jpeg;base64," + b.toString("base64") } }));
  content.push({ type: "text", text: PROMPT });
  let lastErr = "groq error";
  for (const model of models) {
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: "Bearer " + process.env.GROQ_API_KEY },
      body: JSON.stringify({ model, messages: [{ role: "user", content }], max_completion_tokens: 2000, temperature: 0.2 }),
    });
    const j = await r.json();
    if (r.ok) return j.choices?.[0]?.message?.content || "";
    lastErr = `${model}: ${j.error?.message || r.status}`;
    if (!/does not exist|not have access|decommission|not found/i.test(lastErr)) break;
  }
  throw new Error(lastErr);
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

// يختار لقطات موزعة على المقطع (الموديل يقبل 3 صور كحد أقصى)
function spread(arr, n) {
  if (arr.length <= n) return arr;
  return Array.from({ length: n }, (_, i) => arr[Math.round((i * (arr.length - 1)) / (n - 1))]);
}

async function vision(bufs) {
  const E = process.env;
  const [name, ask] = E.GEMINI_API_KEY ? ["gemini", askGemini] : E.GROQ_API_KEY ? ["groq", askGroq] : E.ANTHROPIC_API_KEY ? ["claude", askClaude] : [null, null];
  if (!ask) return null;
  try {
    let txt = (await ask(spread(bufs, 3))).replace(/<think>[\s\S]*?<\/think>/g, "");
    txt = txt.slice(txt.indexOf("{"), txt.lastIndexOf("}") + 1);
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

// أفضل 3 نتائج من trace.moe للقطة واحدة
async function traceTop(buf) {
  const r = await fetch("https://api.trace.moe/search?anilistInfo&cutBorders", {
    method: "POST",
    headers: { "Content-Type": "image/jpeg" },
    body: buf,
  });
  if (!r.ok) return [];
  const j = await r.json();
  return (j.result || []).slice(0, 3).map((x) => {
    const t = x.anilist?.title || {};
    return { id: x.anilist?.id, title: t.english || t.romaji || t.native, native: t.native,
      episode: x.episode, from: Math.round(x.from), sim: x.similarity, video: x.video };
  }).filter((x) => x.id);
}

// يفحص عدة لقطات ويعتمد على الاتفاق بينها (يقلل الأخطاء كثيراً)
async function traceConsensus(frames) {
  const picks = spread(frames, 5);
  const votes = new Map(); // id -> {count, best, ...}
  for (const f of picks) {
    const top = await traceTop(f).catch(() => []);
    const best = top[0];
    if (!best || best.sim < 0.85) continue;
    const v = votes.get(best.id) || { count: 0, best };
    v.count++;
    if (best.sim > v.best.sim) v.best = best;
    votes.set(best.id, v);
  }
  const ranked = [...votes.values()].sort((a, b) => b.count - a.count || b.best.sim - a.best.sim);
  const top = ranked[0];
  if (!top) return null;
  const ok = (top.count >= 2 && top.best.sim >= 0.88) || top.best.sim >= 0.95;
  return { top, ok, others: ranked.slice(1, 3), total: picks.length };
}

// SauceNAO: بحث عكسي للصور (شخصيات، بوسترات، فان آرت، مانغا) - مفتاح مجاني
async function saucenao(buf) {
  if (!process.env.SAUCENAO_API_KEY) return null;
  try {
    const fd = new FormData();
    fd.append("file", new Blob([buf], { type: "image/jpeg" }), "q.jpg");
    const r = await fetch(`https://saucenao.com/search.php?output_type=2&numres=5&db=999&api_key=${process.env.SAUCENAO_API_KEY}`, { method: "POST", body: fd });
    const j = await r.json();
    const top = (j.results || []).sort((a, b) => parseFloat(b.header.similarity) - parseFloat(a.header.similarity))[0];
    if (!top) return null;
    const sim = parseFloat(top.header.similarity);
    if (sim < 85) return null;
    const d = top.data || {};
    const title = d.source || d.material || d.title;
    if (!title) return null;
    return { sim, title, characters: d.characters, part: d.part, year: d.year, est_time: d.est_time, db: top.header.index_name };
  } catch { return null; }
}

async function identify(frames) {
  const [vis, tc, sauce] = await Promise.all([vision(frames), traceConsensus(frames).catch(() => null), frames.length === 1 ? saucenao(frames[0]) : null]);
  if (tc && tc.ok && (!vis || vis.is_anime !== false)) {
    const b = tc.top.best;
    const alts = tc.others.map((o) => `${o.best.title} (${(o.best.sim * 100).toFixed(0)}%)`).join("، ");
    return {
      source: "trace.moe", found: true, type: "أنمي",
      title: b.title, title_native: b.native, episode: b.episode, at_second: b.from,
      similarity: (b.sim * 100).toFixed(1) + "%", preview_video: b.video,
      anilist: `https://anilist.co/anime/${b.id}`, plot: vis?.plot,
      confidence: tc.top.count >= 2 ? "عالية" : "متوسطة",
      reasoning: `طابقت ${tc.top.count} من ${tc.total} لقطات.` + (alts ? ` احتمالات أخرى: ${alts}` : "") +
        (tc.top.count < 2 ? " النتيجة من لقطة واحدة فقط، تأكد منها." : ""),
    };
  }
  if (sauce) {
    return {
      source: "saucenao", found: true, type: "أنمي/مانغا/عمل فني",
      title: String(sauce.title).slice(0, 200), episode: sauce.part, year: sauce.year,
      similarity: sauce.sim.toFixed(1) + "%", confidence: sauce.sim >= 92 ? "عالية" : "متوسطة",
      plot: sauce.characters ? "الشخصيات: " + sauce.characters : vis?.plot,
      reasoning: "نتيجة بحث عكسي (SauceNAO) من قاعدة: " + sauce.db,
    };
  }
  if (!vis) return { found: false, reasoning: "لازم تضيف GROQ_API_KEY (مجاني) أو GEMINI_API_KEY أو ANTHROPIC_API_KEY للتعرف على الأفلام والمسلسلات." };
  if (tc && !tc.ok && vis.found && vis.is_anime !== false) {
    vis.reasoning = (vis.reasoning || "") + ` (trace.moe لم يتأكد: أقرب نتيجة ${tc.top.best.title} بنسبة ${(tc.top.best.sim * 100).toFixed(0)}% فقط)`;
  }
  if (vis.found && vis.confidence === "منخفضة") {
    return { found: false, reasoning: `غير متأكد. أقرب تخمين: ${vis.title} (${vis.type || ""}). ${vis.reasoning || ""}` };
  }
  if (vis.found && vis.confidence === "متوسطة") vis.reasoning = "⚠️ تخمين متوسط الثقة، تأكد منه. " + (vis.reasoning || "");
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
