const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { PDFParse } = require("pdf-parse");
const { createClient } = require("@supabase/supabase-js");
const Stripe = require("stripe");

const ROOT = __dirname;
const FREE_LIMIT = 3;

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".xml": "application/xml; charset=utf-8",
};

async function loadEnvFile() {
  try {
    const envPath = path.join(ROOT, ".env");
    const text = await fs.readFile(envPath, "utf8");
    text.split(/\r?\n/).forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) return;
      const [key, ...rest] = trimmed.split("=");
      if (!process.env[key]) {
        process.env[key] = rest.join("=").replace(/^["']|["']$/g, "");
      }
    });
  } catch {
    // .env is optional.
  }
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        request.destroy();
        reject(new Error("Request body is too large."));
      }
    });
    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON."));
      }
    });
    request.on("error", reject);
  });
}

function readBuffer(request, maxBytes = 15_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        request.destroy();
        reject(new Error("PDF file is too large. Please upload a file under 15MB."));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function parseMultipartFile(buffer, contentType) {
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!boundaryMatch) {
    const error = new Error("Invalid multipart request.");
    error.status = 400;
    throw error;
  }

  const boundary = Buffer.from(`--${boundaryMatch[1] || boundaryMatch[2]}`);
  let offset = 0;

  while (offset < buffer.length) {
    const boundaryStart = buffer.indexOf(boundary, offset);
    if (boundaryStart === -1) break;

    const headerStart = boundaryStart + boundary.length + 2;
    const headerEnd = buffer.indexOf(Buffer.from("\r\n\r\n"), headerStart);
    if (headerEnd === -1) break;

    const header = buffer.slice(headerStart, headerEnd).toString("utf8");
    const nextBoundary = buffer.indexOf(boundary, headerEnd + 4);
    if (nextBoundary === -1) break;

    if (/name="file"/i.test(header)) {
      const filename = header.match(/filename="([^"]*)"/i)?.[1] || "uploaded.pdf";
      const content = buffer.slice(headerEnd + 4, Math.max(headerEnd + 4, nextBoundary - 2));
      return { filename, content };
    }

    offset = nextBoundary;
  }

  const error = new Error("PDF file was not found in the upload.");
  error.status = 400;
  throw error;
}

async function extractPdfText(buffer) {
  const parser = new PDFParse({ data: buffer });

  try {
    const result = await parser.getText();
    return (result.text || "").replace(/\n{3,}/g, "\n\n").trim();
  } finally {
    await parser.destroy();
  }
}

function buildPrompt(data) {
  const materials = Array.isArray(data.materials) && data.materials.length
    ? data.materials.join("、")
    : "説明、例文、練習問題、宿題、小テスト、解答解説、先生メモ";
  const audiences = Array.isArray(data.audiences) && data.audiences.length
    ? data.audiences
    : ["student", "teacher"];
  const wantsStudent = audiences.includes("student");
  const wantsTeacher = audiences.includes("teacher");
  const audienceText = wantsStudent && wantsTeacher
    ? "生徒に配る教材と先生用ガイド"
    : wantsTeacher
      ? "先生用ガイドのみ"
      : "生徒に配る教材のみ";
  const structure = wantsStudent && wantsTeacher
    ? `# 教材タイトル
## 今日のゴール
## 導入問題
## 基本文
## 例文
## 練習問題
### 基礎
### 標準
### 発展
## 宿題

# 先生用ガイド
## 授業の流れ
## 解答
## 解説
## つまずきポイント
## 声かけ例
## 時間配分`
    : wantsTeacher
      ? `# 先生用ガイド
## 授業の流れ
## 解答
## 解説
## つまずきポイント
## 声かけ例
## 時間配分`
      : `# 教材タイトル
## 今日のゴール
## 導入問題
## 基本文
## 例文
## 練習問題
### 基礎
### 標準
### 発展
## 宿題`;
  const sourceText = typeof data.sourceText === "string" ? data.sourceText.trim() : "";
  const sourceBlock = sourceText
    ? `
参考PDF: ${data.sourceFilename || "アップロード資料"}

以下のPDF内容を参考にして教材を作ってください。ただし、原文を丸写しせず、授業で使いやすい説明・例文・問題として作り直してください。

--- PDFから抽出した内容 ---
${sourceText.slice(0, 12000)}
--- ここまで ---`
    : "";

  return `あなたは中学生向け英語教材を作る熟練の編集者です。
以下の条件で、塾の授業でそのまま使える教材を日本語で作成してください。

対象: ${data.grade || "中学1年"}
教科: ${data.subject || "英語"}
単元: ${data.topic || "be動詞の基本"}
難易度: ${data.level || "標準"}
授業時間: ${data.duration || "45分"}
作成物: ${materials}
出力形式: ${audienceText}
条件: ${data.requirements || "英語が苦手な生徒にもわかりやすくする"}
${sourceBlock}

必ず次の構成でMarkdown出力してください。

${structure}

品質条件:
- 出力全体をコードフェンス（\`\`\`）で囲まない
- 生徒向けの説明は短く、具体例を多めにする
- 問題には番号を付ける
- 教材タイトルに「生徒用プリント」と書かない
- 生徒に配る部分を出す場合、そこには解答や先生向けメモを入れない
- 先生用ガイドを出す場合、そこには解答と簡潔な解説を入れる
- 参考PDFがある場合は、その要点・語彙・例を活かしながら新しい教材として再構成する
- 参考PDFの文章や問題を長くそのまま複製しない
- 授業時間内に終わる分量に調整する
- 不自然な英文や難しすぎる語彙を避ける`;
}


