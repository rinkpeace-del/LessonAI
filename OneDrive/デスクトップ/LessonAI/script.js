// ── Auth state ───────────────────────────────────────────────────────────────
let supabaseClient = null;
let currentSession = null;
let currentUser = null;

const loginButton = document.querySelector("#login-button");
const userInfo = document.querySelector("#user-info");
const userEmailEl = document.querySelector("#user-email");
const usageBadge = document.querySelector("#usage-badge");
const upgradeButton = document.querySelector("#upgrade-button");
const logoutButton = document.querySelector("#logout-button");
const upgradeModal = document.querySelector("#upgrade-modal");
const goProButton = document.querySelector("#go-pro-button");
const closeModalButton = document.querySelector("#close-modal-button");

async function initAuth() {
  try {
    const res = await fetch("/api/config");
    const cfg = await res.json();
    if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) return;

    supabaseClient = supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);

    supabaseClient.auth.onAuthStateChange(async (event, session) => {
      currentSession = session;
      currentUser = session?.user || null;
      await refreshUserInfo();
    });

    const { data: { session } } = await supabaseClient.auth.getSession();
    currentSession = session;
    currentUser = session?.user || null;
    await refreshUserInfo();
  } catch (e) {
    console.warn("[auth] init failed", e);
  }
}

async function refreshUserInfo() {
  if (!currentSession) {
    loginButton.classList.remove("hidden");
    userInfo.classList.add("hidden");
    return;
  }

  loginButton.classList.add("hidden");
  userInfo.classList.remove("hidden");
  userEmailEl.textContent = currentUser?.email || "";

  try {
    const res = await fetch("/api/auth/me", {
      headers: { Authorization: `Bearer ${currentSession.access_token}` },
    });
    if (res.ok) {
      const data = await res.json();
      if (data.usageLimit !== null) {
        usageBadge.textContent = `今月 ${data.usageCount}/${data.usageLimit} 回`;
        usageBadge.classList.toggle("usage-warn", data.usageCount >= data.usageLimit);
        upgradeButton.classList.remove("hidden");
      } else {
        usageBadge.textContent = "Pro";
        upgradeButton.classList.add("hidden");
      }
    }
  } catch {
    // ignore
  }
}

function getAuthHeaders() {
  if (!currentSession) return {};
  return { Authorization: `Bearer ${currentSession.access_token}` };
}

function showUpgradeModal() {
  upgradeModal.classList.remove("hidden");
}

function hideUpgradeModal() {
  upgradeModal.classList.add("hidden");
}

loginButton?.addEventListener("click", async () => {
  if (!supabaseClient) return;
  await supabaseClient.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: window.location.origin },
  });
});

logoutButton?.addEventListener("click", async () => {
  if (supabaseClient) await supabaseClient.auth.signOut();
  currentSession = null;
  currentUser = null;
  window.location.reload();
});

upgradeButton?.addEventListener("click", showUpgradeModal);
closeModalButton?.addEventListener("click", hideUpgradeModal);

goProButton?.addEventListener("click", async () => {
  if (!currentSession) { showUpgradeModal(); return; }
  try {
    const res = await fetch("/api/checkout", {
      method: "POST",
      headers: getAuthHeaders(),
    });
    const data = await res.json();
    if (data.url) window.location.href = data.url;
  } catch (e) {
    console.error(e);
  }
});

// ── Main UI ───────────────────────────────────────────────────────────────────
const form = document.querySelector("#lesson-form");
const studentPanel = document.querySelector("#student");
const teacherPanel = document.querySelector("#teacher");
const outputTitle = document.querySelector("#output-title");
const copyButton = document.querySelector("#copy-button");
const editButton = document.querySelector("#edit-button");
const aiEditButton = document.querySelector("#ai-edit-button");
const saveEditButton = document.querySelector("#save-edit-button");
const cancelEditButton = document.querySelector("#cancel-edit-button");
const studentPdfButton = document.querySelector("#student-pdf-button");
const teacherPdfButton = document.querySelector("#teacher-pdf-button");
const generateLabel = document.querySelector("#generate-label");
const statusMessage = document.querySelector("#status-message");
const sourcePdfInput = document.querySelector("#source-pdf");
const pdfStatus = document.querySelector("#pdf-status");
const historyList = document.querySelector("#history-list");
const clearHistoryButton = document.querySelector("#clear-history-button");
const aiEditPanel = document.querySelector("#ai-edit-panel");
const aiEditInstruction = document.querySelector("#ai-edit-instruction");
const runAiEditButton = document.querySelector("#run-ai-edit-button");
const closeAiEditButton = document.querySelector("#close-ai-edit-button");
const tabs = document.querySelectorAll(".tab");

