const state = {
  status: null,
  threads: [],
  thread: null,
  selectedThreadId: null,
  showMetaMessages: false,
  menuOpen: false,
  liveDrafts: new Map(),
  pendingRequests: new Map(),
  ws: null,
  sending: false,
};

const elements = {
  bridgeStatus: document.getElementById("bridgeStatus"),
  threadMeta: document.getElementById("threadMeta"),
  threadSelect: document.getElementById("threadSelect"),
  menuButton: document.getElementById("menuButton"),
  menuCloseButton: document.getElementById("menuCloseButton"),
  menuPanel: document.getElementById("menuPanel"),
  menuOverlay: document.getElementById("menuOverlay"),
  toggleDetailsButton: document.getElementById("toggleDetailsButton"),
  messages: document.getElementById("messages"),
  emptyState: document.getElementById("emptyState"),
  composer: document.getElementById("composer"),
  promptInput: document.getElementById("promptInput"),
  composerHint: document.getElementById("composerHint"),
  sendButton: document.getElementById("sendButton"),
  refreshThreadsButton: document.getElementById("refreshThreadsButton"),
  requestDialog: document.getElementById("requestDialog"),
  requestForm: document.getElementById("requestForm"),
  requestEyebrow: document.getElementById("requestEyebrow"),
  requestTitle: document.getElementById("requestTitle"),
  requestDescription: document.getElementById("requestDescription"),
  requestBody: document.getElementById("requestBody"),
  requestActions: document.getElementById("requestActions"),
};

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "short",
  timeStyle: "short",
});

const SCROLL_BOTTOM_THRESHOLD_PX = 72;

