import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const CONFIG_FILE = "config.json";
const HISTORY_FILE = "docs/history.json";
const STATE_FILE = "data/state.json";

const config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
const checkedAt = new Date().toISOString();

function readJson(fileName, fallbackValue) {
  try {
    return JSON.parse(fs.readFileSync(fileName, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return fallbackValue;
    }
    throw error;
  }
}

function writeJson(fileName, value) {
  fs.mkdirSync(path.dirname(fileName), { recursive: true });

  fs.writeFileSync(
    fileName,
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8"
  );
}

function safeError(error) {
  let message = error instanceof Error
    ? error.message
    : String(error);

  for (const secret of [
    process.env.TRIP_URL,
    process.env.DISCORD_WEBHOOK_URL
  ]) {
    if (secret) {
      message = message.split(secret).join("[비공개 값]");
    }
  }

  return message.slice(0, 300);
}

function parseKrw(rawText) {
  const compactText = String(rawText)
    .replace(/[\s\u00A0]/g, "");

  const matched = compactText.match(
    /(\d{1,3}(?:,\d{3})+|\d+)원/
  );

  if (!matched) {
    return null;
  }

  const priceKrw = Number(
    matched[1].replaceAll(",", "")
  );

  if (!Number.isSafeInteger(priceKrw) || priceKrw <= 0) {
    return null;
  }

  return priceKrw;
}

function formatKrw(value) {
  return `${new Intl.NumberFormat("ko-KR").format(value)}원`;
}

function formatKst(isoDate) {
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Seoul"
  }).format(new Date(isoDate));
}

async function findPrice(page) {
  const priceIndex = Number(config.priceIndex);

  if (!Number.isInteger(priceIndex) || priceIndex < 0) {
    throw new Error("config.json의 priceIndex 값이 올바르지 않습니다.");
  }

  const selector = `${config.priceSelector}:visible`;

  for (let attempt = 0; attempt < 45; attempt += 1) {
    const rawTexts = await page
      .locator(selector)
      .allInnerTexts();

    const candidates = rawTexts
      .map((rawText) => {
        const text = rawText.trim();

        return {
          rawText: text,
          priceKrw: parseKrw(text)
        };
      })
      .filter((item) => item.priceKrw !== null);

    if (candidates.length > priceIndex) {
      console.log(
        "보이는 가격 후보:",
        JSON.stringify(candidates.slice(0, 10))
      );

      return {
        selected: candidates[priceIndex],
        candidateCount: candidates.length
      };
    }

    await page.waitForTimeout(1000);
  }

const pageTitle = await page.title().catch(() => "");

const bodyText = await page
  .locator("body")
  .innerText()
  .catch(() => "");

const lowerBodyText = bodyText.toLowerCase();

const blockWords = [
  "captcha",
  "verify",
  "robot",
  "access denied",
  "forbidden",
  "보안",
  "인증",
  "접근 제한",
  "비정상적인 접근"
].filter((word) => lowerBodyText.includes(word.toLowerCase()));

console.log(
  "페이지 진단:",
  JSON.stringify({
    pageTitle,
    bodyLength: bodyText.length,
    hasKrwPrice: /(\d{1,3}(?:,\d{3})+|\d+)\s*원/.test(bodyText),
    blockWords
  })
);

throw new Error(
  `가격 후보를 찾지 못했습니다. selector=${config.priceSelector}`
);
}

async function collectPrice() {
  if (!process.env.TRIP_URL) {
    throw new Error("TRIP_URL Secret이 없습니다.");
  }

  let browser;

  try {
    browser = await chromium.launch({
      headless: true
    });

    const context = await browser.newContext({
      locale: "ko-KR",
      timezoneId: "Asia/Seoul",
      viewport: {
        width: 1440,
        height: 1200
      }
    });

    const page = await context.newPage();

    await page.goto(process.env.TRIP_URL, {
      waitUntil: "domcontentloaded",
      timeout: 90_000
    });

    const result = await findPrice(page);

    return {
      priceKrw: result.selected.priceKrw,
      rawPriceText: result.selected.rawText,
      candidateCount: result.candidateCount
    };
  } finally {
    await browser?.close();
  }
}

