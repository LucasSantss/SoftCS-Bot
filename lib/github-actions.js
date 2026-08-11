const REPO = 'LucasSantss/SoftCS-Bot';
const BRANCH = 'LucasSantss';
const WORKFLOWS = ['poll-known.yml', 'poll-tickets.yml'];

async function dispatchWorkflow(workflowFile, token) {
  const res = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/${workflowFile}/dispatches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ref: BRANCH }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API ${res.status}: ${text}`);
  }
}

// Dispara os dois workflows de polling na hora, em vez de esperar o próximo
// tick do cron (até 5min pro known, até 15min pra descoberta) — chamado
// logo depois de uma reconexão OAuth bem-sucedida (ver api/softcs-oauth.js),
// pra aproveitar ao máximo a janela de ~15min que o token acabou de ganhar.
// Sem isso, boa parte dessa janela podia se perder só esperando o relógio
// do cron, o que importa muito enquanto não houver refresh_token (essa
// janela de 15min é tudo que existe até a próxima reconexão manual).
//
// Precisa de GITHUB_DISPATCH_TOKEN (personal access token com permissão de
// Actions: Read and write no repositório) — sem essa env var configurada,
// não faz nada e não trava o resto do fluxo de conexão.
export async function triggerPollWorkflows() {
  const token = process.env.GITHUB_DISPATCH_TOKEN;
  if (!token) return;

  await Promise.all(
    WORKFLOWS.map((workflow) =>
      dispatchWorkflow(workflow, token).catch((err) => console.error(`Falha ao disparar ${workflow}:`, err.message))
    )
  );
}
