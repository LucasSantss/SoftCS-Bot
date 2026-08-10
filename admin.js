function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (res.status === 401) {
    // Sessão inválida/expirada — o middleware de página só cobre `/`, então
    // isso também pega o caso de voltar pra uma aba antiga já deslogada.
    window.location.href = "/login.html";
    return new Promise(() => {}); // nunca resolve — a navegação já está indo embora
  }
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
  access: { title: "Acesso", sub: "Quem pode entrar no painel (@chatbotmaker.io)" },
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

// knownAgentIds: quem já tem @ cadastrado (é o que decide badge vs campo pra
// preencher). agentInfoById: todo mundo importado (nome/e-mail), tenha @ ou
// não — usado como fallback de nome quando o ticket em si não traz um.
let knownAgentIds = new Set();
let agentInfoById = new Map();

async function loadAgents() {
  try {
    const agents = await api("/api/agents");
    knownAgentIds = new Set(agents.filter((a) => a.telegram_username).map((a) => a.softcs_user_id));
    agentInfoById = new Map(agents.map((a) => [a.softcs_user_id, a]));
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
    <div class="list-item-actions"></div>
  `;
  row.querySelector(".list-item-title").textContent = agent.display_name || agent.email || "(sem nome)";
  row.querySelector(".list-item-sub").textContent = [agent.email, agent.softcs_user_id].filter(Boolean).join(" · ");

  const actions = row.querySelector(".list-item-actions");

  if (agent.telegram_username) {
    const badge = document.createElement("span");
    badge.className = "badge on";
    badge.textContent = "@" + agent.telegram_username;
    actions.appendChild(badge);
  } else {
    const usernameInput = document.createElement("input");
    usernameInput.type = "text";
    usernameInput.placeholder = "@username";
    usernameInput.style.width = "140px";

    const saveBtn = document.createElement("button");
    saveBtn.className = "btn btn-primary";
    saveBtn.textContent = "Salvar @";
    saveBtn.addEventListener("click", async () => {
      const telegram_username = usernameInput.value.trim();
      if (!telegram_username) {
        usernameInput.focus();
        return;
      }
      try {
        await api("/api/agents", {
          method: "POST",
          body: JSON.stringify({ softcs_user_id: agent.softcs_user_id, telegram_username }),
        });
        setStatus(agentStatus, "@ salvo.", false);
        await loadAgents();
      } catch (err) {
        setStatus(agentStatus, err.message, true);
      }
    });

    actions.append(usernameInput, saveBtn);
  }

  const deleteBtn = document.createElement("button");
  deleteBtn.className = "icon-btn danger-hover";
  deleteBtn.title = "Remover";
  deleteBtn.textContent = "🗑";
  deleteBtn.addEventListener("click", async () => {
    if (!confirm(`Remover "${agent.display_name || agent.softcs_user_id}"?`)) return;
    try {
      await api(`/api/agents?softcs_user_id=${encodeURIComponent(agent.softcs_user_id)}`, { method: "DELETE" });
      await loadAgents();
      setStatus(agentStatus, "Removido.", false);
    } catch (err) {
      setStatus(agentStatus, err.message, true);
    }
  });
  actions.appendChild(deleteBtn);

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

// ─── Importar usuários da SoftCS (nome + e-mail em lote) ───────────────────
const importAgentsInput = document.getElementById("importAgentsInput");
const importAgentsBtn = document.getElementById("importAgentsBtn");
const importAgentsStatus = document.getElementById("importAgentsStatus");

importAgentsBtn.addEventListener("click", async () => {
  const raw = importAgentsInput.value.trim();
  if (!raw) {
    setStatus(importAgentsStatus, "Cole o payload antes de importar.", true);
    return;
  }
  importAgentsBtn.disabled = true;
  setStatus(importAgentsStatus, "Importando…", false);
  try {
    const data = await api("/api/import-agents", { method: "POST", body: JSON.stringify({ raw }) });
    setStatus(importAgentsStatus, `${data.imported} usuário(s) importado(s)/atualizado(s).`, false);
    importAgentsInput.value = "";
    await loadAgents();
  } catch (err) {
    setStatus(importAgentsStatus, err.message, true);
  } finally {
    importAgentsBtn.disabled = false;
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
    const known = agentInfoById.get(creator.id);
    row.querySelector(".list-item-title").textContent =
      creator.name || known?.display_name || known?.email || "(sem nome — só ID)";
    row.querySelector(".list-item-sub").textContent = [creator.email || known?.email, creator.id]
      .filter(Boolean)
      .join(" · ");

    const actions = row.querySelector(".list-item-actions");
    const mapped = knownAgentIds.has(creator.id);

    if (mapped) {
      const badge = document.createElement("span");
      badge.className = "badge on";
      badge.textContent = "@" + known.telegram_username;
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

// Janela popup pro OAuth foi tentada e abandonada: bloqueador de popup do
// navegador impede ela de abrir boa parte das vezes (caindo direto no
// fallback de navegar a aba mesmo), e quando abre, o Cross-Origin-Opener-
// -Policy corta o vínculo com quem abriu depois que ela passa pelo domínio
// da SoftCS, impedindo o fechamento automático — duas causas diferentes de
// falha, fora do nosso controle. A navegação pela SoftCS é inevitável de
// qualquer forma (é OAuth de verdade); o jeito confiável de não deixar uma
// página morta pra fechar manualmente é o próprio callback (ver
// api/softcs-oauth.js) redirecionar de volta pro painel sozinho — volta pra
// cá já com o token salvo, e boot() atualiza o badge de conexão na hora.
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
    const known = agentInfoById.get(creator.id);
    const mapped = knownAgentIds.has(creator.id);
    const label = escapeHtml(creator.name || known?.display_name || known?.email || creator.id);
    const badgeText = mapped ? "@" + known.telegram_username : "sem @";
    creatorEl.innerHTML = `<span class="badge ${mapped ? "on" : "off"}">${badgeText}</span> ${label}`;
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
    nameEl.title = "Clique pra renomear / reordenar";
    nameEl.addEventListener("click", async () => {
      const newLabel = prompt("Nome dessa coluna:", stage.name);
      if (!newLabel) return;

      const currentPosition = stage.position === 999 ? "" : String(stage.position);
      const newPositionRaw = prompt(
        "Posição dessa coluna (número — quanto menor, mais à esquerda; deixe em branco pra não mexer):",
        currentPosition
      );
      if (newPositionRaw === null) return; // cancelou

      const body = { stage_id: stage.id, label: newLabel };
      if (newPositionRaw.trim() !== "") {
        const parsed = Number.parseInt(newPositionRaw, 10);
        if (!Number.isNaN(parsed)) body.position = parsed;
      }

      try {
        await api("/api/stage-labels", { method: "POST", body: JSON.stringify(body) });
        // Atualiza local e re-renderiza na hora — sem precisar clicar em
        // "Buscar tickets" de novo só pra ver a nova ordem/nome.
        for (const ticket of lastTickets) {
          if (ticket.stage.id === stage.id) {
            ticket.stage.name = newLabel;
            if (body.position !== undefined) ticket.stage.position = body.position;
          }
        }
        renderKanban(lastTickets);
        setStatus(discoverStatus, "Coluna atualizada.", false);
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
let lastTickets = [];
let stopRequested = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function updateDiscoverProgress({ ticketCount, creatorCount, clientsScanned, hasNames, done, stopped, phase }) {
  const namesNote = hasNames === false ? " (API não retornou nome/e-mail do criador — só o ID)" : "";
  const phaseNote =
    phase === "known"
      ? "Reconfirmando tickets já conhecidos…"
      : !done
        ? "Buscando tickets novos…"
        : stopped
          ? "Parado."
          : "Concluído.";
  setStatus(
    discoverStatus,
    `${phaseNote} ${ticketCount} ticket(s) aberto(s) em ${clientsScanned} cliente(s) verificados, ${creatorCount} criador(es) único(s).${namesNote}`,
    false
  );
}

// Carrega o Kanban salvo (mantido pelo polling a cada 15min, ver
// api/poll-tickets.js) assim que a página abre — fica disponível na hora,
// sem precisar clicar em "Buscar tickets", e só muda quando o polling
// realmente detectar algo novo. "Buscar tickets" continua disponível pra
// conferir ao vivo contra a SoftCS quando quiser.
async function loadStoredTickets() {
  try {
    const data = await api("/api/discover-tickets?source=stored");
    lastTickets = data.tickets;
    lastCreators = data.creators;
    renderKanban(lastTickets);
    if (lastCreators.length) renderCreators(lastCreators);
    if (lastTickets.length > 0) {
      setStatus(
        discoverStatus,
        `${lastTickets.length} ticket(s) — última atualização do polling automático. Clique em "Buscar todos os tickets abertos" pra conferir ao vivo contra a SoftCS agora.`,
        false
      );
    }
  } catch (err) {
    // Sem sessão SoftCS conectada ainda, ou tabela vazia (nenhum polling
    // rodou ainda) — não é erro fatal, só fica vazio até "Buscar tickets".
  }
}

async function runDiscoverLoop() {
  discoverBtn.disabled = true;
  stopDiscoverBtn.style.display = "inline-flex";
  stopRequested = false;

  kanbanBoard.innerHTML = "";
  // Map por id, não array: a fase known e a descoberta padrão podem achar o
  // mesmo ticket de novo (a descoberta não pula clientes já conhecidos) —
  // o Map evita duplicar cartão no Kanban, a entrada mais recente vence.
  const ticketsById = new Map();
  const allCreatorsById = new Map();
  let clientsScanned = 0;
  let offset = 0;
  let hasNames = false;

  function mergeAndRender(data, phase) {
    for (const ticket of data.tickets) ticketsById.set(ticket.id, ticket);
    for (const creator of data.creators) {
      if (!allCreatorsById.has(creator.id)) allCreatorsById.set(creator.id, creator);
    }
    if (data.clientsScanned) clientsScanned += data.clientsScanned;
    if (data.hasNames) hasNames = true;

    lastCreators = [...allCreatorsById.values()];
    lastTickets = [...ticketsById.values()];
    renderKanban(lastTickets);
    renderCreators(lastCreators);
    updateDiscoverProgress({
      ticketCount: lastTickets.length,
      creatorCount: lastCreators.length,
      clientsScanned,
      hasNames,
      done: false,
      phase,
    });
  }

  try {
    // Fase 1: reconfirma ao vivo os tickets que já estão salvos (poucos
    // clientes, rápido) — assim eles aparecem e se atualizam primeiro no
    // Kanban, mesmo que a descoberta abaixo demore, seja interrompida ou
    // esbarre no rate limit da SoftCS (que só afeta a descoberta, que roda
    // depois). Mostra a mensagem ANTES de esperar a resposta — como são
    // poucos clientes, a chamada é rápida o bastante pra passar
    // despercebida se só atualizarmos o status depois dela voltar.
    setStatus(discoverStatus, "Reconfirmando tickets já conhecidos…", false);
    try {
      const known = await api("/api/discover-tickets?phase=known");
      mergeAndRender(known, "known");
    } catch (err) {
      // Não trava a busca inteira por causa disso — só segue pra descoberta.
      setStatus(discoverStatus, `Aviso ao reconfirmar tickets conhecidos: ${err.message}`, true);
    }

    // Fase 2: descoberta ao vivo pelo resto da conta, em lotes.
    while (!stopRequested) {
      let data;
      try {
        data = await api(`/api/discover-tickets?offset=${offset}`);
      } catch (err) {
        if (!err.rateLimited) throw err;
        // A SoftCS limita requisições por IP a cada poucos minutos — espera o
        // tempo pedido e tenta o mesmo lote de novo, sem perder o progresso.
        for (let s = err.retryAfterSeconds; s > 0 && !stopRequested; s--) {
          setStatus(discoverStatus, `Limite da SoftCS atingido — retomando em ${s}s… (${ticketsById.size} ticket(s) até agora)`, true);
          await sleep(1000);
        }
        continue;
      }

      mergeAndRender(data, "discover");

      if (!data.hasMoreClients) break;
      offset = data.nextOffset;
    }

    updateDiscoverProgress({
      ticketCount: ticketsById.size,
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
const newChatMembers = document.getElementById("newChatMembers");

// Preenche um <select multiple> com todos os agentes conhecidos, marcando os
// que já pertencem ao chat (selectedIds). Usado no form "Novo chat" e no
// painel de edição de membros de cada chat existente.
function populateAgentOptions(selectEl, selectedIds) {
  const selected = new Set(selectedIds || []);
  selectEl.innerHTML = "";
  for (const agent of agentInfoById.values()) {
    const option = document.createElement("option");
    option.value = agent.softcs_user_id;
    option.textContent = `${agent.display_name || agent.email || agent.softcs_user_id}${agent.telegram_username ? " (@" + agent.telegram_username + ")" : " (sem @)"}`;
    option.selected = selected.has(agent.softcs_user_id);
    selectEl.appendChild(option);
  }
}

async function loadChats() {
  try {
    const chats = await api("/api/chats");
    chatList.innerHTML = "";
    chatEmpty.style.display = chats.length ? "none" : "block";
    for (const chat of chats) renderChatRow(chat);
    populateAgentOptions(newChatMembers, []);
  } catch (err) {
    setStatus(chatStatus, err.message, true);
  }
}

function renderChatRow(chat) {
  const wrapper = document.createElement("div");

  const row = document.createElement("div");
  row.className = "list-item";
  row.innerHTML = `
    <div class="list-item-main">
      <span class="list-item-title"></span>
      <span class="list-item-sub"></span>
    </div>
    <div class="list-item-actions">
      <span class="test-result status-line"></span>
      <button class="btn btn-secondary members-btn">Membros (${(chat.member_ids || []).length})</button>
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

  // ── Painel de membros (colapsado por padrão) ──
  const membersPanel = document.createElement("div");
  membersPanel.style.display = "none";
  membersPanel.style.margin = "0.5rem 0 0.75rem";
  membersPanel.innerHTML = `
    <select multiple size="6"></select>
    <div class="form-actions" style="margin-top: 0.5rem;">
      <button type="button" class="btn btn-primary save-members-btn">Salvar membros</button>
      <span class="members-status status-line"></span>
    </div>
  `;
  const membersSelect = membersPanel.querySelector("select");
  const membersStatus = membersPanel.querySelector(".members-status");

  row.querySelector(".members-btn").addEventListener("click", () => {
    const isOpen = membersPanel.style.display !== "none";
    if (isOpen) {
      membersPanel.style.display = "none";
    } else {
      populateAgentOptions(membersSelect, chat.member_ids);
      membersPanel.style.display = "block";
    }
  });

  membersPanel.querySelector(".save-members-btn").addEventListener("click", async (event) => {
    const btn = event.currentTarget;
    const memberIds = Array.from(membersSelect.selectedOptions).map((o) => o.value);
    btn.disabled = true;
    try {
      await api("/api/chats", {
        method: "POST",
        body: JSON.stringify({ chat_id: chat.chat_id, label: chat.label, member_ids: memberIds }),
      });
      setStatus(membersStatus, "Salvo.", false);
      await loadChats();
    } catch (err) {
      setStatus(membersStatus, err.message, true);
    } finally {
      btn.disabled = false;
    }
  });

  wrapper.append(row, membersPanel);
  chatList.appendChild(wrapper);
}

chatForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const memberIds = Array.from(newChatMembers.selectedOptions).map((o) => o.value);
  const data = {
    chat_id: chatForm.elements.chat_id.value.trim(),
    label: chatForm.elements.label.value.trim(),
    member_ids: memberIds,
  };
  try {
    await api("/api/chats", { method: "POST", body: JSON.stringify(data) });
    chatForm.reset();
    setStatus(chatStatus, "Adicionado.", false);
    await loadChats();
  } catch (err) {
    setStatus(chatStatus, err.message, true);
  }
});

