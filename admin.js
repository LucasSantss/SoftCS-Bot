async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    if (res.status === 429) {
      err.rateLimited = true;
      err.retryAfterSeconds = data.retryAfterSeconds || 60;
    }
    throw err;
  }
  return data;
}

// ─── Abas ───────────────────────────────────────────────────────────────────
const navItems = document.querySelectorAll(".nav-item");
const tabPanels = document.querySelectorAll(".tab-panel");
const topbarTitle = document.getElementById("topbarTitle");
const topbarSub = document.getElementById("topbarSub");

const TAB_META = {
  tickets: { title: "Tickets", sub: "Consulta os tickets da SoftCS, agrupados pelas colunas do Kanban" },
  agents: { title: "Agentes", sub: "Mapeamento entre usuário SoftCS e @username no Telegram" },
  chats: { title: "Chats do Telegram", sub: "Grupos e canais que recebem a notificação de cada ticket" },
  debug: { title: "Debug", sub: "Payload cru da API da SoftCS — temporário" },
};

navItems.forEach((item) => {
  item.addEventListener("click", () => {
    const tab = item.dataset.tab;
    navItems.forEach((el) => el.classList.toggle("active", el === item));
    tabPanels.forEach((panel) => panel.classList.toggle("active", panel.id === `tab-${tab}`));
    topbarTitle.textContent = TAB_META[tab].title;
    topbarSub.textContent = TAB_META[tab].sub;
  });
});

function setStatus(el, message, isError) {
  el.textContent = message;
  el.className = "status-line " + (isError ? "error" : "ok");
}

// ─── Agentes ────────────────────────────────────────────────────────────────
const agentForm = document.getElementById("agentForm");
const agentStatus = document.getElementById("agentStatus");
const agentList = document.getElementById("agentList");
const agentEmpty = document.getElementById("agentEmpty");

let knownAgentIds = new Set();
let agentUsernameById = new Map();

async function loadAgents() {
  try {
    const agents = await api("/api/agents");
    knownAgentIds = new Set(agents.map((a) => a.softcs_user_id));
    agentUsernameById = new Map(agents.map((a) => [a.softcs_user_id, a.telegram_username]));
    agentList.innerHTML = "";
    agentEmpty.style.display = agents.length ? "none" : "block";
    for (const agent of agents) renderAgentRow(agent);
    if (lastCreators.length) renderCreators(lastCreators);
  } catch (err) {
    setStatus(agentStatus, err.message, true);
  }
}

function renderAgentRow(agent) {
  const row = document.createElement("div");
  row.className = "list-item";
  row.innerHTML = `
    <div class="list-item-main">
      <span class="list-item-title"></span>
      <span class="list-item-sub"></span>
    </div>
    <div class="list-item-actions">
      <button class="icon-btn danger-hover" title="Remover">🗑</button>
    </div>
  `;
  row.querySelector(".list-item-title").textContent = `${agent.display_name || "(sem nome)"} · @${agent.telegram_username}`;
  row.querySelector(".list-item-sub").textContent = agent.softcs_user_id;
  row.querySelector("button").addEventListener("click", async () => {
    if (!confirm(`Remover "${agent.display_name || agent.softcs_user_id}"?`)) return;
    try {
      await api(`/api/agents?softcs_user_id=${encodeURIComponent(agent.softcs_user_id)}`, { method: "DELETE" });
      await loadAgents();
      setStatus(agentStatus, "Removido.", false);
    } catch (err) {
      setStatus(agentStatus, err.message, true);
    }
  });
  agentList.appendChild(row);
}

agentForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(agentForm));
  try {
    await api("/api/agents", { method: "POST", body: JSON.stringify(data) });
    agentForm.reset();
    setStatus(agentStatus, "Adicionado.", false);
    await loadAgents();
  } catch (err) {
    setStatus(agentStatus, err.message, true);
  }
});

