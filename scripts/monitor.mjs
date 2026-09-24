import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const CONFIG_FILE = "config.json";
const HISTORY_FILE = "docs/history.json";
const STATE_FILE = "data/state.json";
const DEBUG_DIR = "debug";

const checkedAt = new Date().toISOString();
const tripUrl = process.env.TRIP_URL ?? "";
const discordWebhookUrl =
  process.env.DISCORD_WEBHOOK_URL ?? "";

fs.mkdirSync(DEBUG_DIR, {
  recursive: true
});

fs.writeFileSync(
  path.join(DEBUG_DIR, "script-started.txt"),
  `Started at ${checkedAt}\n`,
  "utf8"
);

function readJson(fileName, fallbackValue) {
  try {
    return JSON.parse(
      fs.readFileSync(fileName, "utf8")
    );
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

  if (tripUrl) {
    message = message.replaceAll(
      tripUrl,
      "[TRIP_URL]"
    );
  }

  if (discordWebhookUrl) {
    message = message.replaceAll(
      discordWebhookUrl,
      "[DISCORD_WEBHOOK_URL]"
    );
  }

  return message.slice(0, 500);
}

function safePageAddress(rawUrl) {
  try {
    const url = new URL(rawUrl);

    return `${url.origin}${url.pathname}`;
  } catch {
    return "";
  }
}

function parseKrw(rawText) {
  const compactText = String(rawText ?? "")
    .replace(/[\s\u00A0]/g, "");

  const matched = compactText.match(
    /(\d{1,3}(?:,\d{3})+|\d+)원/
  );

  if (!matched) {
    return null;
  }

  const priceKrw = Number(
    matched<span class="source-number-link inline-flex items-center justify-center w-6 h-6 bg-bg-200 rounded-full cursor-pointer hover:bg-[#E9E9E9] transition-colors" data-source-index="0" data-source-url="https://playwright.dev/docs/ci" style="margin: 0 2px; vertical-align: middle;"><span class="text-[14px] font-normal text-[#666666] font-pretendard leading-[1.286]">1</span></span>.replaceAll(",", "")
  );

  if (
    !Number.isSafeInteger(priceKrw) ||
    priceKrw <= 0
  ) {
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

function validateConfig(config) {
  const thresholdKrw = Number(config.thresholdKrw);
  const priceIndex = Number(config.priceIndex);
  const minimum = Number(
    config.minimumAcceptedPriceKrw
  );
  const maximum = Number(
    config.maximumAcceptedPriceKrw
  );

  if (
    !Number.isSafeInteger(thresholdKrw) ||
    thresholdKrw <= 0
  ) {
    throw new Error(
      "config.json의 thresholdKrw 값이 올바르지 않습니다."
    );
  }

  if (
    !Number.isInteger(priceIndex) ||
    priceIndex < 0
  ) {
    throw new Error(
      "config.json의 priceIndex는 0 이상의 정수여야 합니다."
    );
  }

  if (
    !Number.isSafeInteger(minimum) ||
    !Number.isSafeInteger(maximum) ||
    minimum <= 0 ||
    maximum < minimum
  ) {
    throw new Error(
      "config.json의 가격 허용 범위가 올바르지 않습니다."
    );
  }
}

function isAcceptedPrice(config, priceKrw) {
  return (
    priceKrw >= Number(config.minimumAcceptedPriceKrw) &&
    priceKrw <= Number(config.maximumAcceptedPriceKrw)
  );
}

function isLikelyLoginPage(pageUrl, bodyText, candidateCount) {
  let pathname = "";

  try {
    pathname = new URL(pageUrl).pathname;
  } catch {
    pathname = "";
  }

  const loginPath = /login|signin|account|member/i.test(
    pathname
  );

  const loginText =
    /로그인\s*\/\s*회원가입/.test(bodyText) &&
    candidateCount === 0;

  return loginPath || loginText;
}

async function getVisiblePriceCandidates(page, selector) {
  const rawCandidates = await page
    .locator(selector)
    .evaluateAll((elements) => {
      function cleanText(value) {
        return String(value ?? "")
          .replace(/\s+/g, " ")
          .trim();
      }

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
            parentText: cleanText(
              parent?.innerText || parent?.textContent
            ).slice(0, 250)
          };
        })
        .filter(Boolean);
    });

  const seen = new Set();
  const candidates = [];

  for (const candidate of rawCandidates) {
    const priceKrw = parseKrw(candidate.rawText);

    if (priceKrw === null) {
      continue;
    }

    const uniqueKey = [
      candidate.rawText,
      candidate.parentText
    ].join("|");

    if (seen.has(uniqueKey)) {
      continue;
    }

    seen.add(uniqueKey);

    candidates.push({
      ...candidate,
      priceKrw
    });
  }

  return candidates;
}

