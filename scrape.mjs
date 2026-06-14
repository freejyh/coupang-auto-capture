import fs from "fs";

const PRODUCTS_FILE = "./products.json";
const RESULT_FILE = "./result.json";

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT = process.env.TELEGRAM_CHAT;

const products = JSON.parse(
  fs.readFileSync(PRODUCTS_FILE, "utf8")
);

let old = {};
if (fs.existsSync(RESULT_FILE)) {
  old = JSON.parse(fs.readFileSync(RESULT_FILE, "utf8"));
}

const result = {
  updatedAt: new Date().toLocaleString("ko-KR", {
    timeZone: "Asia/Seoul"
  }),
  items: {}
};

let messages = [];


async function checkProduct(p) {
  try {
    const res = await fetch(p.url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 AppleWebKit/537.36 Chrome Safari"
      }
    });

    const html = await res.text();


    // 쿠팡 품절 문구 필터
    const soldout =
      html.includes("품절") ||
      html.includes("일시품절") ||
      html.includes("상품이 품절되었습니다") ||
      html.includes("재입고 알림");


    if (soldout) {
      return {
        count: 0,
        links: []
      };
    }


    // 구매 가능 신호
    const available =
      html.includes("장바구니") ||
      html.includes("바로구매") ||
      html.includes("구매하기");


    if (!available) {
      return {
        count: 0,
        links: []
      };
    }


    return {
      count: 1,
      links: [p.url]
    };


  } catch (e) {
    return {
      count: 0,
      links: []
    };
  }
}


for (const p of products) {

  const data = await checkProduct(p);

  result.items[p.id] = {
    name: p.name,
    model: p.model,
    color: p.color,
    storage: p.storage,
    count: data.count,
    links: data.links
  };


  console.log(
    `${p.name} ${p.color} ${p.storage}: ${data.count}종`
  );


  const before =
    old?.items?.[p.id]?.count || 0;


  if (before === 0 && data.count > 0) {
    messages.push(
`🔥 쿠팡 반품 확보

${p.name}
${p.color} ${p.storage}

확보 ${data.count}종

${data.links[0]}`
    );
  }
}


fs.writeFileSync(
  RESULT_FILE,
  JSON.stringify(result, null, 2)
);


if (
  messages.length &&
  TELEGRAM_TOKEN &&
  TELEGRAM_CHAT
) {

  for (const text of messages) {

    await fetch(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
      {
        method:"POST",
        headers:{
          "Content-Type":"application/json"
        },
        body:JSON.stringify({
          chat_id: TELEGRAM_CHAT,
          text
        })
      }
    );
  }

  console.log("Telegram sent");
}


console.log("Saved result.json");