// ─── Criadores encontrados (vem da busca feita na aba Tickets) ─────────────
const creatorsList = document.getElementById("creatorsList");
const creatorsEmpty = document.getElementById("creatorsEmpty");
const creatorsStatus = document.getElementById("creatorsStatus");
const saveAllBtn = document.getElementById("saveAllBtn");

const creatorInputs = new Map(); // softcs_user_id -> <input>

function renderCreators(creators) {
  creatorsList.innerHTML = "";
  creatorInputs.clear();
  creatorsEmpty.style.display = creators.length ? "none" : "block";

  for (const creator of creators) {
    const row = document.createElement("div");
    row.className = "list-item";
    row.innerHTML = `
      <div class="list-item-main">
        <span class="list-item-title"></span>
        <span class="list-item-sub"></span>
      </div>
      <div class="list-item-actions"></div>
    `;
    row.querySelector(".list-item-title").textContent = creator.name || "(sem nome — só ID)";
    row.querySelector(".list-item-sub").textContent = [creator.email, creator.id].filter(Boolean).join(" · ");

    const actions = row.querySelector(".list-item-actions");
    const mapped = knownAgentIds.has(creator.id);

    if (mapped) {
      const badge = document.createElement("span");
      badge.className = "badge on";
      badge.textContent = "@" + (agentUsernameById.get(creator.id) || "?");
      actions.appendChild(badge);
    } else {
      const usernameInput = document.createElement("input");
      usernameInput.type = "text";
      usernameInput.placeholder = "@username";
      usernameInput.style.width = "140px";
      creatorInputs.set(creator.id, usernameInput);

      const saveBtn = document.createElement("button");
      saveBtn.className = "btn btn-primary";
      saveBtn.textContent = "Salvar";
      saveBtn.addEventListener("click", () => saveCreator(creator, usernameInput));

      actions.append(usernameInput, saveBtn);
    }

    creatorsList.appendChild(row);
  }
}

async function saveCreator(creator, usernameInput) {
  const telegram_username = usernameInput.value.trim();
  if (!telegram_username) {
    usernameInput.focus();
    return false;
  }
  await api("/api/agents", {
    method: "POST",
    body: JSON.stringify({ softcs_user_id: creator.id, telegram_username, display_name: creator.name }),
  });
  return true;
}

saveAllBtn.addEventListener("click", async () => {
  const pending = lastCreators.filter((c) => creatorInputs.has(c.id) && creatorInputs.get(c.id).value.trim());
  if (pending.length === 0) {
    setStatus(creatorsStatus, "Nenhum @ preenchido pra salvar.", true);
    return;
  }
  let saved = 0;
  for (const creator of pending) {
    try {
      await saveCreator(creator, creatorInputs.get(creator.id));
      saved += 1;
    } catch (err) {
      setStatus(creatorsStatus, `Parou em "${creator.name || creator.id}": ${err.message}`, true);
      await loadAgents();
      return;
    }
  }
  setStatus(creatorsStatus, `${saved} agente(s) salvo(s).`, false);
  await loadAgents();
});

// ─── Buscar da SoftCS ───────────────────────────────────────────────────────
const connectionForm = document.getElementById("connectBox");
const saveConnectionBtn = document.getElementById("saveConnectionBtn");
const connectBtn = document.getElementById("connectBtn");
const connectionStatus = document.getElementById("connectionStatus");
const discoverBtn = document.getElementById("discoverBtn");
const discoverStatus = document.getElementById("discoverStatus");

function connectionField(name) {
  return connectionForm.querySelector(`[name="${name}"]`);
}

async function loadConnection() {
  try {
    const data = await api("/api/settings");
    connectionField("softcs_client_id").value = data.softcs_client_id;
    connectionField("softcs_client_secret").value = data.softcs_client_secret;
    connectionField("softcs_redirect_uri").value = data.softcs_redirect_uri;
    connectionStatus.textContent = data.oauth_connected ? "conectado" : "não conectado";
    connectionStatus.className = "badge " + (data.oauth_connected ? "on" : "off");
  } catch (err) {
    setStatus(discoverStatus, err.message, true);
  }
}

