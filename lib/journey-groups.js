// Transforma o nome de um grupo (livre, com espaço/acento — ex: "Onboarding
// Ativo") na chave estável do grupo (ex: "onboarding_ativo", coluna
// journey_groups.command — o nome vem da época do bot do Telegram, em que
// isso virava um comando). Minúsculo, sem acento, só [a-z0-9_]. O grupo do
// CSM é "ka" (CSM_JOURNEY_GROUP em lib/ticket-notify.js), então o grupo KA
// precisa se chamar "KA".
export function slugifyCommand(name) {
  return (name ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32);
}