let currentMarkdown = "";
let currentStudentMarkdown = "";
let currentTeacherMarkdown = "";
let currentPrompt = "";
let activeTabId = "student";
let extractedPdf = null;
let isEditing = false;
let editingOriginal = "";

const HISTORY_KEY = "lessonai.history.v1";
const HISTORY_LIMIT = 5;

const materialLabels = {
  lesson: "授業案",
  worksheet: "ワークシート",
  quiz: "小テスト",
  rubric: "評価ルーブリック",
};

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}


function markdownToHtml(markdown) {
  const stripped = markdown.replace(/^```[\w]*\r?\n([\s\S]*?)\r?\n```\s*$/m, "$1").trim();
  return marked.parse(stripped, { gfm: true, breaks: false });
}

function splitLessonMarkdown(markdown, audiences = ["student", "teacher"]) {
  if (audiences.includes("teacher") && !audiences.includes("student")) {
    return {
      student: "",
      teacher: markdown,
    };
  }

  if (audiences.includes("student") && !audiences.includes("teacher")) {
    return {
      student: markdown,
      teacher: "",
    };
  }

  const teacherHeading = markdown.match(/^#\s*先生用ガイド\s*$/im);

  if (!teacherHeading) {
    return {
      student: markdown,
      teacher: "# 先生用ガイド\n\n## 確認メモ\n生成結果から先生用ガイドを分割できませんでした。必要に応じて再生成してください。",
    };
  }

  const student = markdown.slice(0, teacherHeading.index).trim();
  const teacher = markdown.slice(teacherHeading.index).trim();

  return {
    student: student || "# 教材タイトル\n\n生成内容が空です。再生成してください。",
    teacher,
  };
}

function getSelectedAudiences() {
  const selected = [...document.querySelectorAll("input[name='audiences']:checked")].map(
    (input) => input.value,
  );

  return selected.length ? selected : ["student"];
}

function readHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
  } catch {
    return [];
  }
}

function writeHistory(items) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(items.slice(0, HISTORY_LIMIT)));
}

function formatHistoryDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, "0")}:${String(
    date.getMinutes(),
  ).padStart(2, "0")}`;
}

function renderHistory() {
  const items = readHistory();

  if (!items.length) {
    historyList.innerHTML = `<p class="history-empty">まだ履歴はありません。</p>`;
    return;
  }

  historyList.innerHTML = items
    .map(
      (item) => `
        <button class="history-item" type="button" data-history-id="${escapeHtml(item.id)}">
          <span class="history-title">${escapeHtml(item.topic || "無題の教材")}</span>
          <span class="history-meta">${escapeHtml(item.grade || "")} / ${escapeHtml(item.level || "")} / ${formatHistoryDate(
            item.createdAt,
          )}</span>
        </button>
      `,
    )
    .join("");
}

function saveCurrentHistory(data, model) {
  const item = {
    id: `${Date.now()}`,
    createdAt: new Date().toISOString(),
    model,
    subject: data.subject,
    grade: data.grade,
    topic: data.topic,
    level: data.level,
    duration: data.duration,
    requirements: data.requirements,
    audiences: data.audiences,
    sourceFilename: data.sourceFilename || "",
    studentMarkdown: currentStudentMarkdown,
    teacherMarkdown: currentTeacherMarkdown,
  };
  const items = readHistory().filter((historyItem) => historyItem.topic !== item.topic);
  writeHistory([item, ...items]);
  renderHistory();
}

function loadHistoryItem(id) {
  const item = readHistory().find((historyItem) => historyItem.id === id);
  if (!item) return;

  outputTitle.textContent = item.topic || "教材";
  currentStudentMarkdown = item.studentMarkdown || "";
  currentTeacherMarkdown = item.teacherMarkdown || "";
  currentMarkdown = `${currentStudentMarkdown}\n\n${currentTeacherMarkdown}`.trim();
  renderLessonSections(currentStudentMarkdown, currentTeacherMarkdown);
  syncAudienceUi(item.audiences || ["student", "teacher"]);
  statusMessage.textContent = `${formatHistoryDate(item.createdAt)} の履歴を表示しています。`;
  statusMessage.classList.remove("error");
}

async function extractSelectedPdf() {
  const file = sourcePdfInput.files?.[0];

  if (!file) {
    extractedPdf = null;
    return null;
  }

  if (extractedPdf?.name === file.name && extractedPdf?.size === file.size) {
    return extractedPdf;
  }

  const formData = new FormData();
  formData.append("file", file);

  pdfStatus.textContent = "PDFを読み取っています...";
  const response = await fetch("/api/extract-pdf", {
    method: "POST",
    body: formData,
  });
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.error || "PDFの読み取りに失敗しました。");
  }

  extractedPdf = {
    name: file.name,
    size: file.size,
    filename: payload.filename,
    text: payload.text,
    charCount: payload.charCount,
  };
  pdfStatus.textContent = `${file.name} を読み取りました（${payload.charCount.toLocaleString()}文字）。`;
  return extractedPdf;
}

function getFormData() {
  const selectedAudiences = getSelectedAudiences();

  return {
    subject: document.querySelector("#subject").value,
    grade: document.querySelector("#grade").value,
    topic: document.querySelector("#topic").value.trim() || "新しい単元",
    level: document.querySelector("#level").value,
    duration: document.querySelector("#duration").value,
    requirements: document.querySelector("#requirements").value.trim(),
    materials: ["lesson", "worksheet", "quiz"],
    audiences: selectedAudiences,
    model: document.querySelector("#ai-model").value,
  };
}

function createLessonPlan(data) {
  return [
    `導入: ${data.topic}を使う場面を1つ示し、生徒の既有知識を引き出す。`,
    `説明: ${data.level}レベルに合わせて、重要語句・型・考え方を3点に絞って確認する。`,
    "練習: 個人で基本問題に取り組み、ペアで答えの根拠を説明する。",
    "活用: 自分の生活や身近な例に置き換えて、短いアウトプットを作る。",
    "振り返り: 今日できるようになったことと、まだ迷うことを1行で書く。",
  ];
}

function createWorksheet(data) {
  return [
    `確認問題: ${data.topic}の基本ルールを空欄補充で3問解く。`,
    "選択問題: 正しい答えを選び、なぜそれを選んだかを短く書く。",
    "並べ替え問題: 語句や手順を正しい順番に直す。",
    "ペア活動: 相手の答えを聞き、よい表現や考え方を1つメモする。",
    "発展問題: 今日の内容を使って、自分だけの例を1つ作る。",
  ];
}

function createQuiz(data) {
  return [
    `Q1. ${data.topic}で最も大切なポイントを1つ選ぶ問題。`,
    "Q2. 例文や式の誤りを見つけて直す問題。",
    "Q3. 基本文を完成させる、または途中式を補う問題。",
    "Q4. 学んだ内容を別の場面に当てはめる問題。",
    "Q5. 今日の理解度を自分の言葉で説明する記述問題。",
  ];
}

function createRubric(data) {
  return [
    `A: ${data.topic}の考え方を理解し、初めて見る場面にも正しく使える。`,
    "B: 基本問題を解き、理由や手順をおおむね説明できる。",
    "C: 例やヒントがあれば、基本的な問題に取り組める。",
    "支援: 用語カード、例文リスト、途中まで書いた解答欄を用意する。",
  ];
}

function buildMaterials(data) {
  const makers = {
    lesson: createLessonPlan,
    worksheet: createWorksheet,
    quiz: createQuiz,
    rubric: createRubric,
  };

  return data.materials.map((type) => ({
    type,
    title: materialLabels[type],
    items: makers[type](data),
  }));
}

function buildPrompt(data) {
  const materialText = data.materials.map((type) => materialLabels[type]).join("、");
  const audienceText = data.audiences.includes("student") && data.audiences.includes("teacher")
    ? "生徒に配る教材と先生用ガイド"
    : data.audiences.includes("teacher")
      ? "先生用ガイドのみ"
      : "生徒に配る教材のみ";
  const sourceLine = data.sourceFilename
    ? `\n参考PDF: ${data.sourceFilename}（抽出済みテキストを教材作成に使用）`
    : "";
  return `あなたは中学生向け英語教材を作る熟練の編集者です。