saveConnectionBtn.addEventListener("click", async () => {
  const data = {
    softcs_client_id: connectionField("softcs_client_id").value.trim(),
    softcs_client_secret: connectionField("softcs_client_secret").value.trim(),
    softcs_redirect_uri: connectionField("softcs_redirect_uri").value.trim(),
  };
  try {
    await api("/api/settings", { method: "POST", body: JSON.stringify(data) });
    setStatus(discoverStatus, "Configurações salvas.", false);
  } catch (err) {
    setStatus(discoverStatus, err.message, true);
  }
});

connectBtn.addEventListener("click", () => {
  window.location.href = "/api/oauth-start";
});

// ─── Kanban de tickets ──────────────────────────────────────────────────────
const kanbanBoard = document.getElementById("kanbanBoard");

function renderTicketCard(ticket) {
  const creator = ticket.createdBy;
  const card = document.createElement("div");
  card.className = "kanban-card";
  card.innerHTML = `
    <div class="kanban-card-title"></div>
    <div class="kanban-card-meta"></div>
    <div class="kanban-card-creator"></div>
  `;
  card.querySelector(".kanban-card-title").textContent = ticket.title;
  card.querySelector(".kanban-card-meta").textContent = [ticket.clientName, ticket.priority]
    .filter(Boolean)
    .join(" · ");

  const creatorEl = card.querySelector(".kanban-card-creator");
  if (creator) {
    const mapped = knownAgentIds.has(creator.id);
    creatorEl.innerHTML = `<span class="badge ${mapped ? "on" : "off"}">${mapped ? "@" + (agentUsernameById.get(creator.id) || "") : "sem @"}</span> ${creator.name || creator.id}`;
  } else {
    creatorEl.textContent = "criador desconhecido";
  }

  return card;
}

function renderKanban(tickets) {
  kanbanBoard.innerHTML = "";

  const columns = new Map();
  for (const ticket of tickets) {
    const stage = ticket.stage ?? { id: "sem-estagio", name: "Sem estágio", position: 999, color: null };
    if (!columns.has(stage.id)) columns.set(stage.id, { stage, tickets: [] });
    columns.get(stage.id).tickets.push(ticket);
  }

  const sorted = [...columns.values()].sort((a, b) => a.stage.position - b.stage.position);

  if (sorted.length === 0) {
    kanbanBoard.innerHTML = '<p class="muted">Nenhum ticket pra mostrar ainda.</p>';
    return;
  }

  for (const { stage, tickets: stageTickets } of sorted) {
    const column = document.createElement("div");
    column.className = "kanban-column";
    const header = document.createElement("div");
    header.className = "kanban-column-header";
    if (stage.color) header.style.borderTopColor = stage.color;

    const nameEl = document.createElement("span");
    nameEl.className = "kanban-column-name";
    nameEl.textContent = stage.name;
    nameEl.title = "Clique pra renomear";
    nameEl.addEventListener("click", async () => {
      const newLabel = prompt("Nome dessa coluna:", stage.name);
      if (!newLabel || newLabel === stage.name) return;
      try {
        await api("/api/stage-labels", {
          method: "POST",
          body: JSON.stringify({ stage_id: stage.id, label: newLabel }),
        });
        nameEl.textContent = newLabel;
      } catch (err) {
        setStatus(discoverStatus, err.message, true);
      }
    });

    const countEl = document.createElement("span");
    countEl.className = "kanban-column-count";
    countEl.textContent = stageTickets.length;

    header.append(nameEl, countEl);
    column.appendChild(header);

    const cardsWrap = document.createElement("div");
    cardsWrap.className = "kanban-column-cards";
    for (const ticket of stageTickets) cardsWrap.appendChild(renderTicketCard(ticket));
    column.appendChild(cardsWrap);

    kanbanBoard.appendChild(column);
  }
}

