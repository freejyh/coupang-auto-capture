import fs from "fs";

const PRODUCTS_FILE = "./products.json";
const RESULT_FILE = "./result.json";

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT = process.env.TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHAT;

const products = JSON.parse(fs.readFileSync(PRODUCTS_FILE, "utf8"));

let old = { items: [] };
if (fs.existsSync(RESULT_FILE)) {
  try {
    old = JSON.parse(fs.readFileSync(RESULT_FILE, "utf8"));
  } catch {}
}

function nowKST() {
  return new Date().toLocaleString("ko-KR", {
    timeZone: "Asia/Seoul",
    hour12: false
  });
}

function normalize(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

function parseGrades(html) {
  const text = normalize(html);
  const grades = new Set();

  const re = /반품\s*[-–—·ㆍ•∙]?\s*(최상|중상|중하|상|중|하)(?!\s*품|고)/g;
  let m;

  while ((m = re.exec(text)) !== null) {
    const g = m[1];
    if (g === "최상") grades.add("반품-최상");
    if (g === "상") grades.add("반품-상");
    if (g === "중상") grades.add("반품-중상");
    if (g === "중") grades.add("반품-중");
    if (g === "중하") grades.add("반품-중하");
    if (g === "하") grades.add("반품-하");
  }

  return [
    "반품-최상",
    "반품-상",
    "반품-중상",
    "반품-중",
    "반품-중하",
    "반품-하"
  ].filter(x => grades.has(x));
}

function isSoldOut(html) {
  const text = normalize(html);
  return (
    text.includes("상품이 품절되었습니다") ||
    text.includes("일시품절") ||
    text.includes("일시 품절") ||
    text.includes("재입고 알림")
  );
}

async function checkProduct(p) {
  try {
    const res = await fetch(p.url, {
      headers: {
        "User-Agent": "Mozilla/5.0 AppleWebKit/537.36 Chrome Safari",
        "Accept-Language": "ko-KR,ko;q=0.9"
      }
    });

    const html = await res.text();

    if (isSoldOut(html)) {
      return {
        ...p,
        checkedAt: nowKST(),
        status: "SOLD_OUT",
        soldOut: true,
        gradeCount: 0,
        statuses: [],
        count: 0,
        links: []
      };
    }

    const statuses = parseGrades(html);

    return {
      ...p,
      checkedAt: nowKST(),
      status: statuses.length ? "OK" : "NO_USED_FOUND",
      soldOut: false,
      gradeCount: statuses.length,
      statuses,
      count: statuses.length,
      links: statuses.length ? [p.url] : []
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
      error: String(e?.message || e)
    };
  }
}

function oldMap() {
  const map = new Map();

  if (Array.isArray(old.items)) {
    for (const item of old.items) map.set(item.key, item);
  } else if (old.items && typeof old.items === "object") {
    for (const [key, item] of Object.entries(old.items)) {
      map.set(key, { key, ...item });
    }
  }

  return map;
}

async function sendTelegram(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT || !text) return;

  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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

for (const p of products) {
  const item = await checkProduct(p);
  items.push(item);

  console.log(`${item.name}: ${item.gradeCount}종 ${item.statuses.join(", ") || "-"}`);

  const prev = before.get(item.key);
  const prevCount = Number(prev?.gradeCount || prev?.count || 0);

  if (prevCount === 0 && item.gradeCount > 0) {
    messages.push(
`🔥 쿠팡 반품 확보

${item.name}
${item.row} ${item.col}

확보 ${item.gradeCount}종
${item.statuses.join(" / ")}

${item.url}`
    );
  }
}

const result = {
  version: "final-key-array-v1",
  updatedAt: nowKST(),
  items
};

fs.writeFileSync(RESULT_FILE, JSON.stringify(result, null, 2));

if (messages.length) {
  await sendTelegram(messages.join("\n\n"));
  console.log("Telegram sent");
}

console.log("Saved result.json");