以下の条件で、塾の授業ですぐ使える教材を作成してください。

教科: ${data.subject}
対象: ${data.grade}
単元・テーマ: ${data.topic}
難易度: ${data.level}
授業時間: ${data.duration}
作成物: ${materialText}
出力形式: ${audienceText}
条件: ${data.requirements || "特になし"}
${sourceLine}

出力条件:
- 必ずMarkdownで出力する
- 生徒用を出力する場合は、生徒に配る部分から始める
- 生徒用の教材タイトルに「生徒用プリント」と書かない
- 生徒用には解答や先生向けメモを入れない
- 先生用を出力する場合は、必ず「# 先生用ガイド」を入れる
- 先生用には解答、解説、時間配分、つまずきポイント、声かけ例を入れる
- 基礎、標準、発展の3段階が見えるようにする`;
}

function renderCards(materials) {
  studentPanel.innerHTML = materials
    .map(
      (material) => `
        <section class="material-card">
          <h3><span class="tag"></span>${material.title}</h3>
          <ol>
            ${material.items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
          </ol>
        </section>
      `,
    )
    .join("");
}

function renderMarkdownOutput(markdown, targetPanel, title) {
  targetPanel.innerHTML = `
    <section class="material-card generated-material">
      <h3><span class="tag"></span>${escapeHtml(title)}</h3>
      <div class="markdown-output">${markdownToHtml(markdown)}</div>
    </section>
  `;
}

function renderLessonSections(studentMarkdown, teacherMarkdown) {
  renderMarkdownOutput(studentMarkdown, studentPanel, "教材プリント");
  renderMarkdownOutput(teacherMarkdown, teacherPanel, "先生用ガイド");
}

function getActivePanel() {
  return activeTabId === "teacher" ? teacherPanel : studentPanel;
}

function setActiveMarkdown(markdown) {
  if (activeTabId === "teacher") {
    currentTeacherMarkdown = markdown;
  } else {
    currentStudentMarkdown = markdown;
  }
  currentMarkdown = `${currentStudentMarkdown}\n\n${currentTeacherMarkdown}`.trim();
}

function renderActivePanel() {
  if (activeTabId === "teacher") {
    renderMarkdownOutput(currentTeacherMarkdown, teacherPanel, "先生用ガイド");
  } else {
    renderMarkdownOutput(currentStudentMarkdown, studentPanel, "教材プリント");
  }
}

function setEditingState(editing) {
  isEditing = editing;
  editButton.classList.toggle("hidden", editing);
  aiEditButton.classList.toggle("hidden", editing);
  saveEditButton.classList.toggle("hidden", !editing);
  cancelEditButton.classList.toggle("hidden", !editing);
  copyButton.disabled = editing;
  studentPdfButton.disabled = editing;
  teacherPdfButton.disabled = editing;
}

function toggleAiEditPanel(show) {
  aiEditPanel.classList.toggle("hidden", !show);
  if (show) {
    aiEditInstruction.focus();
  }
}

function startEditing() {
  editingOriginal = getActiveMarkdown();
  const panel = getActivePanel();
  panel.innerHTML = `
    <section class="material-card editor-card">
      <h3><span class="tag"></span>${activeTabId === "teacher" ? "先生用ガイドを編集" : "教材プリントを編集"}</h3>
      <textarea id="markdown-editor" class="markdown-editor">${escapeHtml(editingOriginal)}</textarea>
    </section>
  `;
  setEditingState(true);
}

function saveEditing() {
  const editor = document.querySelector("#markdown-editor");
  if (!editor) return;
  setActiveMarkdown(editor.value);
  renderActivePanel();
  setEditingState(false);
  statusMessage.textContent = "編集内容を反映しました。";
  statusMessage.classList.remove("error");
}

function cancelEditing() {
  setActiveMarkdown(editingOriginal);
  renderActivePanel();
  setEditingState(false);
}

function showPanel(tabId) {
  if (isEditing) {
    saveEditing();
  }
  activeTabId = tabId;
  tabs.forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.tab === tabId);
  });
  document.querySelectorAll(".result-panel").forEach((panel) => {
    panel.classList.toggle("hidden", panel.id !== tabId);
  });
}

function syncAudienceUi(audiences = getSelectedAudiences()) {
  const wantsStudent = audiences.includes("student");
  const wantsTeacher = audiences.includes("teacher");

  document.querySelector('[data-tab="student"]').classList.toggle("hidden", !wantsStudent);
  document.querySelector('[data-tab="teacher"]').classList.toggle("hidden", !wantsTeacher);
  studentPdfButton.classList.toggle("hidden", !wantsStudent);
  teacherPdfButton.classList.toggle("hidden", !wantsTeacher);
  editButton.disabled = !wantsStudent && !wantsTeacher;
  aiEditButton.disabled = !wantsStudent && !wantsTeacher;

  if (!audiences.includes(activeTabId)) {
    showPanel(wantsStudent ? "student" : "teacher");
  } else {
    showPanel(activeTabId);
  }
}

function toMarkdown(data, materials) {
  const lines = [
    `# ${data.topic}`,
    "",
    `- 教科: ${data.subject}`,
    `- 対象: ${data.grade}`,
    `- 難易度: ${data.level}`,
    `- 授業時間: ${data.duration}`,
    `- 条件: ${data.requirements || "特になし"}`,
    "",
  ];

  materials.forEach((material) => {
    lines.push(`## ${material.title}`);
    material.items.forEach((item, index) => lines.push(`${index + 1}. ${item}`));
    lines.push("");
  });

  return lines.join("\n");
}