// ─── Busca automática (um botão só) ─────────────────────────────────────────
// A SoftCS não tem "listar tickets de todos os clientes" e essa conta tem
// milhares de clientes — então a gente varre em lotes de 200, e o próprio
// navegador encadeia as chamadas sozinho (sem precisar clicar de novo) até
// acabar ou o usuário clicar em "Parar". Cada chamada individual fica rápida
// o bastante pra não estourar o tempo da function.
const stopDiscoverBtn = document.getElementById("stopDiscoverBtn");

let lastCreators = [];
let stopRequested = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function updateDiscoverProgress({ ticketCount, creatorCount, clientsScanned, hasNames, done, stopped }) {
  const namesNote = hasNames === false ? " (API não retornou nome/e-mail do criador — só o ID)" : "";
  const doneNote = !done ? "Buscando…" : stopped ? "Parado." : "Concluído.";
  setStatus(
    discoverStatus,
    `${doneNote} ${ticketCount} ticket(s) aberto(s) em ${clientsScanned} cliente(s) verificados, ${creatorCount} criador(es) único(s).${namesNote}`,
    false
  );
}

async function runDiscoverLoop() {
  discoverBtn.disabled = true;
  stopDiscoverBtn.style.display = "inline-flex";
  stopRequested = false;

  kanbanBoard.innerHTML = "";
  const allTickets = [];
  const allCreatorsById = new Map();
  let clientsScanned = 0;
  let offset = 0;
  let hasNames = false;

  try {
    while (!stopRequested) {
      let data;
      try {
        data = await api(`/api/discover-tickets?offset=${offset}`);
      } catch (err) {
        if (!err.rateLimited) throw err;
        // A SoftCS limita requisições por IP a cada poucos minutos — espera o
        // tempo pedido e tenta o mesmo lote de novo, sem perder o progresso.
        for (let s = err.retryAfterSeconds; s > 0 && !stopRequested; s--) {
          setStatus(discoverStatus, `Limite da SoftCS atingido — retomando em ${s}s… (${allTickets.length} ticket(s) até agora)`, true);
          await sleep(1000);
        }
        continue;
      }

      allTickets.push(...data.tickets);
      for (const creator of data.creators) {
        if (!allCreatorsById.has(creator.id)) allCreatorsById.set(creator.id, creator);
      }
      clientsScanned += data.clientsScanned;
      if (data.hasNames) hasNames = true;

      lastCreators = [...allCreatorsById.values()];
      renderKanban(allTickets);
      renderCreators(lastCreators);
      updateDiscoverProgress({
        ticketCount: allTickets.length,
        creatorCount: lastCreators.length,
        clientsScanned,
        hasNames,
        done: false,
      });

      if (!data.hasMoreClients) break;
      offset = data.nextOffset;
    }

    updateDiscoverProgress({
      ticketCount: allTickets.length,
      creatorCount: lastCreators.length,
      clientsScanned,
      hasNames,
      done: true,
      stopped: stopRequested,
    });
  } catch (err) {
    setStatus(discoverStatus, err.message, true);
  } finally {
    discoverBtn.disabled = false;
    stopDiscoverBtn.style.display = "none";
  }
}

discoverBtn.addEventListener("click", runDiscoverLoop);
stopDiscoverBtn.addEventListener("click", () => {
  stopRequested = true;
});

// ─── Chats ──────────────────────────────────────────────────────────────────
const chatForm = document.getElementById("chatForm");
const chatStatus = document.getElementById("chatStatus");
const chatList = document.getElementById("chatList");
const chatEmpty = document.getElementById("chatEmpty");

async function loadChats() {
  try {
    const chats = await api("/api/chats");
    chatList.innerHTML = "";
    chatEmpty.style.display = chats.length ? "none" : "block";
    for (const chat of chats) renderChatRow(chat);
  } catch (err) {
    setStatus(chatStatus, err.message, true);
  }
}