function textFromUserInput(content) {
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((item) => {
      if (item.type === "text") {
        return item.text;
      }
      if (item.type === "image") {
        return "[image]";
      }
      if (item.type === "localImage") {
        return `[image: ${item.path}]`;
      }
      if (item.type === "skill") {
        return `[skill: ${item.name}]`;
      }
      if (item.type === "mention") {
        return `[mention: ${item.name}]`;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function pickFirstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function formatReasoningEffort(value) {
  const normalized = String(value || "").toLowerCase();
  if (!normalized) {
    return null;
  }

  const labels = {
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "extra high",
  };

  if (!labels[normalized]) {
    return value;
  }

  return normalized === labels[normalized]
    ? labels[normalized]
    : `${labels[normalized]} (${normalized})`;
}

function collectChangedFilePath(change) {
  if (!change || typeof change !== "object") {
    return null;
  }

  return pickFirstString(
    change.path,
    change.filePath,
    change.targetPath,
    change.newPath,
    change.to,
    change.file
  );
}

function extractTurnRunProfile(turn) {
  const context = turn?.context || {};
  const metadata = turn?.metadata || {};
  const config = turn?.config || {};

  const model = pickFirstString(
    turn?.model,
    turn?.modelName,
    turn?.agentModel,
    context.model,
    metadata.model,
    config.model
  );

  const effortRaw = pickFirstString(
    turn?.effort,
    turn?.reasoningEffort,
    turn?.reasoning_effort,
    context.effort,
    context.reasoningEffort,
    context.reasoning_effort,
    metadata.effort,
    metadata.reasoningEffort,
    metadata.reasoning_effort,
    config.effort,
    config.reasoningEffort,
    config.reasoning_effort
  );

  return {
    model,
    effort: formatReasoningEffort(effortRaw),
  };
}

function normalizePlanText(value) {
  const text = String(value || "").trim();
  return text || null;
}

function flattenThread(thread) {
  const rows = [];

  for (const turn of thread.turns || []) {
    const turnPlans = [];
    const changedFiles = new Set();
    let changedFileCount = 0;
    const runProfile = extractTurnRunProfile(turn);

    for (const item of turn.items || []) {
      if (item.type === "userMessage") {
        rows.push({
          kind: "user",
          text: textFromUserInput(item.content),
          id: item.id,
        });
        continue;
      }

      if (item.type === "agentMessage") {
        rows.push({
          kind: "assistant",
          text: item.text,
          id: item.id,
        });
        continue;
      }

      if (item.type === "plan") {
        const text = normalizePlanText(item.text);
        if (text) {
          turnPlans.push(text);
        }
        continue;
      }

      if (item.type === "reasoning") {
        rows.push({
          kind: "meta",
          label: "Reasoning",
          text: (item.summary || item.content || []).join("\n"),
          id: item.id,
        });
        continue;
      }

      if (item.type === "commandExecution") {
        const output = item.aggregatedOutput ? `\n\n${item.aggregatedOutput}` : "";
        rows.push({
          kind: "meta",
          label: "Command",
          text: `${item.command}${output}`,
          id: item.id,
        });
        continue;
      }

      if (item.type === "fileChange") {
        const changes = Array.isArray(item.changes) ? item.changes : [];
        changedFileCount += changes.length;

        for (const change of changes) {
          const filePath = collectChangedFilePath(change);
          if (filePath) {
            changedFiles.add(filePath);
          }
        }
        continue;
      }

      if (item.type === "dynamicToolCall" || item.type === "mcpToolCall" || item.type === "webSearch") {
        rows.push({
          kind: "meta",
          label: "Tool",
          text: JSON.stringify(item, null, 2),
          id: item.id,
        });
      }
    }

    if (turn.status?.type === "failed" && turn.error?.message) {
      rows.push({
        kind: "meta",
        label: "Turn failed",
        text: turn.error.message,
        id: `${turn.id}-error`,
      });
    }

    const summaryBlocks = [];

    if (runProfile.model || runProfile.effort) {
      const runLines = [];
      if (runProfile.model) {
        runLines.push(`Model: ${runProfile.model}`);
      }
      if (runProfile.effort) {
        runLines.push(`Reasoning effort: ${runProfile.effort}`);
      }
      summaryBlocks.push(runLines.join("\n"));
    }

    if (turnPlans.length) {
      const uniquePlans = Array.from(new Set(turnPlans));
      summaryBlocks.push(`Codex tasks:\n${uniquePlans.join("\n\n")}`);
    }

    if (changedFiles.size || changedFileCount > 0) {
      const fileList = Array.from(changedFiles).sort();
      if (fileList.length) {
        summaryBlocks.push(`Changed files:\n${fileList.map((file) => `- ${file}`).join("\n")}`);
      } else {
        summaryBlocks.push(`Changed files: ${changedFileCount} update(s)`);
      }
    }

    if (summaryBlocks.length) {
      rows.push({
        kind: "meta",
        label: "Turn summary",
        text: summaryBlocks.join("\n\n"),
        id: `${turn.id}-summary`,
      });
    }
  }

  return rows;
}

function setBridgeStatus(label, tone = "muted") {
  elements.bridgeStatus.textContent = label;
  elements.bridgeStatus.dataset.tone = tone;
}

function setMenuOpen(open) {
  state.menuOpen = Boolean(open);
  if (state.menuOpen) {
    elements.menuPanel.hidden = false;
    elements.menuOverlay.hidden = false;
    elements.menuPanel.classList.add("is-open");
    elements.menuButton.setAttribute("aria-expanded", "true");
    document.body.classList.add("menu-open");
    return;
  }

  elements.menuPanel.classList.remove("is-open");
  elements.menuPanel.hidden = true;
  elements.menuOverlay.hidden = true;
  elements.menuButton.setAttribute("aria-expanded", "false");
  document.body.classList.remove("menu-open");
}

function toggleMenu() {
  setMenuOpen(!state.menuOpen);
}

function shouldRenderMetaAsCode(row) {
  if (row.kind !== "meta") {
    return false;
  }
  return row.label === "Command" || row.label === "Tool";
}

function setDetailsMode() {
  elements.toggleDetailsButton.textContent = state.showMetaMessages ? "Details: on" : "Details: off";
  elements.toggleDetailsButton.dataset.active = state.showMetaMessages ? "true" : "false";
  elements.composerHint.textContent = state.showMetaMessages
    ? "Details mode includes plans, tools, and command output."
    : "Chat mode shows only user and assistant messages.";
}

function compactPath(path) {
  if (!path) {
    return "unknown repo";
  }

  const trimmed = String(path).replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || path;
}

function renderThreadMeta() {
  const repoName = compactPath(state.status?.defaultThreadCwd);

  if (!state.thread) {
    elements.threadMeta.textContent = `Repo: ${repoName} • open menu to choose session`;
    return;
  }

  const updatedAt = state.thread.updatedAt
    ? dateFormatter.format(new Date(state.thread.updatedAt * 1000))
    : "unknown time";
  const threadName = state.thread.name || "Current chat";
  elements.threadMeta.textContent = `${threadName} • updated ${updatedAt}`;
}

function renderThreads() {
  elements.threadSelect.innerHTML = "";

  if (!state.threads.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No sessions found";
    elements.threadSelect.appendChild(option);
    elements.threadSelect.disabled = true;
    return;
  }

  elements.threadSelect.disabled = false;

  for (const thread of state.threads) {
    const option = document.createElement("option");
    option.value = thread.id;
    option.textContent = thread.name || thread.preview || "Current chat";
    if (thread.id === state.selectedThreadId) {
      option.selected = true;
    }
    elements.threadSelect.appendChild(option);
  }
}

function renderMessages() {
  if (!state.thread) {
    elements.messages.hidden = true;
    elements.emptyState.hidden = false;
    return;
  }

  const shouldStickToBottom =
    elements.messages.hidden ||
    elements.messages.scrollHeight - elements.messages.scrollTop - elements.messages.clientHeight <=
      SCROLL_BOTTOM_THRESHOLD_PX;
  const previousScrollTop = elements.messages.scrollTop;

  elements.messages.hidden = false;
  elements.emptyState.hidden = true;
  elements.messages.innerHTML = "";

  const rows = flattenThread(state.thread).filter((row) =>
    state.showMetaMessages ? true : row.kind !== "meta"
  );

  for (const row of rows) {
    const article = document.createElement("article");
    article.className = `message message-${row.kind}`;

    if (row.kind === "meta") {
      article.innerHTML = `<span class="message-label">${row.label}</span>`;
      if (shouldRenderMetaAsCode(row)) {
        renderCodeBlock(article, row.text, "text");
      } else {
        renderMessageText(article, row.text);
      }
    } else {
      renderMessageText(article, row.text);
    }

    elements.messages.appendChild(article);
  }

  for (const draft of state.liveDrafts.values()) {
    if (draft.threadId !== state.selectedThreadId) {
      continue;
    }
    const article = document.createElement("article");
    article.className = "message message-assistant message-live";
    article.innerHTML = `<span class="message-label">Live</span>`;
    renderMessageText(article, draft.text);
    elements.messages.appendChild(article);
  }

  const changedFiles = collectThreadChangedFiles(state.thread);
  if (changedFiles.files.length || changedFiles.totalChanges > 0) {
    const summary = document.createElement("article");
    summary.className = "message message-meta message-files-summary";

    summary.innerHTML = `<span class="message-label">Changed files</span>`;
    renderChangedFilesSummary(summary, changedFiles);
    elements.messages.appendChild(summary);
  }

  if (shouldStickToBottom) {
    elements.messages.scrollTop = elements.messages.scrollHeight;
  } else {
    elements.messages.scrollTop = previousScrollTop;
  }
}

function collectThreadChangedFiles(thread) {
  const files = new Set();
  let totalChanges = 0;

  for (const turn of thread?.turns || []) {
    for (const item of turn.items || []) {
      if (item.type !== "fileChange") {
        continue;
      }

      const changes = Array.isArray(item.changes) ? item.changes : [];
      totalChanges += changes.length;

      for (const change of changes) {
        const filePath = collectChangedFilePath(change);
        if (filePath) {
          files.add(filePath);
        }
      }
    }
  }

  return {
    files: Array.from(files).sort(),
    totalChanges,
  };
}

function splitChangedFilePath(filePath) {
  const normalized = String(filePath || "").replaceAll("\\", "/").replace(/\/+/g, "/");
  const lastSlash = normalized.lastIndexOf("/");

  if (lastSlash === -1) {
    return {
      dir: ".",
      name: normalized,
      full: normalized,
    };
  }

  return {
    dir: normalized.slice(0, lastSlash),
    name: normalized.slice(lastSlash + 1),
    full: normalized,
  };
}

function renderChangedFilesSummary(container, changedFiles) {
  const meta = document.createElement("div");
  meta.className = "changed-files-meta";

  const total = document.createElement("span");
  total.className = "changed-files-count";
  total.textContent = changedFiles.files.length
    ? `${changedFiles.files.length} file(s)`
    : `${changedFiles.totalChanges} update(s)`;
  meta.appendChild(total);
  container.appendChild(meta);

  if (!changedFiles.files.length) {
    const empty = document.createElement("p");
    empty.className = "changed-files-empty";
    empty.textContent = "No file paths were provided.";
    container.appendChild(empty);
    return;
  }

  const groups = new Map();
  for (const filePath of changedFiles.files) {
    const parts = splitChangedFilePath(filePath);
    const entries = groups.get(parts.dir) || [];
    entries.push(parts);
    groups.set(parts.dir, entries);
  }

  const wrap = document.createElement("div");
  wrap.className = "changed-files-groups";

  for (const [dir, files] of Array.from(groups.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
    const section = document.createElement("section");
    section.className = "changed-group";

    const title = document.createElement("p");
    title.className = "changed-group-title";
    title.textContent = dir === "." ? "root" : dir;
    section.appendChild(title);

    const chips = document.createElement("div");
    chips.className = "changed-group-files";

    for (const file of files.sort((a, b) => a.name.localeCompare(b.name))) {
      const chip = document.createElement("code");
      chip.className = "changed-file-chip";
      chip.title = file.full;
      chip.textContent = file.name || file.full;
      chips.appendChild(chip);
    }

    section.appendChild(chips);
    wrap.appendChild(section);
  }

  container.appendChild(wrap);
}

function splitCodeBlocks(text) {
  const source = String(text || "");
  const blocks = [];
  const pattern = /```([a-z0-9_-]+)?\n?([\s\S]*?)```/gi;
  let cursor = 0;
  let match;

  while ((match = pattern.exec(source))) {
    if (match.index > cursor) {
      blocks.push({
        type: "text",
        value: source.slice(cursor, match.index),
      });
    }

    blocks.push({
      type: "code",
      lang: (match[1] || "").trim(),
      value: match[2].replace(/\n$/, ""),
    });
    cursor = pattern.lastIndex;
  }

  if (cursor < source.length) {
    blocks.push({
      type: "text",
      value: source.slice(cursor),
    });
  }

  return blocks.length ? blocks : [{ type: "text", value: source }];
}

function appendInlineMarkdown(container, text) {
  const source = String(text || "");
  const pattern = /(`[^`]+`)|(\[[^\]]+\]\((https?:\/\/[^\s)]+)\))|(\*\*[^*]+\*\*)|(\*[^*]+\*)/g;
  let cursor = 0;
  let match;

  while ((match = pattern.exec(source))) {
    if (match.index > cursor) {
      container.appendChild(document.createTextNode(source.slice(cursor, match.index)));
    }

    const token = match[0];
    if (token.startsWith("`")) {
      const code = document.createElement("code");
      code.className = "md-inline-code";
      code.textContent = token.slice(1, -1);
      container.appendChild(code);
      cursor = pattern.lastIndex;
      continue;
    }

    if (token.startsWith("[")) {
      const linkMatch = token.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/);
      if (linkMatch) {
        const anchor = document.createElement("a");
        anchor.className = "md-link";
        anchor.href = linkMatch[2];
        anchor.target = "_blank";
        anchor.rel = "noreferrer noopener";
        anchor.textContent = linkMatch[1];
        container.appendChild(anchor);
        cursor = pattern.lastIndex;
        continue;
      }
    }

    if (token.startsWith("**")) {
      const strong = document.createElement("strong");
      strong.textContent = token.slice(2, -2);
      container.appendChild(strong);
      cursor = pattern.lastIndex;
      continue;
    }

    if (token.startsWith("*")) {
      const em = document.createElement("em");
      em.textContent = token.slice(1, -1);
      container.appendChild(em);
      cursor = pattern.lastIndex;
      continue;
    }
  }

  if (cursor < source.length) {
    container.appendChild(document.createTextNode(source.slice(cursor)));
  }
}

function isMarkdownBlockStart(line) {
  return (
    /^#{1,6}\s+/.test(line) ||
    /^\s*[-*]\s+/.test(line) ||
    /^\s*\d+\.\s+/.test(line) ||
    /^\s*>\s?/.test(line)
  );
}

function appendParagraph(container, lines) {
  const paragraph = document.createElement("p");
  paragraph.className = "md-p";

  lines.forEach((line, index) => {
    appendInlineMarkdown(paragraph, line);
    if (index < lines.length - 1) {
      paragraph.appendChild(document.createElement("br"));
    }
  });

  container.appendChild(paragraph);
}

function renderMarkdownText(container, text) {
  const lines = String(text || "").replaceAll("\r\n", "\n").split("\n");
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = Math.min(6, headingMatch[1].length + 1);
      const heading = document.createElement(`h${level}`);
      heading.className = "md-heading";
      appendInlineMarkdown(heading, headingMatch[2].trim());
      container.appendChild(heading);
      index += 1;
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const list = document.createElement("ul");
      list.className = "md-ul";
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index])) {
        const item = document.createElement("li");
        item.className = "md-li";
        const value = lines[index].replace(/^\s*[-*]\s+/, "");
        appendInlineMarkdown(item, value);
        list.appendChild(item);
        index += 1;
      }
      container.appendChild(list);
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const list = document.createElement("ol");
      list.className = "md-ol";
      while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index])) {
        const item = document.createElement("li");
        item.className = "md-li";
        const value = lines[index].replace(/^\s*\d+\.\s+/, "");
        appendInlineMarkdown(item, value);
        list.appendChild(item);
        index += 1;
      }
      container.appendChild(list);
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quoteLines = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^\s*>\s?/, ""));
        index += 1;
      }
      const quote = document.createElement("blockquote");
      quote.className = "md-blockquote";
      appendParagraph(quote, quoteLines);
      container.appendChild(quote);
      continue;
    }

    const paragraphLines = [];
    while (index < lines.length && lines[index].trim() && !isMarkdownBlockStart(lines[index])) {
      paragraphLines.push(lines[index]);
      index += 1;
    }
    appendParagraph(container, paragraphLines);
  }
}

