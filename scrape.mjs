import fs from "node:fs/promises";

const PRODUCTS_PATH = "products.json";
const RESULT_PATH = "result.json";

const STATUS_ORDER = [
  "반품-최상",
  "반품-상",
  "반품-중상",
  "반품-중",
  "반품-중하",
  "반품-하"
];

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
  try {
    return JSON.parse(await fs.readFile(path, "utf8"));
  } catch {
    return fallback;
  }
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

function detectSoldOut(html) {
  const raw = normalizeText(decodeHtml(html));
  const text = normalizeText(htmlToText(html));

  const combined = `${raw} ${text}`;

  const strongSoldOutPatterns = [
    /일시\s*품절/i,
    /일시품절/i,
    /품절되었습니다/i,
    /현재\s*상품이\s*품절/i,
    /현재\s*구매할\s*수\s*없는\s*상품/i,
    /구매할\s*수\s*없는\s*상품/i,
    /판매가\s*종료/i,
    /판매\s*종료/i,
    /판매\s*중지/i,
    /재입고\s*알림/i,
    /out\s*of\s*stock/i,
    /sold\s*out/i,
    /soldout/i,
    /outOfStock/i,
    /SOLD_OUT/i
  ];

  return strongSoldOutPatterns.some(pattern => pattern.test(combined));
}

function parseStatuses(html) {
  const text = normalizeText(htmlToText(html));
  const found = new Set();

  const re = /반품\s*[-–—·ㆍ•∙]?\s*(최상|중상|중하|상|중|하)(?!\s*품|고)/g;
  let match;

  while ((match = re.exec(text)) !== null) {
    found.add(`반품-${match[1]}`);
  }

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

  return {
    ok: res.ok,
    statusCode: res.status,
    finalUrl: res.url,
    html
  };
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

    if (added.length) {
      lines.push(`✅ ${item.name}: ${added.join(" / ")} 추가`);
    }

    if (removed.length && before.size > 0) {
      lines.push(`➖ ${item.name}: ${removed.join(" / ")} 사라짐`);
    }

    if (item.soldOut && before.size > 0) {
      lines.push(`❌ ${item.name}: 품절 처리`);
    }
  }

  if (!lines.length) return "";

  return [
    "쿠팡 반품 자동확보",
    ...lines,
    "",
    `확인시간: ${nowKST()}`
  ].join("\n");
}

function makeManualTestMessage(items) {
  const hits = (items || []).filter(item => Number(item.gradeCount || 0) > 0);
  const soldOuts = (items || []).filter(item => item.soldOut);
  const totalGrade = hits.reduce((sum, item) => sum + Number(item.gradeCount || 0), 0);

  const lines = [
    "쿠팡 반품 자동확보 테스트",
    "변화 없음",
    `확보 상품: ${hits.length}개`,
    `등급 합계: ${totalGrade}종`,
    `품절 감지: ${soldOuts.length}개`,
    `확인시간: ${nowKST()}`
  ];

  if (hits.length) {
    lines.push("");
    lines.push("현재 확보 상태");

    for (const item of hits) {
      lines.push(`• ${item.name}: ${(item.statuses || []).join(" / ")} (${item.gradeCount}종)`);
    }
  }

  return lines.join("\n");
}

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId || !text) {
    console.log("Telegram skipped: missing token/chat_id or empty message");
    return;
  }

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true
    })
  });

  if (!res.ok) {
    console.log("Telegram failed", res.status, await res.text());
  } else {
    console.log("Telegram sent");
  }
}

async function main() {
  const products = await readJson(PRODUCTS_PATH, []);
  const oldResult = await readJson(RESULT_PATH, { items: [] });

  const items = [];

  for (const product of products) {
    try {
      const page = await fetchPage(product.url);

      let soldOut = false;
      let statuses = [];

      if (page.ok) {
        soldOut = detectSoldOut(page.html);

        if (soldOut) {
          statuses = [];
        } else {
          statuses = parseStatuses(page.html);
        }
      }

      items.push({
        ...product,
        checkedAt: nowKST(),
        status: page.ok ? (soldOut ? "SOLD_OUT" : "OK") : `HTTP_${page.statusCode}`,
        soldOut,
        finalUrl: page.finalUrl,
        gradeCount: statuses.length,
        statuses
      });

      console.log(
        `${product.name}: ${soldOut ? "SOLD_OUT" : `${statuses.length}종 ${statuses.join(", ") || "-"}`}`
      );

      await sleep(2800);
    } catch (error) {
      items.push({
        ...product,
        checkedAt: nowKST(),
        status: "FETCH_ERROR",
        soldOut: false,
        error: String(error?.message || error),
        gradeCount: 0,
        statuses: []
      });

      console.log(`${product.name}: FETCH_ERROR`);
    }
  }

  const result = {
    version: "auto-flat-v6",
    updatedAt: nowKST(),
    items
  };

  const telegramText = makeTelegramMessage(oldResult.items, items);

  if (telegramText) {
    await sendTelegram(telegramText);
  } else if (process.env.GITHUB_EVENT_NAME === "workflow_dispatch") {
    await sendTelegram(makeManualTestMessage(items));
  } else {
    console.log("No Telegram message: no changes");
  }

  await fs.writeFile(RESULT_PATH, JSON.stringify(result, null, 2), "utf8");

  console.log(`Saved ${RESULT_PATH}`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