async function callClaude(prompt, requestedModel) {
  if (!process.env.ANTHROPIC_API_KEY) {
    const error = new Error("ANTHROPIC_API_KEY is not set.");
    error.status = 400;
    throw error;
  }

  const model = requestedModel || process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
  const apiResponse = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 3500,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  const rawText = await apiResponse.text();
  console.log("[Claude status]", apiResponse.status);
  console.log("[Claude response]", rawText.slice(0, 500));

  let payload;
  try {
    payload = JSON.parse(rawText);
  } catch {
    const error = new Error(`Claude returned invalid JSON (status ${apiResponse.status}): ${rawText.slice(0, 200)}`);
    error.status = 502;
    throw error;
  }

  if (!apiResponse.ok) {
    const message = payload.error?.message || "Anthropic API request failed.";
    const error = new Error(message);
    error.status = apiResponse.status;
    throw error;
  }

  return { text: payload.content?.[0]?.text || "", model };
}

async function callOpenAI(prompt, requestedModel) {
  if (!process.env.OPENAI_API_KEY) {
    const error = new Error("OPENAI_API_KEY is not set.");
    error.status = 400;
    throw error;
  }

  const model = requestedModel || "gpt-5.5";
  const apiResponse = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({ model, input: prompt, max_output_tokens: 3500 }),
  });

  const rawText = await apiResponse.text();
  console.log("[OpenAI status]", apiResponse.status);
  console.log("[OpenAI response]", rawText.slice(0, 500));

  let payload;
  try {
    payload = JSON.parse(rawText);
  } catch {
    const error = new Error(`OpenAI returned invalid JSON (status ${apiResponse.status}): ${rawText.slice(0, 200)}`);
    error.status = 502;
    throw error;
  }

  if (!apiResponse.ok) {
    const message = payload.error?.message || "OpenAI API request failed.";
    const error = new Error(message);
    error.status = apiResponse.status;
    throw error;
  }

  const text = typeof payload.output_text === "string"
    ? payload.output_text
    : (payload.output || []).flatMap(o => o.content || []).filter(c => c.type === "output_text").map(c => c.text).join("\n").trim();

  return { text, model };
}

function callAI(prompt, model) {
  if (model && model.startsWith("gpt")) return callOpenAI(prompt, model);
  return callClaude(prompt, model);
}

async function generateLesson(data) {
  const { text, model } = await callAI(buildPrompt(data), data.model);
  return { markdown: text, model };
}

function buildEditPrompt(data) {
  return `あなたは中学生向け教材を整える編集者です。
以下のMarkdown教材を、修正指示に従って編集してください。

対象: ${data.targetLabel || "教材"}
修正指示: ${data.instruction || "読みやすく整える"}

編集ルール:
- Markdown形式を維持する
- 元の教材の意図を保つ
- 指示に関係ない部分は大きく変えすぎない
- 生徒用教材の場合、解答や先生向けメモを混ぜない
- 先生用ガイドの場合、解答・解説・進行メモとして使いやすくする
- 出力は修正後のMarkdown本文だけにする

--- 元のMarkdown ---
${data.markdown || ""}
--- ここまで ---`;
}