async function copyTextToClipboard(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_error) {
    // Fallback below.
  }

  try {
    const input = document.createElement("textarea");
    input.value = text;
    input.setAttribute("readonly", "");
    input.style.position = "absolute";
    input.style.left = "-9999px";
    document.body.appendChild(input);
    input.select();
    const success = document.execCommand("copy");
    document.body.removeChild(input);
    return success;
  } catch (_error) {
    return false;
  }
}

function renderCodeBlock(container, codeText, language) {
  const codeWrap = document.createElement("section");
  codeWrap.className = "message-code-wrap";

  const head = document.createElement("div");
  head.className = "message-code-head";

  const label = document.createElement("span");
  label.className = "message-code-lang";
  label.textContent = language || "code";
  head.appendChild(label);

  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "message-code-copy";
  copy.textContent = "Copy";
  copy.addEventListener("click", async () => {
    const success = await copyTextToClipboard(codeText);
    copy.textContent = success ? "Copied" : "Copy failed";
    window.setTimeout(() => {
      copy.textContent = "Copy";
    }, 1200);
  });
  head.appendChild(copy);

  codeWrap.appendChild(head);

  const pre = document.createElement("pre");
  pre.className = "message-code";
  const code = document.createElement("code");
  code.textContent = codeText;
  pre.appendChild(code);
  codeWrap.appendChild(pre);
  container.appendChild(codeWrap);
}