// ─── Acesso (só master vê essa aba) ────────────────────────────────────────
const accessForm = document.getElementById("accessForm");
const accessStatus = document.getElementById("accessStatus");
const accessList = document.getElementById("accessList");
const accessNavItem = document.getElementById("accessNavItem");
const userEmail = document.getElementById("userEmail");

async function loadMe() {
  try {
    const me = await api("/api/me");
    userEmail.textContent = me.email;
    if (me.role === "master") {
      accessNavItem.style.display = "";
      await loadAccessList();
    }
  } catch (err) {
    // requireSession/api() já redireciona pro login em 401 — qualquer outro
    // erro aqui não deve travar o resto do painel.
  }
}

async function loadAccessList() {
  try {
    const rows = await api("/api/users");
    accessList.innerHTML = "";
    for (const row of rows) renderAccessRow(row);
  } catch (err) {
    setStatus(accessStatus, err.message, true);
  }
}

function renderAccessRow(row) {
  const item = document.createElement("div");
  item.className = "list-item";
  item.innerHTML = `
    <div class="list-item-main">
      <span class="list-item-title"></span>
      <span class="list-item-sub"></span>
    </div>
    <div class="list-item-actions"></div>
  `;
  item.querySelector(".list-item-title").textContent = row.display_name || row.email;
  item.querySelector(".list-item-sub").textContent = row.email;

  const actions = item.querySelector(".list-item-actions");
  if (row.master) {
    const badge = document.createElement("span");
    badge.className = "badge on";
    badge.textContent = "master";
    actions.appendChild(badge);
  } else {
    const deleteBtn = document.createElement("button");
    deleteBtn.className = "icon-btn danger-hover";
    deleteBtn.title = "Remover acesso";
    deleteBtn.textContent = "🗑";
    deleteBtn.addEventListener("click", async () => {
      if (!confirm(`Remover acesso de "${row.email}"?`)) return;
      try {
        await api(`/api/users?email=${encodeURIComponent(row.email)}`, { method: "DELETE" });
        await loadAccessList();
        setStatus(accessStatus, "Removido.", false);
      } catch (err) {
        setStatus(accessStatus, err.message, true);
      }
    });
    actions.appendChild(deleteBtn);
  }

  accessList.appendChild(item);
}

accessForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(accessForm));
  try {
    await api("/api/users", { method: "POST", body: JSON.stringify(data) });
    accessForm.reset();
    setStatus(accessStatus, "Liberado.", false);
    await loadAccessList();
  } catch (err) {
    setStatus(accessStatus, err.message, true);
  }
});

async function boot() {
  await loadMe();
  await loadAgents(); // precisa terminar antes: loadChats popula o seletor de membros, e o board salvo usa agentInfoById pro nome/@ do criador
  loadChats();
  loadConnection();
  loadStoredTickets();
}

boot();
