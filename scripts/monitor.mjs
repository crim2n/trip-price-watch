import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const CONFIG_FILE = "config.json";
const HISTORY_FILE = "docs/history.json";
const STATE_FILE = "data/state.json";

const config = JSON.parse(
  fs.readFileSync(CONFIG_FILE, "utf8")
);

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
  fs.mkdirSync(path.dirname(fileName), {
    recursive: true
  });

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

  const secrets = [
    process.env.TRIP_URL,
    process.env.DISCORD_WEBHOOK_URL
  ];

  for (const secret of secrets) {
    if (secret) {
      message = message.split(secret).join("[비공개 값]");
    }
  }

  return message.slice(0, 500);
}

function parseKrw(text) {
  const compact = String(text ?? "")
    .replace(/[\s\u00A0]/g, "");

  const matched = compact.match(
    /(\d{1,3}(?:,\d{3})+|\d+)원/
  );

  if (!matched) {
    return null;
  }

  const value = Number(
    matched<span class="source-number-link inline-flex items-center justify-center w-6 h-6 bg-bg-200 rounded-full cursor-pointer hover:bg-[#E9E9E9] transition-colors" data-source-index="0" data-source-url="https://apps.apple.com/us/app/google/id284815942" style="margin: 0 2px; vertical-align: middle;"><span class="text-[14px] font-normal text-[#666666] font-pretendard leading-[1.286]">1</span></span>.replaceAll(",", "")
  );

  if (!Number.isSafeInteger(value) || value <= 0) {
    return null;
  }

  return value;
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

function getPublicPageAddress(rawUrl) {
  try {
    const url = new URL(rawUrl);

    // 일정·인원 등이 들어 있는 query string은 Artifact에 저장하지 않음
    return `${url.origin}${url.pathname}`;
  } catch {
    return "";
  }
}

function isExpectedPrice(priceKrw) {
  const minimum = Number(
    config.minimumExpectedPriceKrw
  );

  const maximum = Number(
    config.maximumExpectedPriceKrw
  );

  const reference = Number(
    config.referencePriceKrw
  );

  const maximumDeviationRatio = Number(
    config.maximumReferenceDeviationRatio
  );

  if (
    !Number.isSafeInteger(priceKrw) ||
    priceKrw < minimum ||
    priceKrw > maximum
  ) {
    return false;
  }

  if (
    Number.isSafeInteger(reference) &&
    reference > 0 &&
    Number.isFinite(maximumDeviationRatio)
  ) {
    const deviationRatio =
      Math.abs(priceKrw - reference) / reference;

    if (deviationRatio > maximumDeviationRatio) {
      return false;
    }
  }

  return true;
}

async function getVisiblePriceCandidates(page) {
  const selector = String(config.priceSelector);

  const rawCandidates = await page
    .locator(selector)
    .evaluateAll((elements) => {
      function isVisible(element) {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();

        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          style.opacity !== "0" &&
          rect.width > 0 &&
          rect.height > 0
        );
      }

      function cleanText(value) {
        return String(value ?? "")
          .replace(/\s+/g, " ")
          .trim();
      }

      return elements
        .map((element, sourceIndex) => {
          if (!isVisible(element)) {
            return null;
          }

          const parent = element.parentElement;

          return {
            sourceIndex,
            rawText: cleanText(
              element.innerText || element.textContent
            ),
            tagName: element.tagName.toLowerCase(),
            className: String(
              element.getAttribute("class") ?? ""
            ).slice(0, 300),
            ariaHidden: element.getAttribute("aria-hidden"),
            parentText: cleanText(
              parent?.innerText || parent?.textContent
            ).slice(0, 250)
          };
        })
        .filter(Boolean);
    });

  return rawCandidates
    .map((candidate) => ({
      ...candidate,
      priceKrw: parseKrw(candidate.rawText)
    }))
    .filter((candidate) => candidate.priceKrw !== null);
}

async function saveDebugFiles(page, diagnostic) {
  fs.mkdirSync("debug", {
    recursive: true
  });

  const pageTitle = await page.title().catch(() => "");

  await page.screenshot({
    path: "debug/trip-page.png",
    fullPage: true
  }).catch(() => {});

  writeJson("debug/chrome-diagnostics.json", {
    checkedAt,
    browser: "Google Chrome Stable",
    pageTitle,
    finalPageAddress: getPublicPageAddress(page.url()),
    ...diagnostic
  });
}