function renderMessageText(container, text) {
  const blocks = splitCodeBlocks(text);

  for (const block of blocks) {
    if (block.type === "code") {
      renderCodeBlock(container, block.value, block.lang);
      continue;
    }

    if (!block.value.trim()) {
      continue;
    }

    renderMarkdownText(container, block.value);
  }
}

function renderPendingRequest() {
  const firstRequest = state.pendingRequests.values().next().value;
  if (!firstRequest) {
    if (elements.requestDialog.open) {
      elements.requestDialog.close();
    }
    return;
  }

  elements.requestEyebrow.textContent = readableRequestKind(firstRequest.method);
  elements.requestTitle.textContent = readableRequestTitle(firstRequest.method);
  elements.requestDescription.textContent = readableRequestDescription(firstRequest);
  elements.requestBody.innerHTML = "";
  elements.requestActions.innerHTML = "";

  if (firstRequest.method === "item/tool/requestUserInput") {
    renderUserInputRequest(firstRequest);
  } else {
    renderApprovalRequest(firstRequest);
  }

  if (!elements.requestDialog.open) {
    elements.requestDialog.showModal();
  }
}

function readableRequestKind(method) {
  if (method === "item/commandExecution/requestApproval") return "Command approval";
  if (method === "item/fileChange/requestApproval") return "File write approval";
  if (method === "item/tool/requestUserInput") return "Question";
  if (method === "item/permissions/requestApproval") return "Permission approval";
  return "Incoming request";
}

