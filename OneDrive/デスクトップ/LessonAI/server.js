const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { PDFParse } = require("pdf-parse");

const ROOT = __dirname;

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".json": "application/json; charset=utf-8",
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

function extractOutputText(payload) {
  if (typeof payload.output_text === "string") return payload.output_text;

  const chunks = [];
  for (const item of payload.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && content.text) chunks.push(content.text);
    }
  }
  return chunks.join("\n").trim();
}

async function generateLesson(data) {
  if (!process.env.OPENAI_API_KEY) {
    const error = new Error("OPENAI_API_KEY is not set.");
    error.status = 400;
    throw error;
  }

  const model = process.env.OPENAI_MODEL || "gpt-5.5";
  const apiResponse = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      input: buildPrompt(data),
      max_output_tokens: 3500,
    }),
  });

  const rawText = await apiResponse.text();
  console.log("[OpenAI generate status]", apiResponse.status);
  console.log("[OpenAI generate response]", rawText.slice(0, 500));

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

  return extractOutputText(payload);
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
  if (!process.env.OPENAI_API_KEY) {
    const error = new Error("OPENAI_API_KEY is not set.");
    error.status = 400;
    throw error;
  }

  if (!data.markdown || !data.instruction) {
    const error = new Error("教材本文と修正指示が必要です。");
    error.status = 400;
    throw error;
  }

  const model = process.env.OPENAI_MODEL || "gpt-5.5";
  const apiResponse = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      input: buildEditPrompt(data),
      max_output_tokens: 3500,
    }),
  });

  const payload = await apiResponse.json().catch(() => ({}));

  if (!apiResponse.ok) {
    const message = payload.error?.message || "OpenAI API request failed.";
    const error = new Error(message);
    error.status = apiResponse.status;
    throw error;
  }

  return extractOutputText(payload);
}

async function serveStatic(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
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

async function handleRequest(request, response) {
  try {
  if (request.method === "POST" && request.url === "/api/extract-pdf") {
    try {
      const body = await readBuffer(request);
      const { filename, content } = parseMultipartFile(body, request.headers["content-type"] || "");
      const text = await extractPdfText(content);

      if (!text) {
        const error = new Error("PDFからテキストを抽出できませんでした。スキャンPDFの場合はOCR対応が必要です。");
        error.status = 422;
        throw error;
      }

      sendJson(response, 200, {
        filename,
        text,
        charCount: text.length,
      });
    } catch (error) {
      sendJson(response, error.status || 500, { error: error.message });
    }
    return;
  }

  if (request.method === "POST" && request.url === "/api/generate") {
    try {
      const data = await readJson(request);
      const markdown = await generateLesson(data);
      sendJson(response, 200, { markdown, model: process.env.OPENAI_MODEL || "gpt-5.5" });
    } catch (error) {
      sendJson(response, error.status || 500, { error: error.message });
    }
    return;
  }

  if (request.method === "POST" && request.url === "/api/edit") {
    try {
      const data = await readJson(request);
      const markdown = await editLesson(data);
      sendJson(response, 200, { markdown, model: process.env.OPENAI_MODEL || "gpt-5.5" });
    } catch (error) {
      sendJson(response, error.status || 500, { error: error.message });
    }
    return;
  }

  if (request.method === "GET") {
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
  const port = Number(process.env.PORT || 3000);
  http.createServer(handleRequest).listen(port, () => {
    console.log(`LessonAI is running at http://localhost:${port}`);
  });
});