async function collectExchangeRates() {
  const response = await fetch(config.fxUrl, {
    signal: AbortSignal.timeout(20_000)
  });

  if (!response.ok) {
    throw new Error(`환율 API 오류: HTTP ${response.status}`);
  }

  const data = await response.json();

  const usdKrwPer1 = Number(data.rates?.KRW);
  const usdJpyPer1 = Number(data.rates?.JPY);

  if (!(usdKrwPer1 > 0 && usdJpyPer1 > 0)) {
    throw new Error("환율 응답에 KRW 또는 JPY 값이 없습니다.");
  }

  return {
    usdKrwPer1,
    krwPer100Jpy: Number(
      ((usdKrwPer1 / usdJpyPer1) * 100).toFixed(4)
    ),
    fxAsOf: data.date ?? null,
    fxSource: config.fxSource
  };
}

async function sendDiscord(record) {
  if (!process.env.DISCORD_WEBHOOK_URL) {
    throw new Error("DISCORD_WEBHOOK_URL Secret이 없습니다.");
  }

  const content = [
    "🚨 Trip.com 가격 알림",
    config.label,
    `표시 가격: ${formatKrw(record.priceKrw)}`,
    `알림 기준: ${formatKrw(config.thresholdKrw)} 이하`,
    `수집 시각: ${formatKst(record.checkedAt)} (KST)`
  ].join("\n");

  const response = await fetch(
    process.env.DISCORD_WEBHOOK_URL,
    {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        content,
        allowed_mentions: {
          parse: []
        }
      }),
      signal: AbortSignal.timeout(20_000)
    }
  );

  if (!response.ok) {
    throw new Error(
      `Discord Webhook 오류: HTTP ${response.status}`
    );
  }
}

let record;

try {
  const trip = await collectPrice();

  let fx = {
    usdKrwPer1: null,
    krwPer100Jpy: null,
    fxAsOf: null,
    fxSource: config.fxSource
  };

  try {
    fx = await collectExchangeRates();
  } catch (error) {
    fx.fxError = safeError(error);
  }

  record = {
    status: "ok",
    checkedAt,
    label: config.label,
    priceKrw: trip.priceKrw,
    currency: "KRW",
    rawPriceText: trip.rawPriceText,
    candidateCount: trip.candidateCount,
    thresholdKrw: config.thresholdKrw,
    ...fx
  };

  const previousState = readJson(STATE_FILE, {
    belowThreshold: false,
    alertPending: false
  });

  const isBelowThreshold =
    record.priceKrw <= config.thresholdKrw;

  record.isBelowThreshold = isBelowThreshold;

  const shouldNotify =
    isBelowThreshold &&
    (
      !previousState.belowThreshold ||
      previousState.alertPending
    );

  let alertPending = false;

  if (shouldNotify) {
    try {
      await sendDiscord(record);
      record.alertStatus = "sent";
    } catch (error) {
      record.alertStatus = "failed";
      record.alertError = safeError(error);
      alertPending = true;
    }
  } else {
    record.alertStatus = isBelowThreshold
      ? "already-alerted"
      : "not-needed";
  }

  writeJson(STATE_FILE, {
    belowThreshold: isBelowThreshold,
    alertPending,
    lastCheckedAt: checkedAt,
    lastPriceKrw: record.priceKrw
  });
} catch (error) {
  record = {
    status: "error",
    checkedAt,
    label: config.label,
    thresholdKrw: config.thresholdKrw,
    message: safeError(error)
  };
}

const history = readJson(HISTORY_FILE, []);

if (!Array.isArray(history)) {
  throw new Error("docs/history.json은 JSON 배열([])이어야 합니다.");
}

history.push(record);
writeJson(HISTORY_FILE, history);

console.log(JSON.stringify(record, null, 2));

if (
  record.status === "error" ||
  record.alertStatus === "failed"
) {
  process.exitCode = 1;
}
