// Botão de TECLADO — aparece embaixo da caixa de digitar; tocar manda o
// texto do botão como se a pessoa tivesse digitado (ex: um botão "/status"
// manda a mensagem "/status", que o webhook processa normal). `rows` é uma
// lista de linhas, cada linha uma lista de textos de botão.
export function keyboardMarkup(rows) {
  return {
    keyboard: rows.map((row) => row.map((text) => ({ text }))),
    resize_keyboard: true,
  };
}

// Botão INLINE com link — aparece dentro da própria mensagem, permanece no
// histórico, e abre a URL direto (não passa pelo nosso webhook). `rows` é
// uma lista de linhas, cada linha uma lista de { text, url }.
export function inlineLinkMarkup(rows) {
  return {
    inline_keyboard: rows.map((row) => row.map(({ text, url }) => ({ text, url }))),
  };
}
