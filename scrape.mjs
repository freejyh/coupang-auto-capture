import fs from "node:fs/promises";

const PRODUCTS_PATH = "products.json";
const RESULT_PATH = "result.json";
const STATUS_ORDER = ["반품-최상", "반품-상", "반품-중상", "반품-중", "반품-중하", "반품-하"];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function nowKST() {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date()).replace(" ", " ");
}

async function readJson(path, fallback) {
  try { return JSON.parse(await fs.readFile(path, "utf8")); }
  catch { return fallback; }
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function htmlToText(html) {
  return decodeHtml(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/반품\s*[·ㆍ･•∙.\-–—]\s*/g, "반품-")
    .replace(/반품\s+(최상|중상|중하|상|중|하)/g, "반품-$1")
    .replace(/반품\s*:\s*(최상|중상|중하|상|중|하)/g, "반품-$1")
    .trim();
}

function parseStatuses(html) {
  const text = normalizeText(htmlToText(html));
  const found = new Set();
  const re = /반품\s*[-–—·ㆍ•∙]?\s*(최상|중상|중하|상|중|하)(?!\s*품|고)/g;
  let match;
  while ((match = re.exec(text)) !== null) found.add(`반품-${match[1]}`);
  return STATUS_ORDER.filter(status => found.has(status));
}

async function fetchPage(url) {
  const res = await fetch(url, {
    redirect: "follow",
    headers: {
      "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.7,en;q=0.5",
      "Cache-Control": "no-cache",
      "Pragma": "no-cache",
      "Referer": "https://www.coupang.com/"
    }
  });

  const html = await res.text();
  return { ok: res.ok, statusCode: res.status, finalUrl: res.url, html };
}

function makeTelegramMessage(oldItems, newItems) {
  const oldMap = new Map((oldItems || []).map(item => [item.key, item]));
  const lines = [];

  for (const item of newItems) {
    const old = oldMap.get(item.key) || { statuses: [] };
    const before = new Set(old.statuses || []);
    const after = new Set(item.statuses || []);
    const added = [...after].filter(status => !before.has(status));
    const removed = [...before].filter(status => !after.has(status));

    if (added.length) lines.push(`✅ ${item.name}: ${added.join(" / ")} 추가`);
    if (removed.length && before.size > 0) lines.push(`➖ ${item.name}: ${removed.join(" / ")} 사라짐`);
  }

  if (!lines.length) return "";

  return ["쿠팡 반품 자동확보", ...lines, "", `확인시간: ${nowKST()}`].join("\n");
}

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId || !text) return;

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true })
  });

  if (!res.ok) console.log("Telegram failed", res.status, await res.text());
}

async function main() {
  const products = await readJson(PRODUCTS_PATH, []);
  const oldResult = await readJson(RESULT_PATH, { items: [] });
  const items = [];

  for (const product of products) {
    try {
      const page = await fetchPage(product.url);
      const statuses = page.ok ? parseStatuses(page.html) : [];

      items.push({
        ...product,
        checkedAt: nowKST(),
        status: page.ok ? "OK" : `HTTP_${page.statusCode}`,
        finalUrl: page.finalUrl,
        gradeCount: statuses.length,
        statuses
      });

      console.log(`${product.name}: ${statuses.length}종 ${statuses.join(", ") || "-"}`);
      await sleep(2800);
    } catch (error) {
      items.push({
        ...product,
        checkedAt: nowKST(),
        status: "FETCH_ERROR",
        error: String(error?.message || error),
        gradeCount: 0,
        statuses: []
      });
      console.log(`${product.name}: FETCH_ERROR`);
    }
  }

  const result = { version: "auto-flat-v3", updatedAt: nowKST(), items };
  await sendTelegram(makeTelegramMessage(oldResult.items, items));
  await fs.writeFile(RESULT_PATH, JSON.stringify(result, null, 2), "utf8");
  console.log(`Saved ${RESULT_PATH}`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