function toStudentMarkdown(data, materials) {
  const lines = [
    `## ${data.topic}`,
    "",
    "## 今日のゴール",
    `- ${data.topic}の基本を理解する`,
    "- 例を見ながら練習問題に取り組む",
    "- 最後に自分で1問解けるようにする",
    "",
  ];

  materials.forEach((material) => {
    if (material.type === "rubric") return;
    lines.push(`## ${material.title}`);
    material.items.forEach((item, index) => lines.push(`${index + 1}. ${item}`));
    lines.push("");
  });

  return lines.join("\n");
}

function toTeacherMarkdown(data) {
  return [
    "# 先生用ガイド",
    "",
    "## 授業のねらい",
    `- ${data.grade}の生徒が、${data.topic}を授業内で使える状態にする。`,
    "",
    "## 時間配分",
    `- 導入: 5分`,
    "- 説明: 10分",
    "- 練習: 20分",
    "- 確認と振り返り: 10分",
    "",
    "## つまずきポイント",
    "- 用語やルールを丸暗記しようとして、使う場面と結びつかない。",
    "- 問題文の指示を読み飛ばして、形式を間違える。",
    "",
    "## 声かけ例",
    "- まずは例文と同じ形で考えてみよう。",
    "- 迷ったら主語と動詞に印をつけよう。",
    "",
    "## 解答メモ",
    "- 生成された問題を授業前に確認し、クラスの進度に合わせて調整してください。",
  ].join("\n");
}

function updateOutput() {
  const data = getFormData();
  const materials = buildMaterials(data);
  syncAudienceUi(data.audiences);

  outputTitle.textContent = data.topic;
  currentPrompt = buildPrompt(data);
  currentStudentMarkdown = toStudentMarkdown(data, materials);
  currentTeacherMarkdown = toTeacherMarkdown(data);
  currentMarkdown = `${currentStudentMarkdown}\n\n${currentTeacherMarkdown}`;

  renderLessonSections(currentStudentMarkdown, currentTeacherMarkdown);
}