function readableRequestTitle(method) {
  if (method === "item/commandExecution/requestApproval") return "Codex wants to run a command";
  if (method === "item/fileChange/requestApproval") return "Codex wants to change files";
  if (method === "item/tool/requestUserInput") return "Codex needs your answer";
  if (method === "item/permissions/requestApproval") return "Codex wants extra permissions";
  return "Codex needs input";
}

function readableRequestDescription(request) {
  const params = request.params || {};
  if (params.reason) {
    return params.reason;
  }
  if (params.command) {
    return params.command;
  }
  if (request.method === "item/tool/requestUserInput") {
    return "Answer below from your phone and the local thread will continue.";
  }
  return "Respond here to continue the selected Codex thread.";
}

function createActionButton(label, onClick, tone = "default") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "action-button";
  button.dataset.tone = tone;
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

function decisionLabel(decision) {
  if (typeof decision === "string") {
    const labels = {
      accept: "Approve once",
      acceptForSession: "Approve for session",
      decline: "Decline",
      cancel: "Cancel",
    };
    return labels[decision] || decision;
  }

  if (decision.acceptWithExecpolicyAmendment) {
    return "Approve + remember";
  }

  if (decision.applyNetworkPolicyAmendment) {
    return "Apply network rule";
  }

  return "Approve";
}