async function editLesson(data) {
  if (!data.markdown || !data.instruction) {
    const error = new Error("教材本文と修正指示が必要です。");
    error.status = 400;
    throw error;
  }

  const { text, model } = await callAI(buildEditPrompt(data), data.model);
  return { markdown: text, model };
}

// ── Supabase & Stripe ────────────────────────────────────────────────────────

let supabaseAdmin = null;
let stripeClient = null;

function initServices() {
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    supabaseAdmin = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { autoRefreshToken: false, persistSession: false } }
    );
  }
  if (process.env.STRIPE_SECRET_KEY) {
    stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY);
  }
}

async function getAuthUser(request) {
  const auth = request.headers.authorization;
  if (!auth?.startsWith("Bearer ") || !supabaseAdmin) return null;
  try {
    const { data: { user } } = await supabaseAdmin.auth.getUser(auth.slice(7));
    return user || null;
  } catch {
    return null;
  }
}

async function ensureProfile(user) {
  const { data: profile } = await supabaseAdmin
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .single();
  if (!profile) {
    const row = { id: user.id, email: user.email, subscription_status: "free" };
    await supabaseAdmin.from("profiles").insert(row);
    return row;
  }
  return profile;
}

async function getUsageCount(userId) {
  const yearMonth = new Date().toISOString().slice(0, 7);
  const { data } = await supabaseAdmin
    .from("usage")
    .select("count")
    .eq("user_id", userId)
    .eq("year_month", yearMonth)
    .single();
  return data?.count || 0;
}

async function incrementUsage(userId) {
  const yearMonth = new Date().toISOString().slice(0, 7);
  const count = await getUsageCount(userId);
  await supabaseAdmin.from("usage").upsert(
    { user_id: userId, year_month: yearMonth, count: count + 1 },
    { onConflict: "user_id,year_month" }
  );
}

// ── Route handlers ───────────────────────────────────────────────────────────

function handleConfig(request, response) {
  sendJson(response, 200, {
    supabaseUrl: process.env.SUPABASE_URL || "",
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || "",
  });
}

async function handleAuthMe(request, response) {
  const user = await getAuthUser(request);
  if (!user) {
    sendJson(response, 401, { error: "Unauthorized" });
    return;
  }
  const profile = await ensureProfile(user);
  const usageCount = await getUsageCount(user.id);
  const isPro = profile.subscription_status === "active";
  sendJson(response, 200, {
    email: user.email,
    plan: isPro ? "pro" : "free",
    usageCount,
    usageLimit: isPro ? null : FREE_LIMIT,
  });
}

async function handleCheckout(request, response) {
  const user = await getAuthUser(request);
  if (!user) {
    sendJson(response, 401, { error: "Unauthorized" });
    return;
  }
  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_PRICE_ID) {
    sendJson(response, 500, { error: "Stripe is not configured." });
    return;
  }
  const appUrl = process.env.APP_URL || "http://localhost:3000";
  const params = new URLSearchParams({
    mode: "subscription",
    "payment_method_types[0]": "card",
    "line_items[0][price]": process.env.STRIPE_PRICE_ID,
    "line_items[0][quantity]": "1",
    customer_email: user.email,
    success_url: `${appUrl}/?checkout=success`,
    cancel_url: `${appUrl}/`,
    "metadata[user_id]": user.id,
  });
  const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });
  const data = await res.json();
  console.log("[checkout] Stripe status:", res.status, JSON.stringify(data).slice(0, 200));
  if (!res.ok) {
    const error = new Error(data.error?.message || "Stripe error");
    error.status = 502;
    throw error;
  }
  sendJson(response, 200, { url: data.url });
}