async function collectTripPrice(config) {
  const diagnostic = {
    checkedAt,
    browser: "Google Chrome Stable",
    selector: config.priceSelector,
    selectedIndex: Number(config.priceIndex),
    acceptedRange: {
      minimum: Number(config.minimumAcceptedPriceKrw),
      maximum: Number(config.maximumAcceptedPriceKrw)
    }
  };

  let browser;
  let page;

  const fail = (message) => {
    diagnostic.result = {
      ok: false,
      message
    };

    return diagnostic.result;
  };

  try {
    if (!tripUrl) {
      return fail(
        "TRIP_URL Secret이 없거나 비어 있습니다."
      );
    }

    const chromeBin = process.env.CHROME_BIN ?? "";

    if (!chromeBin || !fs.existsSync(chromeBin)) {
      return fail(
        "Google Chrome 실행 파일을 찾지 못했습니다."
      );
    }

    /*
      Playwright 기본 Chromium이 아닙니다.
      GitHub Actions에서 설치한 Google Chrome을 직접 실행합니다.
    */
    browser = await chromium.launch({
      executablePath: chromeBin,
      headless: false,
      args: [
        "--lang=ko-KR",
        "--window-size=1440,1800",
        "--disable-dev-shm-usage",
        "--disable-gpu"
      ]
    });

    diagnostic.chromeVersion = browser.version();

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
      GitHub Secret의 기존 긴 Trip.com URL을
      수정하지 않고 그대로 엽니다.
    */
    const response = await page.goto(tripUrl, {
      waitUntil: "domcontentloaded",
      timeout: 90_000
    });

    diagnostic.responseStatus =
      response?.status() ?? null;

    await page.locator("body").waitFor({
      state: "visible",
      timeout: 30_000
    });

    const configuredWaitMs = Number(config.waitMs);
    const waitMs = Number.isFinite(configuredWaitMs)
      ? Math.min(Math.max(configuredWaitMs, 1000), 60000)
      : 15000;

    await page.waitForTimeout(waitMs);

    const bodyText = await page
      .locator("body")
      .innerText()
      .catch(() => "");

    const candidates = await getVisiblePriceCandidates(
      page,
      config.priceSelector
    );

    const selectedIndex = Number(config.priceIndex);
    const selected = candidates[selectedIndex] ?? null;

    diagnostic.finalPageAddress = safePageAddress(
      page.url()
    );

    diagnostic.pageTitle = await page
      .title()
      .catch(() => "");

    diagnostic.bodyTextLength = bodyText.length;

    diagnostic.pageMarkers = [
      "객실을 선택해 주세요",
      "로그인 / 회원가입",
      "객실 없음",
      "예약"
    ].filter((marker) => bodyText.includes(marker));

    diagnostic.visiblePriceCandidates = candidates
      .slice(0, 30)
      .map((candidate) => ({
        sourceIndex: candidate.sourceIndex,
        rawText: candidate.rawText,
        priceKrw: candidate.priceKrw,
        className: candidate.className,
        parentText: candidate.parentText
      }));

    diagnostic.selectedCandidate = selected
      ? {
          sourceIndex: selected.sourceIndex,
          rawText: selected.rawText,
          priceKrw: selected.priceKrw,
          parentText: selected.parentText
        }
      : null;

    if (
      isLikelyLoginPage(
        page.url(),
        bodyText,
        candidates.length
      )
    ) {
      return fail(
        "Trip.com이 호텔 페이지 대신 로그인 페이지를 반환했습니다. 가격을 저장하지 않았습니다."
      );
    }

    if (!selected) {
      return fail(
        "설정한 가격 요소를 찾지 못했습니다. Artifact의 diagnostic.json과 trip-page.png를 확인하세요."
      );
    }

    if (!isAcceptedPrice(config, selected.priceKrw)) {
      return fail(
        `선택된 가격 ${formatKrw(selected.priceKrw)}이(가) 설정한 허용 범위 밖입니다. 가격을 저장하지 않았습니다.`
      );
    }

    diagnostic.result = {
      ok: true,
      priceKrw: selected.priceKrw
    };

    return {
      ok: true,
      priceKrw: selected.priceKrw,
      rawPriceText: selected.rawText,
      candidateCount: candidates.length,
      sourceIndex: selected.sourceIndex
    };
  } catch (error) {
    diagnostic.exception = safeError(error);

    return fail(
      `Chrome 가격 수집 중 오류: ${safeError(error)}`
    );
  } finally {
    if (page) {
      diagnostic.finalPageAddress =
        diagnostic.finalPageAddress ||
        safePageAddress(page.url());

      await page.screenshot({
        path: path.join(DEBUG_DIR, "trip-page.png"),
        fullPage: true
      }).catch(() => {});
    }

    diagnostic.finishedAt = new Date().toISOString();

    writeJson(
      path.join(DEBUG_DIR, "diagnostic.json"),
      diagnostic
    );

    await browser?.close().catch(() => {});
  }
}

