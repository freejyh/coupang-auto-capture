import fs from "fs";
import { chromium, devices } from "playwright";

const PRODUCTS_FILE = "./products.json";
const RESULT_FILE = "./result.json";

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT = process.env.TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHAT;

const STATUS_ORDER = ["반품-최상", "반품-상", "반품-중상", "반품-중", "반품-중하", "반품-하"];

// 헬퍼: 파일 읽기 안전하게 처리
function loadJSON(filePath, defaultVal = {}) {
  if (fs.existsSync(filePath)) {
    try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return defaultVal; }
  }
  return defaultVal;
}

const products = loadJSON(PRODUCTS_FILE, []);
let old = loadJSON(RESULT_FILE, { items: [] });

const sleep = ms => new Promise(r => setTimeout(r, ms));

function nowKST() {
  return new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul", hour12: false });
}

function normalize(v) {
  return String(v || "")
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&quot;/gi, '"')
    .replace(/'/gi, "'").replace(/&#x27;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ").trim();
}

function makeUsedUrl(raw) {
  try {
    const u = new URL(raw);
    u.searchParams.set("landingType", "USED_DETAIL");
    return u.toString();
  } catch {
    return raw;
  }
}

function isSoldOut(text) {
  const t = normalize(text);
  return (
    t.includes("상품이 품절되었습니다") || t.includes("일시품절") ||
    t.includes("일시 품절") || t.includes("재입고 알림") ||
    t.includes("구매할 수 없는 상품") || t.includes("판매 종료")
  );
}

function parseGrades(textLike) {
  const text = normalize(textLike);
  const found = new Set();

  // 정규식 개선: 공백이나 특수문자 대응 유연화
  const re = /반품\s*[\-–—·ㆍ•∙\s]*\s*(최상|중상|중하|상|중|하)(?!\s*품|고|확인)/g;
  let m;

  while ((m = re.exec(text)) !== null) {
    const g = m[1];
    found.add(`반품-${g}`);
  }

  return STATUS_ORDER.filter(x => found.has(x));
}

async function readPage(context, url) {
  const page = await context.newPage();

  try {
    // 웹 브라우저처럼 보이기 위한 추가 스크립트 (네비게이션 전 주입)
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    await page.goto(url, {
      waitUntil: "networkidle", // domcontentloaded 보다 더 안정적인 대기
      timeout: 50000
    });

    // 쿠팡 지연 로딩 대응 대기 시간 확대
    await page.waitForTimeout(5000);

    // 부드러운 스크롤로 데이터 로드 유도
    for (let i = 0; i < 4; i++) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight));
      await page.waitForTimeout(800);
    }

    const visibleText = await page.locator("body").innerText({ timeout: 10000 }).catch(() => "");
    const html = await page.content().catch(() => "");

    // 쿠팡 차단 페이지에 걸렸는지 확인
    if (visibleText.includes("Access Denied") || html.includes("captcha")) {
      console.warn("⚠️ 쿠팡으로부터 봇 차단(Access Denied)을 당했을 가능성이 있습니다.");
    }

    return {
      finalUrl: page.url(),
      visibleText,
      html,
      text: `${visibleText} ${html}`
    };
  } finally {
    await page.close().catch(() => {});
  }
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

async function checkProduct(context, p) {
  const usedUrl = makeUsedUrl(p.url);
  const page = await readPage(context, usedUrl);

  const soldOut = isSoldOut(page.visibleText);
  const statuses = soldOut ? [] : parseGrades(page.text);

  return {
    ...p,
    url: statuses.length ? page.finalUrl || usedUrl : p.url,
    usedUrl,
    checkedAt: nowKST(),
    status: statuses.length ? "OK" : soldOut ? "SOLD_OUT" : "NO_USED_FOUND",
    soldOut,
    gradeCount: statuses.length,
    statuses,
    count: statuses.length,
    links: statuses.length ? [page.finalUrl || usedUrl] : [],
    candidateCount: 1
  };
}

async function sendTelegram(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT || !text) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT,
        text,
        disable_web_page_preview: true
      })
    });
  } catch (e) {
    console.error("Telegram 전송 실패:", e);
  }
}

// 최상위 await 에러를 방지하기 위해 main 함수로 감싸 실행
async function main() {
  if (!products.length) {
    console.log("조회할 상품 리스트(products.json)가 비어있습니다.");
    return;
  }

  const before = oldMap();
  const items = [];
  const messages = [];

  // Headless 모드 시 차단율을 낮추기 위해 필요시 false로 디버깅 추천
  const browser = await chromium.launch({ 
    headless: true 
  });

  const context = await browser.newContext({
    ...devices["iPhone 13"],
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
    bypassCSP: true,
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: {
      "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
      "Cache-Control": "no-cache",
      "Pragma": "no-cache",
      "Referer": "https://www.coupang.com/",
      "Upgrade-Insecure-Requests": "1"
    }
  });

  try {
    for (const p of products) {
      try {
        const item = await checkProduct(context, p);
        items.push(item);

        console.log(
          `${item.name}: ${item.gradeCount}종 ${item.statuses.join(", ") || "-"} / ${item.status}`
        );

        const prev = before.get(item.key);
        const prevCount = Number(prev?.gradeCount || prev?.count || 0);

        if (prevCount === 0 && item.gradeCount > 0) {
          messages.push(
`🔥 쿠팡 반품 확보

${item.name}
${item.row || ""} ${item.col || ""}

확보 ${item.gradeCount}종
${item.statuses.join(" / ")}

${item.links[0]}`
          );
        }

        // 아이템 간 탐색 딜레이를 약간 늘려 차단 확률 감소 (1.5초~2.5초 추천)
        await sleep(2000);
      } catch (e) {
        items.push({
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
        });

        console.log(`${p.name}: ERROR ${String(e?.message || e)}`);
      }
    }
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  const result = {
    version: "final-force-used-detail-v3",
    updatedAt: nowKST(),
    items
  };

  fs.writeFileSync(RESULT_FILE, JSON.stringify(result, null, 2));

  if (messages.length) {
    await sendTelegram(messages.join("\n\n"));
    console.log("Telegram sent");
  }

  console.log("Saved result.json");
}

main().catch(console.error);
