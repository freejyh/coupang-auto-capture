import fs from "fs";
import { chromium, devices } from "playwright";

const PRODUCTS_FILE = "./products.json";
const RESULT_FILE = "./result.json";

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT = process.env.TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHAT;

const STATUS_ORDER = [
  "반품-최상",
  "반품-상",
  "반품-중상",
  "반품-중",
  "반품-중하",
  "반품-하"
];

const products = JSON.parse(fs.readFileSync(PRODUCTS_FILE, "utf8"));

let old = { items: [] };
if (fs.existsSync(RESULT_FILE)) {
  try {
    old = JSON.parse(fs.readFileSync(RESULT_FILE, "utf8"));
  } catch {}
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function nowKST() {
  return new Date().toLocaleString("ko-KR", {
    timeZone: "Asia/Seoul",
    hour12: false
  });
}

function normalize(value) {
  return String(value || "")
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function parseGrades(textLike) {
  const text = normalize(textLike);
  const found = new Set();

  const re = /반품\s*[-–—·ㆍ•∙]?\s*(최상|중상|중하|상|중|하)(?!\s*품|고)/g;
  let m;

  while ((m = re.exec(text)) !== null) {
    const g = m[1];

    if (g === "최상") found.add("반품-최상");
    else if (g === "중상") found.add("반품-중상");
    else if (g === "중하") found.add("반품-중하");
    else if (g === "상") found.add("반품-상");
    else if (g === "중") found.add("반품-중");
    else if (g === "하") found.add("반품-하");
  }

  return STATUS_ORDER.filter(x => found.has(x));
}

function isSoldOut(textLike) {
  const text = normalize(textLike);

  return (
    text.includes("상품이 품절되었습니다") ||
    text.includes("일시품절") ||
    text.includes("일시 품절") ||
    text.includes("재입고 알림") ||
    text.includes("구매할 수 없는 상품") ||
    text.includes("판매 종료")
  );
}

function oldMap() {
  const map = new Map();

  if (Array.isArray(old.items)) {
    for (const item of old.items) {
      if (item.key) map.set(item.key, item);
    }
  }

  return map;
}

async function readProductPage(context, p) {
  const page = await context.newPage();

  try {
    await page.goto(p.url, {
      waitUntil: "domcontentloaded",
      timeout: 45000
    });

    await page.waitForTimeout(5000);

    for (let i = 0; i < 4; i++) {
      await page.mouse.wheel(0, 900).catch(() => {});
      await page.waitForTimeout(900);
    }

    const visibleText = await page.locator("body").innerText({
      timeout: 10000
    }).catch(() => "");

    const html = await page.content().catch(() => "");

    const links = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("a[href]"))
        .map(a => a.href)
        .filter(Boolean);
    }).catch(() => []);

    return {
      finalUrl: page.url(),
      visibleText,
      html,
      links
    };
  } finally {
    await page.close().catch(() => {});
  }
}

function extractUsedLinks(textLike, links = []) {
  const text = normalize(textLike);
  const found = new Set();

  for (const link of links) {
    if (String(link).includes("landingType=USED_DETAIL")) {
      found.add(String(link));
    }
  }

  const re = /https?:\/\/(?:www\.)?coupang\.com\/vp\/products\/[^"'<> ]*landingType=USED_DETAIL[^"'<> ]*/g;
  let m;

  while ((m = re.exec(text)) !== null) {
    found.add(m[0].replace(/amp;/g, ""));
  }

  const re2 = /\/vp\/products\/[^"'<> ]*landingType=USED_DETAIL[^"'<> ]*/g;

  while ((m = re2.exec(text)) !== null) {
    found.add(`https://www.coupang.com${m[0].replace(/amp;/g, "")}`);
  }

  return [...found];
}

async function checkUsedLink(context, url) {
  const page = await context.newPage();

  try {
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 45000
    });

    await page.waitForTimeout(3500);

    const visibleText = await page.locator("body").innerText({
      timeout: 10000
    }).catch(() => "");

    const html = await page.content().catch(() => "");

    const combined = `${visibleText} ${html}`;

    if (isSoldOut(visibleText)) {
      return {
        ok: false,
        soldOut: true,
        statuses: [],
        url: page.url()
      };
    }

    const statuses = parseGrades(combined);

    return {
      ok: statuses.length > 0,
      soldOut: false,
      statuses,
      url: page.url()
    };
  } finally {
    await page.close().catch(() => {});
  }
}