async function generateWithAi() {
  const data = getFormData();
  const materials = buildMaterials(data);
  syncAudienceUi(data.audiences);

  outputTitle.textContent = data.topic;
  currentPrompt = buildPrompt(data);
  currentStudentMarkdown = toStudentMarkdown(data, materials);
  currentTeacherMarkdown = toTeacherMarkdown(data);
  currentMarkdown = `${currentStudentMarkdown}\n\n${currentTeacherMarkdown}`;

  const submitButton = form.querySelector("button[type='submit']");
  submitButton.disabled = true;
  generateLabel.textContent = "生成中...";
  statusMessage.textContent = "AIが教材を作成しています。少しだけ待ってください。";
  statusMessage.classList.remove("error");

  try {
    const pdf = await extractSelectedPdf();
    if (pdf) {
      data.sourceFilename = pdf.filename || pdf.name;
      data.sourceText = pdf.text.slice(0, 12000);
      currentPrompt = buildPrompt(data);
    }

    if (!currentSession && supabaseClient) {
      statusMessage.textContent = "ログインが必要です。";
      statusMessage.classList.add("error");
      return;
    }

    const response = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...getAuthHeaders() },
      body: JSON.stringify({
        ...data,
        materials: data.materials.map((type) => materialLabels[type] || type),
        audiences: data.audiences,
      }),
    });
    const payload = await response.json();

    if (response.status === 402) {
      showUpgradeModal();
      throw new Error(payload.error || "利用制限に達しました。");
    }

    if (response.status === 401) {
      statusMessage.textContent = "ログインが必要です。";
      statusMessage.classList.add("error");
      return;
    }

    if (!response.ok) {
      throw new Error(payload.error || "教材生成に失敗しました。");
    }

    currentMarkdown = payload.markdown;
    const sections = splitLessonMarkdown(payload.markdown, data.audiences);
    currentStudentMarkdown = sections.student;
    currentTeacherMarkdown = sections.teacher;
    renderLessonSections(currentStudentMarkdown, currentTeacherMarkdown);
    saveCurrentHistory(data, payload.model);
    statusMessage.textContent = `${payload.model}で生成しました。`;
    refreshUserInfo();
  } catch (error) {
    renderLessonSections(currentStudentMarkdown, currentTeacherMarkdown);
    statusMessage.textContent = `AI生成に失敗したため、ローカルのたたき台を表示しています。${error.message}`;
    statusMessage.classList.add("error");
    if (sourcePdfInput.files?.[0]) {
      pdfStatus.textContent = error.message;
      pdfStatus.classList.add("error");
    }
  } finally {
    submitButton.disabled = false;
    generateLabel.textContent = "AIで教材を生成";
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  generateWithAi();
});

tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    showPanel(tab.dataset.tab);
  });
});

document.querySelectorAll("input[name='audiences']").forEach((input) => {
  input.addEventListener("change", () => {
    syncAudienceUi(getSelectedAudiences());
  });
});

sourcePdfInput.addEventListener("change", () => {
  extractedPdf = null;
  const file = sourcePdfInput.files?.[0];
  pdfStatus.textContent = file
    ? `${file.name} を選択しました。生成時に読み取ります。`
    : "PDFを追加すると、その内容を参考に教材を作ります。";
  pdfStatus.classList.remove("error");
});

historyList.addEventListener("click", (event) => {
  const item = event.target.closest(".history-item");
  if (!item) return;
  loadHistoryItem(item.dataset.historyId);
});

clearHistoryButton.addEventListener("click", () => {
  localStorage.removeItem(HISTORY_KEY);
  renderHistory();
});

function getActiveMarkdown() {
  if (activeTabId === "teacher") return currentTeacherMarkdown;
  return currentStudentMarkdown;
}