async function collectTripPrice() {
  if (!process.env.TRIP_URL) {
    throw new Error("TRIP_URL Secret이 없습니다.");
  }

  let browser;
  let page;
  let latestDiagnostic = {};

  try {
    /*
      중요:
      기본 Playwright Chromium이 아니라
      Workflow에서 설치한 Google Chrome을 실행합니다.
    */
    browser = await chromium.launch({
      channel: "chrome",

      /*
        GitHub Actions의 Xvfb 가상 화면에서
        실제 Chrome 창 방식으로 실행합니다.
      */
      headless: false,

      args: [
        "--lang=ko-KR",
        "--window-size=1440,1800",
        "--disable-dev-shm-usage"
      ]
    });

    const context = await browser.newContext({
      locale: "ko-KR",
      timezoneId: "Asia/Seoul",
      viewport: {
        width: 1440,
        height: 1800
      }
    });

    page = await context.newPage();

    /*
      이 줄은 GitHub Secret에 저장된
      사용자의 원래 Trip.com 전체 URL을 그대로 엽니다.
    */
    await page.goto(process.env.TRIP_URL, {
      waitUntil: "domcontentloaded",
      timeout: 90_000
    });

    await page.locator("body").waitFor({
      state: "visible",
      timeout: 30_000
    });

    /*
      Trip.com 객실/가격 영역의 동적 로딩 대기
    */
    await page.waitForTimeout(10_000);

    await page.waitForLoadState("networkidle", {
      timeout: 15_000
    }).catch(() => {});

    const configuredIndex = Number(config.priceIndex);

    if (
      !Number.isInteger(configuredIndex) ||
      configuredIndex < 0
    ) {
      throw new Error(
        "config.json의 priceIndex는 0 이상의 정수여야 합니다."
      );
    }

    for (let attempt = 1; attempt <= 30; attempt += 1) {
      const candidates = await getVisiblePriceCandidates(page);

      const selected = candidates[configuredIndex];

      latestDiagnostic = {
        status: "checking",
        attempt,
        selector: config.priceSelector,
        selectedIndex: configuredIndex,
        visiblePriceCandidates: candidates,
        selectedCandidate: selected ?? null
      };

      if (selected && isExpectedPrice(selected.priceKrw)) {
        latestDiagnostic.status = "ok";

        await saveDebugFiles(page, latestDiagnostic);

        console.log(
          "선택된 가격:",
          JSON.stringify(selected, null, 2)
        );

        return {
          priceKrw: selected.priceKrw,
          rawPriceText: selected.rawText,
          candidateCount: candidates.length,
          sourceIndex: selected.sourceIndex,
          selector: config.priceSelector
        };
      }

      await page.waitForTimeout(1_000);
    }

    latestDiagnostic.status = "error";
    latestDiagnostic.reason =
      "목표 가격 선택자를 찾지 못했거나, 선택된 값이 예상 가격 범위를 벗어났습니다.";

    await saveDebugFiles(page, latestDiagnostic);

    throw new Error(
      "검증된 숙소 가격을 찾지 못했습니다. " +
      "Artifacts의 trip-page.png 및 chrome-diagnostics.json을 확인하세요."
    );
  } catch (error) {
    if (page) {
      latestDiagnostic.status = "error";
      latestDiagnostic.error = safeError(error);

      await saveDebugFiles(
        page,
        latestDiagnostic
      ).catch(() => {});
    }

    throw error;
  } finally {
    await browser?.close();
  }
}

async function collectExchangeRates() {
  const response = await fetch(config.fxUrl, {
    signal: AbortSignal.timeout(20_000)
  });

  if (!response.ok) {
    throw new Error(
      `환율 API 오류: HTTP ${response.status}`
    );
  }

  const result = await response.json();

  const usdKrwPer1 = Number(result.rates?.KRW);
  const usdJpyPer1 = Number(result.rates?.JPY);

  if (!(usdKrwPer1 > 0 && usdJpyPer1 > 0)) {
    throw new Error(
      "환율 응답에 KRW 또는 JPY 값이 없습니다."
    );
  }

  return {
    usdKrwPer1,
    krwPer100Jpy: Number(
      ((usdKrwPer1 / usdJpyPer1) * 100).toFixed(4)
    ),
    fxAsOf: result.date ?? null,
    fxSource: config.fxSource
  };
}

async function sendDiscord(record) {
  if (!process.env.DISCORD_WEBHOOK_URL) {
    throw new Error(
      "DISCORD_WEBHOOK_URL Secret이 없습니다."
    );
  }

  const message = [
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
        content: message,
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

const previousState = readJson(STATE_FILE, {
  belowThreshold: false,
  alertPending: false
});

let record;

try {
  const trip = await collectTripPrice();

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
    sourceIndex: trip.sourceIndex,
    selector: trip.selector,
    thresholdKrw: config.thresholdKrw,
    ...fx
  };

  const isBelowThreshold =
    record.priceKrw <= config.thresholdKrw;

  record.isBelowThreshold = isBelowThreshold;

  /*
    테스트 중에는 alertsEnabled=false 상태이므로
    Discord 메시지를 보내지 않습니다.
  */
  if (config.alertsEnabled !== true) {
    record.alertStatus = "disabled";

    writeJson(STATE_FILE, {
      belowThreshold: false,
      alertPending: false,
      lastCheckedAt: checkedAt,
      lastPriceKrw: record.priceKrw
    });
  } else {
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
  }
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
  throw new Error(
    "docs/history.json은 JSON 배열([])이어야 합니다."
  );
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
