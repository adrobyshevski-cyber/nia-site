/**
 * Тесты CRM: схема D1, дедупликация лидов, выборки, сделки, доступ.
 *
 * D1 подменён настоящим SQLite (node:sqlite) — миграция migrations/0001_init.sql
 * применяется как есть, поэтому проверяется и SQL, и схема. Сеть не используется.
 *
 * Запуск: node scripts/check-crm.mjs
 */

import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { createSessionToken } from "../lib/auth.js";
import {
  addActivity,
  createDeal,
  crmReady,
  deleteLead,
  applyRetention,
  dueReminders,
  exportDealsCsv,
  exportLeadsCsv,
  getLead,
  handleCrm,
  listLeads,
  recordLead,
  reminderMessage,
  runReminders,
  stats,
  updateDeal,
  updateLead,
} from "../lib/crm.js";

let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${name}\n       ${error.message}`);
  }
}

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

/** Мини-адаптер D1 поверх node:sqlite: prepare/bind/first/all/run/batch. */
function makeD1(sqlite) {
  return {
    prepare(sql) {
      const statement = { sql, params: [] };
      const api = {
        bind(...params) {
          statement.params = params;
          return api;
        },
        async first() {
          const row = sqlite.prepare(statement.sql).get(...statement.params);
          return row ? { ...row } : null;
        },
        async all() {
          const rows = sqlite.prepare(statement.sql).all(...statement.params);
          return { results: rows.map((row) => ({ ...row })), success: true };
        },
        async run() {
          const info = sqlite.prepare(statement.sql).run(...statement.params);
          return { success: true, meta: { changes: info.changes } };
        },
      };
      return api;
    },
    async batch(list) {
      const out = [];
      for (const item of list) out.push(await item.all());
      return out;
    },
  };
}

const MIGRATIONS = ["0001_init.sql", "0002_reminders.sql"].map((name) => ({
  name,
  sql: readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"),
}));

function freshDb() {
  const sqlite = new DatabaseSync(":memory:");
  for (const migration of MIGRATIONS) sqlite.exec(migration.sql);
  return { sqlite, db: makeD1(sqlite) };
}

const ENV = { SESSION_SECRET: "test-secret", ADMIN_PASSWORD_HASH: "sha256$x$y" };

const DEMO_LEAD = {
  source: "demo",
  name: "Анна Смирнова",
  email: "Anna@Example.ru",
  phone: "+7 999 123-45-67",
  site: "example.ru",
  event: "conf-2026",
  reportToken: "tok_1",
  consentAt: "2026-11-27T10:00:00.000Z",
};

const FORM_LEAD = {
  source: "audit_form",
  name: "Иван Петров",
  email: "ivan@company.ru",
  site: "company.ru",
  event: "/audit/",
};

async function main() {
  console.log("check-crm: схема и миграция");

  await check("миграция создаёт три таблицы", () => {
    const { sqlite } = freshDb();
    const names = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => row.name);
    for (const table of ["activities", "deals", "leads"]) assert(names.includes(table), `нет таблицы ${table}`);
  });

  await check("миграция идемпотентна (повторный запуск не падает)", () => {
    const { sqlite } = freshDb();
    sqlite.exec(MIGRATIONS[0].sql);
    sqlite.exec("DROP INDEX IF EXISTS idx_deals_remind");
    sqlite.exec(MIGRATIONS[1].sql.replace("ALTER TABLE deals ADD COLUMN reminded_at TEXT;", ""));
  });

  await check("миграция 0002 добавляет deals.reminded_at", () => {
    const { sqlite } = freshDb();
    const columns = sqlite.prepare("PRAGMA table_info(deals)").all().map((row) => row.name);
    assert(columns.includes("reminded_at"), `колонки: ${columns.join(", ")}`);
  });

  await check("report_token уникален, пустые значения не конфликтуют", () => {
    const { sqlite } = freshDb();
    const insert = sqlite.prepare(
      "INSERT INTO leads (id, created_at, source, email, report_token) VALUES (?, ?, 'manual', ?, ?)",
    );
    insert.run("a", "2026-01-01", "a@x.ru", null);
    insert.run("b", "2026-01-02", "b@x.ru", null);
    insert.run("c", "2026-01-03", "c@x.ru", "tok");
    let threw = false;
    try {
      insert.run("d", "2026-01-04", "d@x.ru", "tok");
    } catch {
      threw = true;
    }
    assert(threw, "дубль report_token должен падать");
  });

  console.log("check-crm: запись лидов");

  await check("без биндинга DB recordLead молча возвращает null", async () => {
    assert(crmReady({}) === false, "crmReady должен быть false без DB");
    assert((await recordLead({}, DEMO_LEAD)) === null, "ожидали null");
    assert((await recordLead(null, DEMO_LEAD)) === null, "ожидали null для null env");
  });

  await check("лид из /demo пишется со всеми полями", async () => {
    const { db } = freshDb();
    const id = await recordLead({ DB: db }, DEMO_LEAD);
    assert(typeof id === "string" && id.length > 10, "нет id");
    const card = await getLead({ DB: db }, id);
    assert(card.lead.email === "anna@example.ru", `email не нормализован: ${card.lead.email}`);
    assert(card.lead.phone === DEMO_LEAD.phone, "телефон потерян");
    assert(card.lead.site === "example.ru", "сайт потерян");
    assert(card.lead.event === "conf-2026", "событие потеряно");
    assert(card.lead.status === "new", "стадия по умолчанию не new");
    assert(card.lead.report_token === "tok_1", "report_token не сохранён");
    assert(card.lead.consent_at === DEMO_LEAD.consentAt, "согласие не сохранено");
  });

  await check("повторная заявка по тому же report_token обновляет лид, а не создаёт новый", async () => {
    const { db } = freshDb();
    const first = await recordLead({ DB: db }, DEMO_LEAD);
    const second = await recordLead({ DB: db }, { source: "audit_form", email: "new@example.ru", reportToken: "tok_1" });
    assert(first === second, `разные id: ${first} / ${second}`);
    const { items } = await listLeads({ DB: db });
    assert(items.length === 1, `ожидали 1 лид, получили ${items.length}`);
    assert(items[0].email === "new@example.ru", "email не обновился");
  });

  await check("лид без email и телефона не создаётся", async () => {
    const { db } = freshDb();
    assert((await recordLead({ DB: db }, { source: "demo", name: "Аноним" })) === null, "ожидали null");
    assert((await listLeads({ DB: db })).items.length === 0, "лишняя запись");
  });

  await check("неизвестный источник приводится к manual", async () => {
    const { db } = freshDb();
    const id = await recordLead({ DB: db }, { source: "spam", email: "x@y.ru" });
    const card = await getLead({ DB: db }, id);
    assert(card.lead.source === "manual", `источник: ${card.lead.source}`);
  });

  await check("запись лида не падает при сломанной базе", async () => {
    const broken = {
      prepare() {
        throw new Error("D1 недоступен");
      },
    };
    const errors = [];
    const realError = console.error;
    console.error = (...args) => errors.push(args.join(" "));
    const id = await recordLead({ DB: broken }, FORM_LEAD);
    console.error = realError;
    assert(id === null, "ожидали null");
    assert(errors.length === 1, "ошибка должна попасть в лог");
  });

  console.log("check-crm: список, карточка, поиск");

  async function seed() {
    const { db } = freshDb();
    const demo = await recordLead({ DB: db }, DEMO_LEAD);
    const form = await recordLead({ DB: db }, FORM_LEAD);
    return { db, demo, form };
  }

  await check("список сортирует по дате и считает total", async () => {
    const { db } = await seed();
    const { items, total } = await listLeads({ DB: db });
    assert(total === 2, `total: ${total}`);
    assert(items.length === 2, `items: ${items.length}`);
    assert(items[0].created_at >= items[1].created_at, "порядок не по убыванию даты");
  });

  await check("фильтр по стадии и по источнику", async () => {
    const { db } = await seed();
    const demo = await listLeads({ DB: db }, { source: "demo" });
    assert(demo.items.length === 1 && demo.items[0].email === "anna@example.ru", "фильтр по источнику сломан");
    const won = await listLeads({ DB: db }, { status: "won" });
    assert(won.items.length === 0, "фильтр по стадии сломан");
    const fresh = await listLeads({ DB: db }, { status: "new" });
    assert(fresh.items.length === 2, "фильтр new сломан");
  });

  await check("поиск идёт по имени, email и сайту", async () => {
    const { db } = await seed();
    for (const q of ["Анна", "anna@example", "company.ru"]) {
      const { items } = await listLeads({ DB: db }, { q });
      assert(items.length === 1, `поиск «${q}» дал ${items.length}`);
    }
    assert((await listLeads({ DB: db }, { q: "нет-такого" })).items.length === 0, "ложное совпадение");
  });

  await check("символы % и _ в поиске экранируются", async () => {
    const { db } = await seed();
    assert((await listLeads({ DB: db }, { q: "%" })).items.length === 0, "% не должен совпадать со всеми");
    assert((await listLeads({ DB: db }, { q: "_" })).items.length === 0, "_ не должен совпадать со всеми");
  });

  await check("limit и offset ограничены и работают", async () => {
    const { db } = await seed();
    const page = await listLeads({ DB: db }, { limit: 1, offset: 1 });
    assert(page.items.length === 1, "пагинация сломана");
    assert(page.limit === 1 && page.offset === 1, "эхо параметров");
    const big = await listLeads({ DB: db }, { limit: 100000 });
    assert(big.limit === 200, `limit не ограничен: ${big.limit}`);
  });

  await check("карточка несуществующего лида — null", async () => {
    const { db } = await seed();
    assert((await getLead({ DB: db }, "nope")) === null, "ожидали null");
  });

  console.log("check-crm: изменения");

  await check("смена стадии лида пишет активность", async () => {
    const { db, demo } = await seed();
    const card = await updateLead({ DB: db }, demo, { status: "contacted" });
    assert(card.lead.status === "contacted", "стадия не изменилась");
    const stage = card.activities.find((act) => act.kind === "stage");
    assert(stage && stage.text.includes("new → contacted"), "активность стадии не записана");
  });

  await check("некорректный email и неизвестная стадия отклоняются", async () => {
    const { db, demo } = await seed();
    let emailError = "";
    try {
      await updateLead({ DB: db }, demo, { email: "не-адрес" });
    } catch (error) {
      emailError = error.message;
    }
    assert(emailError.includes("электронной почты"), `ожидали ошибку email, получили «${emailError}»`);

    let stageError = "";
    try {
      await updateLead({ DB: db }, demo, { status: "thinking" });
    } catch (error) {
      stageError = error.message;
    }
    assert(stageError.includes("стадия"), `ожидали ошибку стадии, получили «${stageError}»`);
  });

  await check("пустая заметка не пишется", async () => {
    const { db, demo } = await seed();
    let message = "";
    try {
      await addActivity({ DB: db }, demo, { kind: "note", text: "   " });
    } catch (error) {
      message = error.message;
    }
    assert(message.includes("Пустая заметка"), `получили «${message}»`);
  });

  await check("заметка добавляется и видна в карточке", async () => {
    const { db, demo } = await seed();
    await addActivity({ DB: db }, demo, { kind: "call", text: "Созвонились, ждут смету" });
    const card = await getLead({ DB: db }, demo);
    assert(card.activities.length === 1, "заметка не сохранилась");
    assert(card.activities[0].kind === "call", "тип заметки неверный");
  });

  await check("сделка создаётся с услугой и стадией", async () => {
    const { db, demo } = await seed();
    const deal = await createDeal({ DB: db }, demo, { service: "audit", stage: "contacted", next_step: "Отправить смету" });
    assert(deal && deal.service === "audit" && deal.stage === "contacted", "сделка не создана");
    const card = await getLead({ DB: db }, demo);
    assert(card.deals.length === 1, "сделка не привязана к лиду");
  });

  await check("неизвестная услуга отклоняется", async () => {
    const { db, demo } = await seed();
    let message = "";
    try {
      await createDeal({ DB: db }, demo, { service: "маркетинг" });
    } catch (error) {
      message = error.message;
    }
    assert(message.includes("услуг"), `получили «${message}»`);
  });

  await check("смена стадии сделки пишет активность и обновляет updated_at", async () => {
    const { db, demo } = await seed();
    const deal = await createDeal({ DB: db }, demo, { service: "brand" });
    const updated = await updateDeal({ DB: db }, deal.id, { stage: "proposal", next_step_at: "2026-12-01T09:00:00.000Z" });
    assert(updated.stage === "proposal", "стадия сделки не изменилась");
    assert(updated.next_step_at === "2026-12-01T09:00:00.000Z", "дата шага не сохранена");
    const card = await getLead({ DB: db }, demo);
    assert(card.activities.some((act) => act.deal_id === deal.id), "активность по сделке не записана");
  });

  await check("сумма сделки сохраняется, обновляется и валидируется", async () => {
    const { db, demo } = await seed();
    const deal = await createDeal({ DB: db }, demo, { service: "audit", amount: 120000 });
    assert(Number(deal.amount) === 120000, `сумма при создании: ${deal.amount}`);

    const updated = await updateDeal({ DB: db }, deal.id, { amount: "250000" });
    assert(Number(updated.amount) === 250000, `сумма не обновилась: ${updated.amount}`);

    const cleared = await updateDeal({ DB: db }, deal.id, { amount: null });
    assert(cleared.amount === null, `пустая сумма не обнулилась: ${cleared.amount}`);

    let negative = "";
    try {
      await updateDeal({ DB: db }, deal.id, { amount: -5 });
    } catch (error) {
      negative = error.message;
    }
    assert(negative.includes("Сумма"), `отрицательная сумма не отклонена: «${negative}»`);

    let garbage = "";
    try {
      await createDeal({ DB: db }, demo, { service: "brand", amount: "много" });
    } catch (error) {
      garbage = error.message;
    }
    assert(garbage.includes("Сумма"), `нечисловая сумма не отклонена: «${garbage}»`);
  });

  await check("удаление лида уносит сделки и активности", async () => {
    const { db, demo } = await seed();
    await createDeal({ DB: db }, demo, { service: "lab" });
    await addActivity({ DB: db }, demo, { kind: "note", text: "проверка каскада" });
    assert((await deleteLead({ DB: db }, demo)) === true, "лид не удалён");
    const card = await getLead({ DB: db }, demo);
    assert(card === null, "лид остался");
    const leftovers = await db.prepare("SELECT COUNT(*) AS n FROM deals WHERE lead_id = ?").bind(demo).first();
    assert(Number(leftovers.n) === 0, "сделки не удалились каскадом");
  });

  await check("сводка считает лиды, сделки и ближайшие шаги", async () => {
    const { db, demo } = await seed();
    const deal = await createDeal({ DB: db }, demo, { service: "strategy" });
    await updateDeal({ DB: db }, deal.id, { next_step_at: new Date(Date.now() + 86400_000).toISOString() });
    const summary = await stats({ DB: db });
    assert(Number(summary.totals.leads) === 2, `лидов: ${summary.totals.leads}`);
    assert(Number(summary.totals.open_deals) === 1, "открытых сделок не 1");
    assert(summary.sources.length >= 1, "разрез по источникам пуст");
    assert(summary.upcoming.length === 1, "ближайшие шаги не попали в сводку");
  });

  console.log("check-crm: CSV, события, срок хранения");

  await check("CSV лидов: BOM, заголовок, разделитель ;", async () => {
    const { db } = await seed();
    const csv = await exportLeadsCsv({ DB: db });
    assert(csv.startsWith("\uFEFF"), "нет BOM для Excel");
    const lines = csv.slice(1).split("\r\n").filter(Boolean);
    assert(lines[0].split(";")[0] === "id" && lines[0].includes("email"), `заголовок: ${lines[0]}`);
    assert(lines.length === 3, `строк: ${lines.length}`);
  });

  await check("CSV лидов: фильтры и экранирование кавычек и ;", async () => {
    const { db } = freshDb();
    await recordLead({ DB: db }, { source: "manual", email: "a@b.ru", name: 'ООО "Ромашка"; отдел' });
    const filtered = await exportLeadsCsv({ DB: db }, { source: "manual" });
    assert(filtered.includes('"ООО ""Ромашка""; отдел"'), `поле не экранировано: ${filtered}`);

    const empty = await exportLeadsCsv({ DB: db }, { source: "demo" });
    assert(empty.slice(1).split("\r\n").filter(Boolean).length === 1, "фильтр не применился к CSV");
  });

  await check("CSV сделок: лид, услуга, сумма, стадия", async () => {
    const { db, demo } = await seed();
    const deal = await createDeal({ DB: db }, demo, { service: "strategy", stage: "proposal", amount: 90000 });
    const csv = await exportDealsCsv({ DB: db });
    assert(csv.startsWith("\uFEFF"), "нет BOM");
    assert(csv.includes("lead_email"), "нет заголовка с email лида");
    assert(csv.includes(deal.id) && csv.includes("90000") && csv.includes("proposal"), `нет данных сделки: ${csv}`);
  });

  await check("сводка разбивает по событиям и считает отчёты", async () => {
    const { db } = await seed();
    const summary = await stats({ DB: db });
    const conf = summary.events.find((row) => row.event === "conf-2026");
    assert(conf && conf.n === 1 && conf.reports === 1, `события: ${JSON.stringify(summary.events)}`);
    const form = summary.events.find((row) => row.event === "/audit/");
    assert(form && form.reports === 0, `форма сайта не должна считаться отчётом: ${JSON.stringify(form)}`);
  });

  async function seedAged() {
    const { db, demo, form } = await seed();
    const old = new Date(Date.now() - 200 * 86400_000).toISOString();
    await db.prepare("UPDATE leads SET created_at = ? WHERE id = ?").bind(old, demo).run();
    await addActivity({ DB: db }, demo, { kind: "note", text: "старая заметка" });
    await db.prepare("UPDATE activities SET at = ? WHERE lead_id = ?").bind(old, demo).run();
    return { db, demo, form, old };
  }

  await check("срок хранения: dry-run только считает и ничего не меняет", async () => {
    const { db, demo } = await seedAged();
    const result = await applyRetention({ DB: db }, { days: 180 });
    assert(result.dryRun === true, "по умолчанию должен быть dry-run");
    assert(result.leads === 1, `лидов под обезличивание: ${result.leads}`);
    assert(result.activities === 1, `заметок к удалению: ${result.activities}`);

    const card = await getLead({ DB: db }, demo);
    assert(card.lead.email === "anna@example.ru", "dry-run изменил данные");
  });

  await check("срок хранения: обезличивает старый лид, свежий не трогает, заметки чистит", async () => {
    const { db, demo, form } = await seedAged();
    const result = await applyRetention({ DB: db }, { days: 180, dryRun: false });
    assert(result.leads === 1 && result.activities === 1, JSON.stringify(result));

    const old = await getLead({ DB: db }, demo);
    assert(old.lead.name === null && old.lead.email === null && old.lead.phone === null, "контакты не обезличены");
    assert(old.lead.report_token === null, "токен отчёта остался");
    assert(old.activities.length === 0, "старые заметки не удалены");
    assert(old.lead.site === "example.ru" && old.lead.event === "conf-2026", "аналитику потеряли");
    assert(old.lead.created_at < new Date(Date.now() - 180 * 86400_000).toISOString(), "дата создания изменилась");

    const fresh = await getLead({ DB: db }, form);
    assert(fresh.lead.email === "ivan@company.ru", "свежий лид обезличен");
  });

  await check("срок хранения не трогает лид с открытой сделкой", async () => {
    const { db, demo } = await seedAged();
    await createDeal({ DB: db }, demo, { service: "audit", stage: "proposal" });
    const result = await applyRetention({ DB: db }, { days: 180, dryRun: false });
    assert(result.leads === 0 && result.keptOpen === 1, JSON.stringify(result));
    const card = await getLead({ DB: db }, demo);
    assert(card.lead.email === "anna@example.ru", "лид с открытой сделкой обезличен");
  });

  console.log("check-crm: напоминания");

  const past = new Date(Date.now() - 3 * 3600_000).toISOString();
  const future = new Date(Date.now() + 3 * 3600_000).toISOString();

  async function seedDeal({ service = "audit", stage = "proposal", nextStep = "Отправить смету", when = past } = {}) {
    const { db, demo } = await seed();
    const deal = await createDeal({ DB: db }, demo, { service });
    await updateDeal({ DB: db }, deal.id, { stage, next_step: nextStep, next_step_at: when });
    return { db, demo, deal };
  }

  await check("в выборку попадают только наступившие шаги", async () => {
    const { db } = await seedDeal();
    assert((await dueReminders({ DB: db })).length === 1, "наступивший шаг не попал в выборку");

    const later = await seedDeal({ when: future });
    assert((await dueReminders({ DB: later.db })).length === 0, "будущий шаг не должен напоминаться");

    const won = await seedDeal({ stage: "won" });
    assert((await dueReminders({ DB: won.db })).length === 0, "закрытая сделка не должна напоминаться");

    const lost = await seedDeal({ stage: "lost" });
    assert((await dueReminders({ DB: lost.db })).length === 0, "проигранная сделка не должна напоминаться");
  });

  await check("шаг без даты не напоминается", async () => {
    const { db, demo } = await seed();
    await createDeal({ DB: db }, demo, { service: "brand", next_step: "Позвонить" });
    assert((await dueReminders({ DB: db })).length === 0, "сделка без next_step_at попала в напоминания");
  });

  await check("текст сообщения: услуга, шаг, контакт и deeplink", () => {
    const html = reminderMessage([
      {
        id: "d1",
        lead_id: "L-1",
        service: "audit",
        stage: "proposal",
        next_step: "Отправить <смету>",
        next_step_at: past,
        name: "Иван Петров",
        site: "company.ru",
      },
    ], past);
    assert(html.includes("audit · proposal"), "нет услуги и стадии");
    assert(html.includes("Отправить &lt;смету&gt;"), "нет шага или не экранирован HTML");
    assert(html.includes("Иван Петров") && html.includes("company.ru"), "нет контакта");
    assert(html.includes("/crm/?lead=L-1"), "нет deeplink на карточку");
  });

  await check("runReminders отправляет один раз и пишет в ленту", async () => {
    const { db, demo } = await seedDeal();
    const sent = [];
    const notify = async (html) => sent.push(html);

    const first = await runReminders({ DB: db }, notify);
    assert(first.sent === 1, `первый запуск: ${first.sent}`);
    assert(sent.length === 1, `сообщений: ${sent.length}`);
    assert(sent[0].includes("Отправить смету"), "в сообщении нет шага");

    const second = await runReminders({ DB: db }, notify);
    assert(second.sent === 0 && second.due === 0, "повторная отправка без нового срока");
    assert(sent.length === 1, "второе сообщение не должно уходить");

    const card = await getLead({ DB: db }, demo);
    assert(card.activities.some((act) => act.kind === "system"), "событие напоминания не попало в ленту");
  });

  await check("сбой Telegram не помечает шаг — уйдёт следующим запуском", async () => {
    const { db } = await seedDeal();
    const realError = console.error;
    console.error = () => {};
    const failed = await runReminders({ DB: db }, async () => {
      throw new Error("Telegram 500");
    });
    console.error = realError;

    assert(failed.sent === 0 && failed.due === 1, `итог: ${JSON.stringify(failed)}`);
    assert((await dueReminders({ DB: db })).length === 1, "шаг отмечен напомненным при сбое");
  });

  await check("новый next_step_at сбрасывает отметку и шаг напоминается снова", async () => {
    const { db, deal } = await seedDeal();
    let count = 0;
    const notify = async () => {
      count += 1;
    };
    await runReminders({ DB: db }, notify);
    assert(count === 1, "первое напоминание не ушло");
    assert((await dueReminders({ DB: db })).length === 0, "шаг не отмечен");

    await updateDeal({ DB: db }, deal.id, { next_step_at: past });
    assert((await dueReminders({ DB: db })).length === 1, "отметка не сброшена новым сроком");
    await runReminders({ DB: db }, notify);
    assert(count === 2, "повторное напоминание не ушло");
  });

  await check("без D1 runReminders не падает", async () => {
    const result = await runReminders({}, async () => {});
    assert(result.sent === 0 && result.skipped === "no-db", JSON.stringify(result));
  });

  console.log("check-crm: API и доступ");

  async function callCrm(env, { method = "GET", path = "/api/crm/leads", body, origin, cookie, deps } = {}) {
    const headers = { "content-type": "application/json" };
    if (origin) headers.origin = origin;
    if (cookie) headers.cookie = cookie;
    const request = new Request(`https://narrativeintelligence.ru${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    // третий аргумент — только pathname: query разбирается из request.url
    const response = await handleCrm(request, env, new URL(request.url).pathname, deps);
    const data = await response.clone().json().catch(() => ({}));
    return { status: response.status, data };
  }

  const cookieFor = async (env) => `nia_studio=${await createSessionToken(env)}`;

  await check("без сессии API отвечает 401", async () => {
    const { db } = freshDb();
    const { status, data } = await callCrm({ ...ENV, DB: db });
    assert(status === 401, `статус: ${status}`);
    assert(data.ok === false, "нет ok:false");
  });

  await check("чужой Origin для записи — 403", async () => {
    const { db } = freshDb();
    const cookie = await cookieFor({ ...ENV, DB: db });
    const { status } = await callCrm({ ...ENV, DB: db }, {
      method: "POST",
      path: "/api/crm/leads/1/activities",
      body: { text: "x" },
      origin: "https://evil.example",
      cookie,
    });
    assert(status === 403, `статус: ${status}`);
  });

  await check("без D1 API отвечает 503 с подсказкой", async () => {
    const env = { ...ENV };
    const cookie = await cookieFor(env);
    const { status, data } = await callCrm(env, { cookie });
    assert(status === 503, `статус: ${status}`);
    assert(/D1/.test(data.error || ""), `текст: ${data.error}`);
  });

  await check("список лидов и карточка доступны с сессией", async () => {
    const { db } = await seed();
    const env = { ...ENV, DB: db };
    const cookie = await cookieFor(env);
    const list = await callCrm(env, { cookie });
    assert(list.status === 200 && list.data.items.length === 2, `статус ${list.status}, items ${list.data.items?.length}`);

    const id = list.data.items[0].id;
    const card = await callCrm(env, { cookie, path: `/api/crm/leads/${id}` });
    assert(card.status === 200 && card.data.lead.id === id, "карточка не отдалась");
  });

  await check("PATCH лида меняет стадию, неизвестный id — 404", async () => {
    const { db, demo } = await seed();
    const env = { ...ENV, DB: db };
    const cookie = await cookieFor(env);
    const patched = await callCrm(env, { cookie, method: "PATCH", path: `/api/crm/leads/${demo}`, body: { status: "qualified" } });
    assert(patched.status === 200 && patched.data.lead.status === "qualified", "стадия не обновилась");

    const missing = await callCrm(env, { cookie, method: "PATCH", path: "/api/crm/leads/nope", body: { status: "won" } });
    assert(missing.status === 404, `статус: ${missing.status}`);
  });

  await check("невалидный лид вручную — 400", async () => {
    const { db } = freshDb();
    const env = { ...ENV, DB: db };
    const cookie = await cookieFor(env);
    const { status, data } = await callCrm(env, { cookie, method: "POST", path: "/api/crm/leads", body: { name: "Без контакта" } });
    assert(status === 400, `статус: ${status}`);
    assert(/email|телефон/i.test(data.error || ""), `текст: ${data.error}`);
  });

  await check("ручной лид с заметкой: создаётся, заметка в карточке", async () => {
    const { db } = freshDb();
    const env = { ...ENV, DB: db };
    const cookie = await cookieFor(env);
    const created = await callCrm(env, {
      cookie,
      method: "POST",
      path: "/api/crm/leads",
      body: { name: "Пётр Сидоров", phone: "+7 999 000-11-22", site: "petrov.ru", notes: "Познакомились на конференции" },
    });
    assert(created.status === 200, `статус: ${created.status}`);
    assert(created.data.lead.source === "manual", `источник: ${created.data.lead.source}`);
    assert(created.data.lead.notes === "Познакомились на конференции", `заметка: ${created.data.lead.notes}`);
    assert(created.data.lead.email === null, "email должен остаться пустым");

    const list = await callCrm(env, { cookie, path: "/api/crm/leads?source=manual" });
    assert(list.data.total === 1, `в списке: ${list.data.total}`);
  });

  await check("CSV и срок хранения через API: сессия, dry-run по умолчанию", async () => {
    const { db, demo } = await seedAged();
    const env = { ...ENV, DB: db };
    const cookie = await cookieFor(env);

    const anonymous = await callCrm(env, { path: "/api/crm/export.csv" });
    assert(anonymous.status === 401, `CSV без сессии: ${anonymous.status}`);

    const request = new Request("https://narrativeintelligence.ru/api/crm/export.csv?type=leads&source=demo", {
      headers: { cookie },
    });
    const response = await handleCrm(request, env, "/api/crm/export.csv");
    assert(response.status === 200, `CSV: ${response.status}`);
    assert((response.headers.get("content-type") || "").includes("text/csv"), "не text/csv");
    assert((response.headers.get("content-disposition") || "").includes("nia-crm-leads-"), "нет имени файла");
    const body = await response.text();
    assert(body.includes("anna@example.ru"), "фильтр source=demo не сработал");

    const retention = await callCrm(env, { cookie, method: "POST", path: "/api/crm/retention/run" });
    assert(retention.status === 200 && retention.data.dryRun === true, JSON.stringify(retention.data));

    const card = await getLead({ DB: db }, demo);
    assert(card.lead.email === "anna@example.ru", "API-запуск без dry=0 изменил данные");

    const real = await callCrm(env, { cookie, method: "POST", path: "/api/crm/retention/run?dry=0" });
    assert(real.data.dryRun === false && real.data.leads === 1, JSON.stringify(real.data));
  });

  await check("неизвестный маршрут — 404, health — 200", async () => {
    const { db } = freshDb();
    const env = { ...ENV, DB: db };
    const cookie = await cookieFor(env);
    const unknown = await callCrm(env, { cookie, path: "/api/crm/nothing" });
    assert(unknown.status === 404, `статус: ${unknown.status}`);
    const health = await callCrm(env, { cookie, path: "/api/crm/health" });
    assert(health.status === 200 && health.data.d1 === true, "health не отвечает");
  });

  await check("ручной запуск напоминаний: 401 без сессии, 503 без Telegram, отправка с каналом", async () => {
    const { db } = await seedDeal();
    const env = { ...ENV, DB: db };
    const cookie = await cookieFor(env);

    const anonymous = await callCrm(env, { method: "POST", path: "/api/crm/reminders/run" });
    assert(anonymous.status === 401, `без сессии: ${anonymous.status}`);

    const noChannel = await callCrm(env, { cookie, method: "POST", path: "/api/crm/reminders/run" });
    assert(noChannel.status === 503, `без notify: ${noChannel.status}`);

    const sent = [];
    const withChannel = await callCrm(env, {
      cookie,
      method: "POST",
      path: "/api/crm/reminders/run",
      deps: { notify: async (html) => sent.push(html) },
    });
    assert(withChannel.status === 200 && withChannel.data.sent === 1, JSON.stringify(withChannel.data));
    assert(sent.length === 1, "сообщение не ушло");

    const again = await callCrm(env, {
      cookie,
      method: "POST",
      path: "/api/crm/reminders/run",
      deps: { notify: async (html) => sent.push(html) },
    });
    assert(again.data.sent === 0, "повторный ручной запуск отправил дубль");
  });

  console.log(failed ? `\ncheck-crm: провалено ${failed}` : "\ncheck-crm: все проверки пройдены");
  if (failed) process.exit(1);
}

main();