function renderApprovalRequest(request) {
  const params = request.params || {};
  const body = document.createElement("div");
  body.className = "request-card";
  const detail = params.command || params.reason || JSON.stringify(params, null, 2);
  body.innerHTML = `<pre>${escapeHtml(detail)}</pre>`;
  elements.requestBody.appendChild(body);

  const available =
    request.method === "item/commandExecution/requestApproval"
      ? params.availableDecisions || ["accept", "decline", "cancel"]
      : request.method === "item/fileChange/requestApproval"
      ? ["accept", "acceptForSession", "decline", "cancel"]
      : ["decline"];

  for (const decision of available) {
    const tone =
      typeof decision === "string" && (decision === "decline" || decision === "cancel")
        ? "danger"
        : "default";
    elements.requestActions.appendChild(
      createActionButton(decisionLabel(decision), async () => {
        const result =
          request.method === "item/fileChange/requestApproval"
            ? { decision }
            : { decision };
        await submitRequestResponse(request.requestId, result);
      }, tone)
    );
  }
}

function renderUserInputRequest(request) {
  const questions = request.params?.questions || [];

  const form = document.createElement("div");
  form.className = "question-stack";

  for (const question of questions) {
    const wrapper = document.createElement("section");
    wrapper.className = "question-card";
    wrapper.innerHTML = `
      <p class="question-header">${escapeHtml(question.header || "Question")}</p>
      <h3>${escapeHtml(question.question || "")}</h3>
    `;

    if (question.options?.length) {
      const options = document.createElement("div");
      options.className = "option-list";

      for (const option of question.options) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "option-button";
        button.textContent = option.label;
        button.addEventListener("click", () => {
          const input = wrapper.querySelector("textarea, input");
          input.value = option.label;
        });
        options.appendChild(button);
      }
      wrapper.appendChild(options);
    }

    const input = document.createElement(question.isSecret ? "input" : "textarea");
    input.name = question.id;
    input.placeholder = question.isOther
      ? "Type your answer..."
      : "Tap an option or type your answer...";

    if (question.isSecret) {
      input.type = "password";
    } else {
      input.rows = 3;
    }

    wrapper.appendChild(input);
    form.appendChild(wrapper);
  }

  elements.requestBody.appendChild(form);
  elements.requestActions.appendChild(
    createActionButton("Submit answer", async () => {
      const answers = {};
      for (const question of questions) {
        const input = form.querySelector(`[name="${CSS.escape(question.id)}"]`);
        const value = input.value.trim();
        answers[question.id] = {
          answers: value ? [value] : [],
        };
      }

      await submitRequestResponse(request.requestId, { answers });
    })
  );
}

