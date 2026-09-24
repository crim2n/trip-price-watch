import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const tripUrl = process.env.TRIP_URL;
const expectedText = String(
  process.env.EXPECTED_TEXT ?? ""
).trim();

if (!tripUrl) {
  throw new Error("TRIP_URL Secret이 없습니다.");
}

function normalizeText(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractKrwPrices(text) {
  const normalized = normalizeText(text);

  const pattern =
    /(?:₩\s*|KRW\s*)?(\d{1,3}(?:,\d{3})+|\d+)\s*원/gi;

  const seen = new Set();
  const prices = [];

  for (const match of normalized.matchAll(pattern)) {
    const rawText = match[0].trim();
    const priceKrw = Number(
      match[1].replaceAll(",", "")
    );

    if (
      !Number.isSafeInteger(priceKrw) ||
      priceKrw <= 0 ||
      seen.has(rawText)
    ) {
      continue;
    }

    seen.add(rawText);

    prices.push({
      rawText,
      priceKrw
    });
  }

  return prices.slice(0, 100);
}

function getSafePageAddress(urlText) {
  try {
    const url = new URL(urlText);

    // 여행 조건 등이 들어간 query string은 저장하지 않습니다.
    return `${url.origin}${url.pathname}`;
  } catch {
    return "";
  }
}

fs.mkdirSync("debug", {
  recursive: true
});

let browser;

try {
  // Playwright 기본 Chromium이 아니라 Google Chrome Stable을 실행합니다.
  browser = await chromium.launch({
    channel: "chrome",
    headless: false,
    args: [
      "--window-size=1440,1800",
      "--lang=ko-KR"
    ]
  });

  const context = await browser.newContext({
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
    viewport: {
      width: 1440,
      height: 1800
    },
    deviceScaleFactor: 1
  });

  const page = await context.newPage();

  const userAgent = await page.evaluate(
    () => navigator.userAgent
  );

  console.log(
    `실행 브라우저: Google Chrome ${await browser.version()}`
  );

  await page.goto(tripUrl, {
    waitUntil: "domcontentloaded",
    timeout: 90_000
  });

  await page.locator("body").waitFor({
    state: "visible",
    timeout: 30_000
  });

  // 동적 객실·가격 영역 로딩 대기
  await page.waitForTimeout(12_000);

  await page.waitForLoadState("networkidle", {
    timeout: 15_000
  }).catch(() => {});

  const pageTitle = await page.title();

  const bodyText = await page
    .locator("body")
    .innerText()
    .catch(() => "");

  const normalizedBodyText = normalizeText(bodyText);

  await page.screenshot({
    path: "debug/chrome-page.png",
    fullPage: true
  });

  const result = {
    checkedAt: new Date().toISOString(),
    browser: "Google Chrome Stable",
    browserVersion: await browser.version(),
    userAgent,
    pageTitle,
    finalPageAddress: getSafePageAddress(page.url()),
    bodyTextLength: bodyText.length,
    expectedText: expectedText || null,
    expectedTextFound: expectedText
      ? normalizedBodyText.includes(
          normalizeText(expectedText)
        )
      : null,
    krwPriceSamples: extractKrwPrices(bodyText)
  };

  fs.writeFileSync(
    "debug/chrome-check.json",
    `${JSON.stringify(result, null, 2)}\n`,
    "utf8"
  );

  console.log(
    "Chrome 확인 결과:",
    JSON.stringify(result, null, 2)
  );
} catch (error) {
  const message = error instanceof Error
    ? error.message
    : String(error);

  fs.writeFileSync(
    "debug/chrome-check-error.json",
    `${JSON.stringify({
      checkedAt: new Date().toISOString(),
      message
    }, null, 2)}\n`,
    "utf8"
  );

  throw error;
} finally {
  await browser?.close();
}
