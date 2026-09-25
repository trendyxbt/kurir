/**
 * Turns guard findings into one short Bahasa Indonesia sentence.
 *
 * This is the only place an LLM is used, and it is a judgment call about *wording*,
 * not about safety: the verdict is already decided by guard.ts rules. Block-level
 * findings never come here via the LLM path — they use templateExplain() directly.
 * With no OPENAI_API_KEY set, warn findings also use the templates (zero API cost).
 */
import { env } from "./config.js";
import type { Finding, FindingCode } from "./guard.js";

const PRIORITY: FindingCode[] = [
  "SCAM_LIST",
  "RECIPIENT_IS_TOKEN",
  "RECIPIENT_IS_RELAYER",
  "RECIPIENT_IS_ZERO",
  "ADDRESS_POISONING",
  "FRESH_ADDRESS_LARGE_SEND",
  "UNKNOWN_CONTRACT",
  "CHECKS_DEGRADED",
];

const short = (a: unknown) => (typeof a === "string" && a.length === 42 ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");

function sentenceFor(f: Finding): string {
  switch (f.code) {
    case "RECIPIENT_IS_TOKEN":
      return "Alamat tujuannya itu kontrak token-nya sendiri — kalau dikirim ke sini, dana kamu literally nyangkut selamanya. Diblok ya.";
    case "RECIPIENT_IS_RELAYER":
      return "Itu alamat kontrak Kurir, bukan wallet penerima — dikirim ke sini dananya nyangkut. Diblok.";
    case "RECIPIENT_IS_ZERO":
      return "Ini alamat nol alias burn address — apa pun yang dikirim ke sini hilang permanen. Diblok.";
    case "SCAM_LIST":
      return "Alamat ini ada di daftar scam yang udah kita tandain. No way, transaksinya diblok.";
    case "ADDRESS_POISONING":
      return f.data?.isOwnAddress
        ? `Alamat ini mirip banget sama alamat wallet kamu sendiri, tapi ${f.data?.differingChars} karakter tengahnya beda — ini modus address poisoning, cek lagi sebelum lanjut.`
        : `Alamat ini mirip banget sama ${short(f.data?.similarTo)} yang pernah kamu pakai, tapi ${f.data?.differingChars} karakter tengahnya beda — cek lagi sebelum lanjut.`;
    case "FRESH_ADDRESS_LARGE_SEND":
      return "Alamat ini masih fresh banget (belum ada aktivitas on-chain) dan nominalnya gede — pastiin alamatnya bener, mending test kirim kecil dulu.";
    case "UNKNOWN_CONTRACT":
      return "Tujuannya smart contract yang belum pernah kamu kirimin sebelumnya — bisa aja aman, tapi double-check dulu ya.";
    case "CHECKS_DEGRADED":
      return "Sebagian pengecekan lagi nggak jalan karena node-nya susah dihubungi — hati-hati ekstra ya.";
  }
}

/** Deterministic Indonesian explanation. Used for all blocks, and for warns when no API key is set. */
export function templateExplain(findings: Finding[]): string {
  if (findings.length === 0) return "";
  const sorted = [...findings].sort((a, b) => PRIORITY.indexOf(a.code) - PRIORITY.indexOf(b.code));
  const main = sentenceFor(sorted[0]);
  return sorted.length > 1 ? `${main} (+${sorted.length - 1} catatan lain)` : main;
}

const SYSTEM_PROMPT = `Kamu adalah suara pengecekan keamanan di Kurir, app kirim token di BNB Chain.
Tugasmu: jelasin peringatan transaksi ke user awam dalam SATU kalimat pendek Bahasa Indonesia,
gaya Gen Z Jakarta Selatan — santai, to the point, campur istilah Inggris secara natural (cek, double-check, literally, fresh).
Aturan:
- Keputusan (warn) udah final dari rule engine. Jangan bilang transaksinya aman, jangan bilang diblok.
- Ini peringatan, bukan larangan: user yang mutusin lanjut atau nggak. Jangan bilang "jangan kirim" atau "batalin".
- Kalau ada lebih dari satu finding, sebut semuanya secara singkat.
- Sebut hal spesifik dari findings (misal berapa karakter yang beda, alamat mirip siapa).
- Kasih satu saran aksi yang konkret (misal cek ulang alamat, test kirim kecil dulu).
- Maksimal 30 kata. Tanpa emoji. Tanpa tanda kutip.`;

/** True when an LLM is configured: a local/OpenAI-compatible server (LLM_BASE_URL) or an OpenAI key. */
export const llmEnabled = Boolean(env.LLM_BASE_URL || env.OPENAI_API_KEY);
const LLM_URL = `${(env.LLM_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "")}/chat/completions`;

/**
 * Ollama only: load the model now and keep it in memory for LLM_KEEP_ALIVE, refreshed every
 * 30 min. A cold load takes ~11 s on the demo laptop; warm answers take ~3 s. The OpenAI-compatible
 * /v1 endpoint ignores keep_alive, so this uses Ollama's native /api/generate.
 */
export function startLlmWarmup(): void {
  if (!env.LLM_BASE_URL || !env.LLM_KEEP_ALIVE) return;
  const url = `${new URL(env.LLM_BASE_URL).origin}/api/generate`;
  const warm = async () => {
    const t = Date.now();
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: env.OPENAI_MODEL, keep_alive: env.LLM_KEEP_ALIVE }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      console.log(`[llm] ${env.OPENAI_MODEL} loaded, kept for ${env.LLM_KEEP_ALIVE} (${Date.now() - t} ms)`);
    } catch (err) {
      console.warn("[llm] warm-up failed, explanations will fall back to templates if the model is slow:", err instanceof Error ? err.message : err);
    }
  };
  void warm();
  setInterval(warm, 30 * 60_000).unref();
}

/** Drop reasoning blocks some local models (e.g. Qwen3) emit, and keep one line. */
function cleanOutput(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/<\/?think>/g, "").trim().split("\n")[0].trim();
}

/** For warn-level findings only. Falls back to templates when no LLM is configured, on error, or on timeout. */
export async function explainWarn(findings: Finding[]): Promise<string> {
  const fallback = templateExplain(findings);
  if (!llmEnabled) return fallback;

  try {
    const res = await fetch(LLM_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(env.OPENAI_API_KEY ? { Authorization: `Bearer ${env.OPENAI_API_KEY}` } : {}),
      },
      signal: AbortSignal.timeout(env.LLM_TIMEOUT_MS),
      body: JSON.stringify({
        model: env.OPENAI_MODEL,
        temperature: 0.4,
        max_tokens: 120,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: `Findings (JSON):\n${JSON.stringify(findings.map(({ code, data }) => ({ code, data })))}\n\nContoh gaya: ${fallback}`,
          },
        ],
      }),
    });
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const text = cleanOutput(json.choices?.[0]?.message?.content ?? "");
    return text.length > 0 ? text : fallback;
  } catch (err) {
    console.warn("[llmExplain] falling back to template:", err instanceof Error ? err.message : err);
    return fallback;
  }
}