async function handleWebhook(request, response) {
  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    sendJson(response, 500, { error: "Webhook not configured." });
    return;
  }
  const body = await readBuffer(request);
  const sig = request.headers["stripe-signature"];

  // 手動でStripe署名を検証（SDKを使わない）
  let event;
  try {
    const parts = sig.split(",").reduce((acc, part) => {
      const [k, v] = part.split("=");
      if (k === "t") acc.t = v;
      if (k === "v1") acc.v1 = v;
      return acc;
    }, {});
    if (!parts.t || !parts.v1) throw new Error("Invalid signature header");
    const signedPayload = `${parts.t}.${body.toString()}`;
    const expected = crypto.createHmac("sha256", process.env.STRIPE_WEBHOOK_SECRET)
      .update(signedPayload).digest("hex");
    if (!crypto.timingSafeEqual(Buffer.from(parts.v1, "hex"), Buffer.from(expected, "hex"))) {
      throw new Error("Signature mismatch");
    }
    event = JSON.parse(body.toString());
  } catch (err) {
    console.error("[webhook error]", err.message);
    sendJson(response, 400, { error: `Webhook Error: ${err.message}` });
    return;
  }

  const obj = event.data.object;
  if (event.type === "checkout.session.completed") {
    const userId = obj.metadata?.user_id;
    if (userId && supabaseAdmin) {
      await supabaseAdmin.from("profiles").update({
        stripe_customer_id: obj.customer,
        stripe_subscription_id: obj.subscription,
        subscription_status: "active",
      }).eq("id", userId);
    }
  } else if (
    event.type === "customer.subscription.deleted" ||
    (event.type === "customer.subscription.updated" && obj.status !== "active")
  ) {
    if (supabaseAdmin) {
      await supabaseAdmin.from("profiles").update({
        subscription_status: "free",
      }).eq("stripe_customer_id", obj.customer);
    }
  }
  sendJson(response, 200, { received: true });
}

// ── Static files ─────────────────────────────────────────────────────────────

async function serveStatic(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  let requestedPath = url.pathname;
  if (requestedPath.endsWith("/")) requestedPath += "index.html";
  const filePath = path.normalize(path.join(ROOT, requestedPath));

  if (!filePath.startsWith(ROOT)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  try {
    const content = await fs.readFile(filePath);
    response.writeHead(200, {
      "Content-Type": contentTypes[path.extname(filePath)] || "application/octet-stream",
    });
    response.end(content);
  } catch {
    response.writeHead(404);
    response.end("Not found");
  }
}

// ── Main request handler ─────────────────────────────────────────────────────

async function handleRequest(request, response) {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const { method } = request;
    const { pathname } = url;

    if (method === "GET" && pathname === "/api/config") {
      handleConfig(request, response);
      return;
    }

    if (method === "GET" && pathname === "/api/auth/me") {
      await handleAuthMe(request, response);
      return;
    }

    if (method === "POST" && pathname === "/api/checkout") {
      try {
        await handleCheckout(request, response);
      } catch (error) {
        console.error("[checkout error]", error);
        sendJson(response, error.status || 500, { error: error.message });
      }
      return;
    }

    if (method === "POST" && pathname === "/api/webhook") {
      try {
        await handleWebhook(request, response);
      } catch (error) {
        sendJson(response, error.status || 500, { error: error.message });
      }
      return;
    }

    if (method === "POST" && pathname === "/api/extract-pdf") {
      try {
        const body = await readBuffer(request);
        const { filename, content } = parseMultipartFile(body, request.headers["content-type"] || "");
        const text = await extractPdfText(content);

        if (!text) {
          const error = new Error("PDFからテキストを抽出できませんでした。スキャンPDFの場合はOCR対応が必要です。");
          error.status = 422;
          throw error;
        }

        sendJson(response, 200, { filename, text, charCount: text.length });
      } catch (error) {
        sendJson(response, error.status || 500, { error: error.message });
      }
      return;
    }

    if (method === "POST" && pathname === "/api/generate") {
      try {
        if (supabaseAdmin) {
          const user = await getAuthUser(request);
          if (!user) {
            sendJson(response, 401, { error: "ログインが必要です。" });
            return;
          }
          const data = await readJson(request);
          const result = await generateLesson(data);
          sendJson(response, 200, result);
        } else {
          const data = await readJson(request);
          const result = await generateLesson(data);
          sendJson(response, 200, result);
        }
      } catch (error) {
        sendJson(response, error.status || 500, { error: error.message });
      }
      return;
    }

    if (method === "POST" && pathname === "/api/edit") {
      try {
        const data = await readJson(request);
        const result = await editLesson(data);
        sendJson(response, 200, result);
      } catch (error) {
        sendJson(response, error.status || 500, { error: error.message });
      }
      return;
    }

    if (method === "GET") {
      await serveStatic(request, response);
      return;
    }

    response.writeHead(405);
    response.end("Method not allowed");
  } catch (err) {
    console.error("[handleRequest uncaught]", err);
    if (!response.headersSent) {
      sendJson(response, 500, { error: err.message || "Internal server error" });
    }
  }
}

loadEnvFile().then(() => {
  initServices();
  const port = Number(process.env.PORT || 3000);
  http.createServer(handleRequest).listen(port, () => {
    console.log(`LessonAI is running at http://localhost:${port}`);
  });
});