async function collectExchangeRates(config) {
  const response = await fetch(config.fxUrl, {
    signal: AbortSignal.timeout(20_000)
  });

  if (!response.ok) {
    throw new Error(
      `환율 API 오류: HTTP ${response.status}`
    );
  }

  const body = await response.json();

  const usdKrwPer1 = Number(body.rates?.KRW);
  const usdJpyPer1 = Number(body.rates?.JPY);

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
    fxAsOf: body.date ?? null,
    fxSource: config.fxSource
  };
}

async function sendDiscord(config, record) {
  if (!discordWebhookUrl) {
    throw new Error(
      "DISCORD_WEBHOOK_URL Secret이 없습니다."
    );
  }

  const content = [
    "🚨 Trip.com 가격 알림",
    config.label,
    `표시 가격: ${formatKrw(record.priceKrw)}`,
    `알림 기준: ${formatKrw(config.thresholdKrw)} 이하`,
    `수집 시각: ${formatKst(record.checkedAt)} (KST)`
  ].join("\n");

  const response = await fetch(discordWebhookUrl, {
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
  });

  if (!response.ok) {
    throw new Error(
      `Discord Webhook 오류: HTTP ${response.status}`
    );
  }
}

function appendHistory(record) {
  const existing = readJson(HISTORY_FILE, []);

  const history = Array.isArray(existing)
    ? existing
    : [];

  history.push(record);

  writeJson(HISTORY_FILE, history);
}

async function main() {
  let config;

  try {
    config = JSON.parse(
      fs.readFileSync(CONFIG_FILE, "utf8")
    );

    validateConfig(config);
  } catch (error) {
    const record = {
      status: "error",
      checkedAt,
      label: "Trip.com 가격 감시",
      message: `설정 파일 오류: ${safeError(error)}`
    };

    appendHistory(record);

    writeJson(
      path.join(DEBUG_DIR, "fatal-config-error.json"),
      record
    );

    console.log(JSON.stringify(record, null, 2));
    return;
  }

  let fx = {
    usdKrwPer1: null,
    krwPer100Jpy: null,
    fxAsOf: null,
    fxSource: config.fxSource
  };

  try {
    fx = await collectExchangeRates(config);
  } catch (error) {
    fx.fxError = safeError(error);
  }

  const collection = await collectTripPrice(config);

  const storedState = readJson(STATE_FILE, {});
  const previousState =
    storedState &&
    typeof storedState === "object"
      ? storedState
      : {};

  let record;

  if (!collection.ok) {
    record = {
      status: "error",
      checkedAt,
      label: config.label,
      thresholdKrw: Number(config.thresholdKrw),
      message: collection.message,
      ...fx
    };

    writeJson(STATE_FILE, {
      belowThreshold: Boolean(
        previousState.belowThreshold
      ),
      alertPending: Boolean(
        previousState.alertPending
      ),
      lastCheckedAt: checkedAt,
      lastPriceKrw:
        previousState.lastPriceKrw ?? null
    });
  } else {
    record = {
      status: "ok",
      checkedAt,
      label: config.label,
      priceKrw: collection.priceKrw,
      currency: "KRW",
      rawPriceText: collection.rawPriceText,
      candidateCount: collection.candidateCount,
      sourceIndex: collection.sourceIndex,
      thresholdKrw: Number(config.thresholdKrw),
      ...fx
    };

    const isBelowThreshold =
      record.priceKrw <= record.thresholdKrw;

    record.isBelowThreshold = isBelowThreshold;

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
          await sendDiscord(config, record);
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
  }

  appendHistory(record);

  console.log(
    JSON.stringify(
      {
        status: record.status,
        priceKrw: record.priceKrw ?? null,
        alertStatus: record.alertStatus ?? null,
        message: record.message ?? null
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  const fatal = {
    status: "error",
    checkedAt,
    message: `예상하지 못한 오류: ${safeError(error)}`
  };

  writeJson(
    path.join(DEBUG_DIR, "fatal-error.json"),
    fatal
  );

  console.error(fatal.message);
  process.exitCode = 1;
});