async function checkProduct(context, p) {
  try {
    const pageData = await readProductPage(context, p);
    const combined = `${pageData.visibleText} ${pageData.html}`;

    let usedLinks = extractUsedLinks(combined, pageData.links);

    if (!usedLinks.length && p.url.includes("landingType=USED_DETAIL")) {
      usedLinks = [p.url];
    }

    const found = new Set();
    let liveUrl = "";

    for (const usedUrl of usedLinks.slice(0, 10)) {
      const checked = await checkUsedLink(context, usedUrl);

      if (checked.ok) {
        liveUrl = liveUrl || checked.url;

        for (const s of checked.statuses) {
          found.add(s);
        }
      }

      await sleep(700);
    }

    if (!found.size) {
      const directSoldOut = isSoldOut(pageData.visibleText);
      const directStatuses = directSoldOut ? [] : parseGrades(combined);

      for (const s of directStatuses) {
        found.add(s);
      }

      const statuses = STATUS_ORDER.filter(x => found.has(x));

      return {
        ...p,
        checkedAt: nowKST(),
        status: statuses.length ? "OK" : directSoldOut ? "SOLD_OUT" : "NO_USED_FOUND",
        soldOut: directSoldOut,
        gradeCount: statuses.length,
        statuses,
        count: statuses.length,
        links: statuses.length ? [pageData.finalUrl || p.url] : [],
        candidateCount: usedLinks.length
      };
    }

    const statuses = STATUS_ORDER.filter(x => found.has(x));

    return {
      ...p,
      url: liveUrl || p.url,
      checkedAt: nowKST(),
      status: "OK",
      soldOut: false,
      gradeCount: statuses.length,
      statuses,
      count: statuses.length,
      links: [liveUrl || p.url],
      candidateCount: usedLinks.length
    };
  } catch (e) {
    return {
      ...p,
      checkedAt: nowKST(),
      status: "ERROR",
      soldOut: false,
      gradeCount: 0,
      statuses: [],
      count: 0,
      links: [],
      candidateCount: 0,
      error: String(e?.message || e)
    };
  }
}

async function sendTelegram(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT || !text) return;

  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT,
      text,
      disable_web_page_preview: true
    })
  });
}

const before = oldMap();
const items = [];
const messages = [];

const browser = await chromium.launch({
  headless: true
});

const context = await browser.newContext({
  ...devices["iPhone 13"],
  locale: "ko-KR",
  timezoneId: "Asia/Seoul",
  extraHTTPHeaders: {
    "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.7,en;q=0.5",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
    "Referer": "https://www.coupang.com/"
  }
});

try {
  for (const p of products) {
    const item = await checkProduct(context, p);
    items.push(item);

    console.log(
      `${item.name}: ${item.gradeCount}종 ${item.statuses.join(", ") || "-"} / candidates ${item.candidateCount || 0} / ${item.status}`
    );

    const prev = before.get(item.key);
    const prevCount = Number(prev?.gradeCount || prev?.count || 0);

    if (prevCount === 0 && item.gradeCount > 0) {
      messages.push(
`🔥 쿠팡 반품 확보

${item.name}
${item.row} ${item.col}

확보 ${item.gradeCount}종
${item.statuses.join(" / ")}

${item.links[0] || item.url}`
      );
    }

    await sleep(1200);
  }
} finally {
  await context.close().catch(() => {});
  await browser.close().catch(() => {});
}

const result = {
  version: "final-playwright-used-v2",
  updatedAt: nowKST(),
  items
};

fs.writeFileSync(RESULT_FILE, JSON.stringify(result, null, 2));

if (messages.length) {
  await sendTelegram(messages.join("\n\n"));
  console.log("Telegram sent");
}

console.log("Saved result.json");
