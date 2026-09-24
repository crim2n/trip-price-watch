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

let lastPriceDiagnostic = {};

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

function parseKrw(rawText) {
  const compactText = String(rawText)
    .replace(/[\s\u00A0]/g, "");

  if (!/(원|₩|KRW)/i.test(compactText)) {
    return null;
  }

  const matched = compactText.match(
    /(?:₩|KRW)?(\d{1,3}(?:,\d{3})+|\d+)(?:원)?/i
  );

  if (!matched) {
    return null;
  }

  const priceKrw = Number(
    matched[1].replaceAll(",", "")
  );

  if (
    !Number.isSafeInteger(priceKrw) ||
    priceKrw <= 0
  ) {
    return null;
  }

  return priceKrw;
}

function isValidHotelPrice(priceKrw) {
  const min = Number(config.minValidPriceKrw);
  const max = Number(config.maxValidPriceKrw);

  return (
    Number.isSafeInteger(priceKrw) &&
    priceKrw >= min &&
    priceKrw <= max
  );
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

function candidateForLog(candidate, index) {
  return {
    index,
    priceKrw: candidate.priceKrw,
    rawText: candidate.rawText,
    tagName: candidate.tagName,
    className: candidate.className,
    ariaHidden: candidate.ariaHidden,
    parentText: candidate.parentText
  };
}

async function scanVisiblePriceCandidates(page) {
  const selector = String(
    config.candidateSelector ||
      "span, strong, b, em, i, div, p"
  );

  const rawCandidates = await page.evaluate(
    (scanSelector) => {
      function normalizeText(value) {
        return String(value)
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

      function looksLikeOneKrwPrice(text) {
        if (!text || text.length > 80) {
          return false;
        }

        if (!/(원|₩|KRW)/i.test(text)) {
          return false;
        }

        const numberParts = text.match(
          /\d{1,3}(?:,\d{3})+|\d+/g
        ) || [];

        return numberParts.length === 1;
      }

      const elements = Array.from(
        document.querySelectorAll(scanSelector)
      );

      const result = [];

      for (const element of elements) {
        if (!isVisible(element)) {
          continue;
        }

        const text = normalizeText(
          element.innerText || element.textContent || ""
        );

        if (!looksLikeOneKrwPrice(text)) {
          continue;
        }

        const sameTextChildExists = Array.from(
          element.querySelectorAll(
            "span, strong, b, em, i, div, p"
          )
        ).some((child) => {
          if (!isVisible(child)) {
            return false;
          }

          const childText = normalizeText(
            child.innerText || child.textContent || ""
          );

          return (
            childText === text &&
            looksLikeOneKrwPrice(childText)
          );
        });

        if (sameTextChildExists) {
          continue;
        }

        const parent = element.parentElement;

        result.push({
          rawText: text,
          tagName: element.tagName.toLowerCase(),
          className: String(element.className || "")
            .slice(0, 200),
          ariaHidden: element.getAttribute("aria-hidden"),
          parentText: normalizeText(
            parent?.innerText || ""
          ).slice(0, 220)
        });
      }

      return result.slice(0, 100);
    },
    selector
  );

  const seen = new Set();

  return rawCandidates
    .map((candidate) => ({
      ...candidate,
      priceKrw: parseKrw(candidate.rawText)
    }))
    .filter((candidate) => candidate.priceKrw !== null)
    .filter((candidate) => {
      const key = [
        candidate.priceKrw,
        candidate.rawText,
        candidate.parentText
      ].join("|");

      if (seen.has(key)) {
        return false;
      }

      seen.add(key);
      return true;
    });
}

async function findPrice(page, referenceKrw) {
  const rawConfiguredIndex =
    config.priceCandidateIndex;

  const hasFixedIndex =
    rawConfiguredIndex !== null &&
    rawConfiguredIndex !== undefined &&
    rawConfiguredIndex !== "";

  const fixedIndex = hasFixedIndex
    ? Number(rawConfiguredIndex)
    : null;

  if (
    hasFixedIndex &&
    (!Number.isInteger(fixedIndex) || fixedIndex < 0)
  ) {
    throw new Error(
      "config.json의 priceCandidateIndex는 null 또는 0 이상의 정수여야 합니다."
    );
  }

  const maxDeviationRatio = Number(
    config.maxReferenceDeviationRatio ?? 0.7
  );

  for (let attempt = 1; attempt <= 35; attempt += 1) {
    const allCandidates =
      await scanVisiblePriceCandidates(page);

    const validCandidates = allCandidates.filter(
      (candidate) =>
        isValidHotelPrice(candidate.priceKrw)
    );

    lastPriceDiagnostic = {
      attempt,
      candidateSelector: config.candidateSelector,
      referencePriceKrw: referenceKrw,
      minValidPriceKrw: config.minValidPriceKrw,
      maxValidPriceKrw: config.maxValidPriceKrw,
      allVisibleKrwCandidates: allCandidates.map(
        candidateForLog
      ),
      validCandidates: validCandidates.map(
        candidateForLog
      )
    };

    writeJson(
      "debug/price-candidates.json",
      lastPriceDiagnostic
    );

    if (validCandidates.length > 0) {
      let selected;
      let selectedCandidateIndex;

      if (hasFixedIndex) {
        if (fixedIndex >= validCandidates.length) {
          throw new Error(
            `priceCandidateIndex=${fixedIndex}에 해당하는 후보가 없습니다. 유효 후보 수: ${validCandidates.length}`
          );
        }

        selected = validCandidates[fixedIndex];
        selectedCandidateIndex = fixedIndex;
      } else {
        const ranked = validCandidates
          .map((candidate, index) => ({
            candidate,
            index,
            difference: Math.abs(
              candidate.priceKrw - referenceKrw
            )
          }))
          .sort((a, b) => a.difference - b.difference);

        selected = ranked[0].candidate;
        selectedCandidateIndex = ranked[0].index;
      }

      const deviationRatio =
        referenceKrw > 0
          ? Math.abs(
              selected.priceKrw - referenceKrw
            ) / referenceKrw
          : 0;

      lastPriceDiagnostic.selectedCandidate =
        candidateForLog(
          selected,
          selectedCandidateIndex
        );

      lastPriceDiagnostic.selectionMethod =
        hasFixedIndex
          ? "priceCandidateIndex"
          : "nearest-to-reference";

      lastPriceDiagnostic.deviationRatio =
        deviationRatio;

      writeJson(
        "debug/price-candidates.json",
        lastPriceDiagnostic
      );

      if (deviationRatio <= maxDeviationRatio) {
        console.log(
          "선택한 가격 후보:",
          JSON.stringify(
            lastPriceDiagnostic.selectedCandidate
          )
        );

        return {
          priceKrw: selected.priceKrw,
          rawPriceText: selected.rawText,
          candidateCount: validCandidates.length,
          selectedCandidateIndex,
          candidateSource: "visible-price-elements"
        };
      }
    }

    if (attempt === 1 || attempt % 5 === 0) {
      console.log(
        "가격 후보 진단:",
        JSON.stringify(lastPriceDiagnostic)
      );
    }

    await page.waitForTimeout(1000);
  }

  throw new Error(
    "유효한 숙소 가격 후보를 선택하지 못했습니다. Actions Artifact의 price-candidates.json과 trip-page.png를 확인하세요."
  );
}

function extractBodyPriceSamples(bodyText) {
  const pattern =
    /(?:₩\s*|KRW\s*)?\d{1,3}(?:,\d{3})+(?:\s*원)?/gi;

  return [...String(bodyText).matchAll(pattern)]
    .map((match) => match[0].trim())
    .filter((text) => /(원|₩|KRW)/i.test(text))
    .slice(0, 20);
}

async function saveDebugArtifacts(page, extra) {
  fs.mkdirSync("debug", {
    recursive: true
  });

  const pageTitle = await page
    .title()
    .catch(() => "");

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
  ].filter((word) =>
    lowerBodyText.includes(word.toLowerCase())
  );

  let pagePath = "";

  try {
    pagePath = new URL(page.url()).pathname;
  } catch {
    pagePath = "";
  }

  writeJson("debug/page-diagnostics.json", {
    checkedAt,
    pageTitle,
    pagePath,
    bodyLength: bodyText.length,
    bodyPriceSamples: extractBodyPriceSamples(bodyText),
    blockWords,
    lastPriceDiagnostic,
    ...extra
  });

  await page.screenshot({
    path: "debug/trip-page.png",
    fullPage: true
  }).catch(() => {});
}

async function collectPrice(referenceKrw) {
  if (!process.env.TRIP_URL) {
    throw new Error("TRIP_URL Secret이 없습니다.");
  }

  let browser;
  let page;

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

    page = await context.newPage();

    await page.goto(process.env.TRIP_URL, {
      waitUntil: "domcontentloaded",
      timeout: 90_000
    });

    await page.waitForTimeout(4000);

    await page.waitForLoadState("networkidle", {
      timeout: 10_000
    }).catch(() => {});

    const result = await findPrice(
      page,
      referenceKrw
    );

    await saveDebugArtifacts(page, {
      status: "ok",
      selectedPriceKrw: result.priceKrw
    });

    return result;
  } catch (error) {
    if (page) {
      await saveDebugArtifacts(page, {
        status: "error",
        message: safeError(error)
      }).catch(() => {});
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

  const data = await response.json();

  const usdKrwPer1 = Number(data.rates?.KRW);
  const usdJpyPer1 = Number(data.rates?.JPY);

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
    fxAsOf: data.date ?? null,
    fxSource: config.fxSource
  };
}

async function sendDiscord(record) {
  if (!process.env.DISCORD_WEBHOOK_URL) {
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

const previousState = readJson(STATE_FILE, {
  belowThreshold: false,
  alertPending: false,
  lastValidPriceKrw: null
});

const previousValidPrice = Number(
  previousState.lastValidPriceKrw
);

const referenceKrw = isValidHotelPrice(
  previousValidPrice
)
  ? previousValidPrice
  : Number(config.referencePriceKrw);

let record;

try {
  const trip = await collectPrice(referenceKrw);

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
    selectedCandidateIndex:
      trip.selectedCandidateIndex,
    candidateSource: trip.candidateSource,
    referenceKrw,
    thresholdKrw: config.thresholdKrw,
    ...fx
  };

  const isBelowThreshold =
    record.priceKrw <= config.thresholdKrw;

  const shouldNotify =
    isBelowThreshold &&
    (
      !previousState.belowThreshold ||
      previousState.alertPending
    );

  let alertPending = false;

  record.isBelowThreshold = isBelowThreshold;

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
    lastValidPriceKrw: record.priceKrw
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