async function runAiEdit() {
  if (isEditing) {
    saveEditing();
  }

  const instruction = aiEditInstruction.value.trim();
  if (!instruction) {
    statusMessage.textContent = "AIへの修正指示を入力してください。";
    statusMessage.classList.add("error");
    return;
  }

  runAiEditButton.disabled = true;
  aiEditButton.disabled = true;
  statusMessage.textContent = "AIが教材を修正しています。";
  statusMessage.classList.remove("error");

  try {
    const response = await fetch("/api/edit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        markdown: getActiveMarkdown(),
        instruction,
        targetLabel: activeTabId === "teacher" ? "先生用ガイド" : "生徒用教材",
      }),
    });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || "AI修正に失敗しました。");
    }

    setActiveMarkdown(payload.markdown);
    renderActivePanel();
    toggleAiEditPanel(false);
    aiEditInstruction.value = "";
    statusMessage.textContent = `${payload.model}で修正しました。`;
  } catch (error) {
    statusMessage.textContent = error.message;
    statusMessage.classList.add("error");
  } finally {
    runAiEditButton.disabled = false;
    aiEditButton.disabled = false;
  }
}

copyButton.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(getActiveMarkdown());
    copyButton.textContent = "Copied";
  } catch {
    copyButton.textContent = "Copy failed";
  }
  window.setTimeout(() => {
    copyButton.textContent = "Copy";
  }, 1200);
});

editButton.addEventListener("click", () => {
  startEditing();
});

aiEditButton.addEventListener("click", () => {
  toggleAiEditPanel(true);
});

saveEditButton.addEventListener("click", () => {
  saveEditing();
});

cancelEditButton.addEventListener("click", () => {
  cancelEditing();
});

runAiEditButton.addEventListener("click", () => {
  runAiEdit();
});

closeAiEditButton.addEventListener("click", () => {
  toggleAiEditPanel(false);
});

function printMarkdown(markdown, title, label) {
  const data = getFormData();
  const printWindow = window.open("", "_blank", "width=900,height=1200");

  if (!printWindow) {
    statusMessage.textContent = "PDF用の印刷画面を開けませんでした。ポップアップ設定を確認してください。";
    statusMessage.classList.add("error");
    return;
  }

  printWindow.document.write(`
    <!doctype html>
    <html lang="ja">
      <head>
        <meta charset="UTF-8" />
        <title>${escapeHtml(title || data.topic || "lesson-material")} - LessonAI</title>
        <style>
          @page {
            margin: 14mm;
          }

          * {
            box-sizing: border-box;
          }

          body {
            margin: 0;
            color: #172026;
            font-family: "Yu Gothic", "Hiragino Kaku Gothic ProN", Meiryo, system-ui, sans-serif;
            line-height: 1.75;
          }

          header {
            border-bottom: 2px solid #172026;
            margin-bottom: 14px;
            padding-bottom: 10px;
          }

          .eyebrow {
            margin: 0 0 4px;
            color: #65717a;
            font-size: 12px;
            font-weight: 700;
          }

          h1 {
            margin: 0;
            font-size: 22px;
            line-height: 1.35;
          }

          h2 {
            margin: 20px 0 8px;
            padding-bottom: 6px;
            border-bottom: 1px solid #d7dee5;
            font-size: 20px;
            line-height: 1.35;
          }

          h3 {
            margin: 16px 0 8px;
            font-size: 17px;
            line-height: 1.35;
          }

          h4 {
            margin: 14px 0 6px;
            color: #095f58;
            font-size: 15px;
            line-height: 1.35;
          }

          p {
            margin: 8px 0;
          }

          ul,
          ol {
            margin: 8px 0 12px;
            padding-left: 22px;
          }

          li + li {
            margin-top: 3px;
          }

          strong {
            color: #095f58;
          }
        </style>
      </head>
      <body>
        <header>
          <p class="eyebrow">LessonAI / ${escapeHtml(label)}</p>
          <h1>${escapeHtml(title || data.topic || "教材プリント")}</h1>
        </header>
        <main>${markdownToHtml(markdown)}</main>
      </body>
    </html>
  `);
  printWindow.document.close();
  printWindow.focus();
  printWindow.setTimeout(() => {
    printWindow.print();
  }, 250);
}

studentPdfButton.addEventListener("click", () => {
  printMarkdown(currentStudentMarkdown, getFormData().topic, "生徒用プリント");
});

teacherPdfButton.addEventListener("click", () => {
  printMarkdown(currentTeacherMarkdown, `${getFormData().topic} 先生用`, "先生用ガイド");
});

updateOutput();
renderHistory();
initAuth();
