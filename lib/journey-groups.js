// Transforma o nome de um grupo (livre, com espaço/acento — ex: "Onboarding
// Ativo") no comando de verdade que a pessoa digita/toca no Telegram (ex:
// "onboarding_ativo", vira /onboarding_ativo). Minúsculo, sem acento, só
// [a-z0-9_] — evita depender de Unicode em nome de comando, mais portável.
// Usado tanto ao criar/editar um grupo (api/chats.js) quanto ao interpretar
// o que a pessoa mandou pro bot (api/telegram-webhook.js), pros dois lados
// baterem sempre.
export function slugifyCommand(name) {
  return (name ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32);
}