function renderChatRow(chat) {
  const row = document.createElement("div");
  row.className = "list-item";
  row.innerHTML = `
    <div class="list-item-main">
      <span class="list-item-title"></span>
      <span class="list-item-sub"></span>
    </div>
    <div class="list-item-actions">
      <span class="test-result status-line"></span>
      <button class="btn btn-secondary test-btn">Testar</button>
      <label class="switch">
        <input type="checkbox" />
        <span class="switch-track"></span>
      </label>
      <button class="icon-btn" title="Remover">🗑</button>
    </div>
  `;
  row.querySelector(".list-item-title").textContent = chat.label || "(sem rótulo)";
  row.querySelector(".list-item-sub").textContent = chat.chat_id;

  const testResult = row.querySelector(".test-result");
  row.querySelector(".test-btn").addEventListener("click", async (event) => {
    const btn = event.currentTarget;
    btn.disabled = true;
    testResult.textContent = "";
    try {
      await api("/api/telegram-test", { method: "POST", body: JSON.stringify({ chat_id: chat.chat_id }) });
      testResult.textContent = "✓ enviada";
      testResult.className = "test-result status-line ok";
    } catch (err) {
      testResult.textContent = err.message;
      testResult.className = "test-result status-line error";
    } finally {
      btn.disabled = false;
    }
  });

  const toggle = row.querySelector('input[type="checkbox"]');
  toggle.checked = chat.active;
  toggle.addEventListener("change", async () => {
    try {
      await api("/api/chats", {
        method: "PATCH",
        body: JSON.stringify({ chat_id: chat.chat_id, active: toggle.checked }),
      });
      setStatus(chatStatus, "Atualizado.", false);
    } catch (err) {
      setStatus(chatStatus, err.message, true);
      toggle.checked = !toggle.checked;
    }
  });

  row.querySelector(".icon-btn").addEventListener("click", async () => {
    if (!confirm(`Remover "${chat.label || chat.chat_id}"?`)) return;
    try {
      await api(`/api/chats?chat_id=${encodeURIComponent(chat.chat_id)}`, { method: "DELETE" });
      await loadChats();
      setStatus(chatStatus, "Removido.", false);
    } catch (err) {
      setStatus(chatStatus, err.message, true);
    }
  });

  chatList.appendChild(row);
}

chatForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(chatForm));
  try {
    await api("/api/chats", { method: "POST", body: JSON.stringify(data) });
    chatForm.reset();
    setStatus(chatStatus, "Adicionado.", false);
    await loadChats();
  } catch (err) {
    setStatus(chatStatus, err.message, true);
  }
});

// ─── Debug (temporário) ─────────────────────────────────────────────────────
const debugType = document.getElementById("debugType");
const debugClientId = document.getElementById("debugClientId");
const debugLimit = document.getElementById("debugLimit");
const debugFetchBtn = document.getElementById("debugFetchBtn");
const debugStatus = document.getElementById("debugStatus");
const debugOutput = document.getElementById("debugOutput");

debugFetchBtn.addEventListener("click", async () => {
  const type = debugType.value;
  const clientId = debugClientId.value.trim();
  const limit = debugLimit.value.trim() || "5";

  if (type !== "clients" && !clientId) {
    setStatus(debugStatus, "Client ID é obrigatório pra esse tipo.", true);
    return;
  }

  debugOutput.textContent = "";
  setStatus(debugStatus, "Buscando…", false);
  try {
    const params = new URLSearchParams({ type, limit });
    if (clientId) params.set("clientId", clientId);
    const data = await api(`/api/debug-raw?${params}`);
    debugOutput.textContent = JSON.stringify(data, null, 2);
    setStatus(debugStatus, "Ok.", false);
  } catch (err) {
    setStatus(debugStatus, err.message, true);
  }
});

function boot() {
  loadAgents();
  loadChats();
  loadConnection();
}

boot();
