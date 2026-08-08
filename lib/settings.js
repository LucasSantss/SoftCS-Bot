import sql from './db.js';

export async function getSettings() {
  const rows = await sql`select key, value from settings`;
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

export async function getSetting(key) {
  const rows = await sql`select value from settings where key = ${key}`;
  return rows[0]?.value ?? null;
}

export async function setSettings(entries) {
  for (const [key, value] of Object.entries(entries)) {
    await sql`
      insert into settings (key, value) values (${key}, ${value})
      on conflict (key) do update set value = excluded.value, updated_at = now()
    `;
  }
}