async function submitRequestResponse(requestId, result) {
  await fetch("/api/request/respond", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requestId, result }),
  });
  state.pendingRequests.delete(String(requestId));
  renderPendingRequest();
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function loadStatus() {
  const response = await fetch("/api/status");
  state.status = await response.json();
  state.selectedThreadId = state.status.selectedThreadId || state.selectedThreadId;
  setBridgeStatus(state.status.ready ? "Connected" : "Starting", state.status.ready ? "ok" : "muted");
  renderThreadMeta();
}

async function loadThreads() {
  const cwd = state.status?.defaultThreadCwd || "";
  const response = await fetch(`/api/threads?cwd=${encodeURIComponent(cwd)}`);
  const payload = await response.json();
  state.threads = payload.threads || [];

  if (!state.threads.some((thread) => thread.id === state.selectedThreadId)) {
    state.selectedThreadId = null;
    state.thread = null;
  }

  renderThreads();

  if (!state.selectedThreadId && state.threads[0]) {
    await selectThread(state.threads[0].id);
    return;
  }

  if (state.selectedThreadId && (!state.thread || state.thread.id !== state.selectedThreadId)) {
    await selectThread(state.selectedThreadId);
    return;
  }

  renderThreadMeta();
  renderMessages();
}

async function selectThread(threadId) {
  if (!threadId) {
    return;
  }

  setMenuOpen(false);
  state.selectedThreadId = threadId;
  state.liveDrafts.clear();
  renderThreads();

  await fetch("/api/thread/select", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ threadId }),
  });

  const response = await fetch(`/api/thread?threadId=${encodeURIComponent(threadId)}`);
  const payload = await response.json();
  state.thread = payload.thread;
  renderThreadMeta();
  renderMessages();
}

async function sendPrompt(event) {
  event.preventDefault();

  if (state.sending || !state.selectedThreadId) {
    return;
  }

  const text = elements.promptInput.value.trim();
  if (!text) {
    return;
  }

  state.sending = true;
  elements.sendButton.disabled = true;

  try {
    await fetch("/api/thread/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        threadId: state.selectedThreadId,
        text,
      }),
    });

    elements.promptInput.value = "";
    const response = await fetch(`/api/thread?threadId=${encodeURIComponent(state.selectedThreadId)}`);
    const payload = await response.json();
    state.thread = payload.thread;
    renderThreadMeta();
    renderMessages();
  } finally {
    state.sending = false;
    elements.sendButton.disabled = false;
  }
}

function connectWebSocket() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
  state.ws = ws;

  ws.addEventListener("message", (event) => {
    const payload = JSON.parse(event.data);

    if (payload.type === "bridgeStatus") {
      state.status = payload.status;
      state.selectedThreadId = payload.status.selectedThreadId || state.selectedThreadId;
      setBridgeStatus(payload.status.ready ? "Connected" : "Disconnected", payload.status.ready ? "ok" : "danger");
      renderThreads();
      renderThreadMeta();
      for (const request of payload.status.pendingRequests || []) {
        state.pendingRequests.set(String(request.requestId), request);
      }
      renderPendingRequest();
      return;
    }

    if (payload.type === "threadSnapshot") {
      if (payload.thread.id === state.selectedThreadId) {
        state.thread = payload.thread;
        state.liveDrafts.clear();
        renderThreadMeta();
        renderMessages();
      }
      return;
    }

    if (payload.type === "serverRequest") {
      state.pendingRequests.set(String(payload.requestId), payload);
      renderPendingRequest();
      return;
    }

    if (payload.type === "notification") {
      handleNotification(payload.method, payload.params);
    }
  });

  ws.addEventListener("close", () => {
    setBridgeStatus("Disconnected", "danger");
    window.setTimeout(connectWebSocket, 1200);
  });
}

function handleNotification(method, params) {
  if (method === "item/agentMessage/delta") {
    if (params.threadId !== state.selectedThreadId) {
      return;
    }
    const key = params.itemId;
    const current = state.liveDrafts.get(key) || {
      threadId: params.threadId,
      text: "",
    };
    current.text += params.delta;
    state.liveDrafts.set(key, current);
    renderMessages();
    return;
  }

  if (method === "turn/completed" && params.threadId === state.selectedThreadId) {
    state.liveDrafts.clear();
    renderMessages();
    return;
  }

  if (method === "serverRequest/resolved") {
    state.pendingRequests.delete(String(params.requestId));
    renderPendingRequest();
  }
}

async function init() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }

  setMenuOpen(false);
  setDetailsMode();
  await loadStatus();
  await loadThreads();
  connectWebSocket();

  elements.menuButton.addEventListener("click", toggleMenu);
  elements.menuCloseButton.addEventListener("click", () => setMenuOpen(false));
  elements.menuOverlay.addEventListener("click", () => setMenuOpen(false));
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.menuOpen) {
      setMenuOpen(false);
    }
  });

  elements.composer.addEventListener("submit", sendPrompt);
  elements.refreshThreadsButton.addEventListener("click", async () => {
    await loadThreads();
    setMenuOpen(false);
  });
  elements.toggleDetailsButton.addEventListener("click", () => {
    state.showMetaMessages = !state.showMetaMessages;
    setDetailsMode();
    renderMessages();
    setMenuOpen(false);
  });
  elements.threadSelect.addEventListener("change", (event) => {
    const target = event.currentTarget;
    if (!(target instanceof HTMLSelectElement)) {
      return;
    }
    selectThread(target.value);
  });
}

init().catch((error) => {
  setBridgeStatus("Error", "danger");
  elements.threadMeta.textContent = error.message;
});
