const fs = require("fs");
const path = require("path");
let sharp = null;
try {
  sharp = require("sharp");
} catch (e) {
  console.warn("sharp module not available, using raw buffer:", e.message);
}
const { createWorker } = require("tesseract.js");

const IS_VERCEL = process.env.VERCEL === '1' || process.env.NOW_REGION !== undefined;

function getCorePath() {
  const candidates = [
    path.resolve(__dirname, "../tesseract-core"),
    path.resolve(process.cwd(), "backend/tesseract-core"),
    "/var/task/backend/tesseract-core",
    path.resolve(__dirname, "../../node_modules/tesseract.js-core"),
    path.resolve(process.cwd(), "node_modules/tesseract.js-core"),
    "/var/task/node_modules/tesseract.js-core",
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "tesseract-core-simd.wasm")) || fs.existsSync(path.join(dir, "tesseract-core.wasm"))) {
      return dir;
    }
  }
  return "https://cdn.jsdelivr.net/npm/tesseract.js-core@v5.1.0";
}

function getLangPath() {
  const candidates = [
    path.resolve(__dirname, ".."),
    process.cwd(),
    path.resolve(process.cwd(), "backend"),
    __dirname,
    "/var/task",
    "/var/task/backend",
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "eng.traineddata")) || fs.existsSync(path.join(dir, "eng.traineddata.gz"))) {
      return dir;
    }
  }
  return "https://cdn.jsdelivr.net/gh/naptha/tessdata@gh-pages/4.0.0";
}

const CORE_PATH = getCorePath();
const LANG_PATH = getLangPath();

/**
 * Scale image for optimal Tesseract recognition speed and accuracy
 */
async function preparePipeline(inputBuffer) {
  if (!sharp) return null;
  try {
    let pipeline = sharp(inputBuffer).rotate();
    const meta = await sharp(inputBuffer).metadata();
    if (meta && meta.width) {
      if (meta.width > 2000) {
        pipeline = pipeline.resize({ width: 1800 });
      } else if (meta.width < 1200) {
        pipeline = pipeline.resize({ width: Math.min(meta.width * 2, 1800) });
      }
    }
    return pipeline;
  } catch (_) {
    return null;
  }
}

/**
 * Standard enhanced grayscale
 */
async function preprocessGrayscale(inputBuffer) {
  const p = await preparePipeline(inputBuffer);
  if (!p) return inputBuffer;
  try {
    return await p
      .grayscale()
      .normalize()
      .sharpen({ sigma: 1.2 })
      .toBuffer();
  } catch (_) {
    return inputBuffer;
  }
}

/**
 * Color-channel separation (Red channel)
 */
async function preprocessRedChannel(inputBuffer) {
  const p = await preparePipeline(inputBuffer);
  if (!p) return null;
  try {
    return await p
      .extractChannel("red")
      .normalize()
      .sharpen({ sigma: 1.5 })
      .toBuffer();
  } catch (_) {
    return null;
  }
}

/**
 * Color-channel separation (Blue channel)
 */
async function preprocessBlueChannel(inputBuffer) {
  const p = await preparePipeline(inputBuffer);
  if (!p) return null;
  try {
    return await p
      .extractChannel("blue")
      .normalize()
      .sharpen({ sigma: 1.5 })
      .toBuffer();
  } catch (_) {
    return null;
  }
}

/**
 * High-contrast threshold fallback
 */
async function preprocessThreshold(inputBuffer) {
  const p = await preparePipeline(inputBuffer);
  if (!p) return null;
  try {
    return await p
      .grayscale()
      .normalize()
      .sharpen()
      .threshold(160)
      .toBuffer();
  } catch (_) {
    return null;
  }
}

/**
 * Check if text contains likely VIT slot or course patterns
 */
function textHasCourseSignals(text) {
  if (!text) return false;
  return /\b([A-Z]{2,4}\d{4}|[A-G]\d|T[A-Z]{1,2}\d|L\d{1,2})\b/i.test(text);
}

/**
 * OCR using Tesseract.js with core and lang assets
 */
async function extractTextFromImage(inputBuffer) {
  const worker = await createWorker("eng", 1, {
    corePath: CORE_PATH,
    langPath: LANG_PATH,
    gzip: false,
    cachePath: IS_VERCEL ? "/tmp" : LANG_PATH,
  });

  const ocrJob = async () => {
    await worker.setParameters({
      tessedit_pageseg_mode: "6", // Assume uniform block of text
      preserve_interword_spaces: "1",
    });

    // Pass 1: Standard enhanced grayscale
    const grayBuffer = (await preprocessGrayscale(inputBuffer)) || inputBuffer;
    let { data: { text, confidence } } = await worker.recognize(grayBuffer);

    // If text already has strong course signals, return immediately
    if (text && textHasCourseSignals(text) && text.trim().length > 30) {
      return { text: text || "", confidence: confidence || 0 };
    }

    // Pass 2: Red channel separation
    try {
      const redBuffer = await preprocessRedChannel(inputBuffer);
      if (redBuffer) {
        const resRed = await worker.recognize(redBuffer);
        if (resRed.data.text && textHasCourseSignals(resRed.data.text)) {
          return { text: resRed.data.text, confidence: resRed.data.confidence };
        }
        if (resRed.data.text && resRed.data.text.trim().length > (text ? text.trim().length : 0)) {
          text = resRed.data.text;
          confidence = resRed.data.confidence;
        }
      }
    } catch (_) {}

    // Pass 3: Blue channel separation
    try {
      const blueBuffer = await preprocessBlueChannel(inputBuffer);
      if (blueBuffer) {
        const resBlue = await worker.recognize(blueBuffer);
        if (resBlue.data.text && textHasCourseSignals(resBlue.data.text)) {
          return { text: resBlue.data.text, confidence: resBlue.data.confidence };
        }
        if (resBlue.data.text && resBlue.data.text.trim().length > (text ? text.trim().length : 0)) {
          text = resBlue.data.text;
          confidence = resBlue.data.confidence;
        }
      }
    } catch (_) {}

    // Pass 4: Threshold fallback for low-contrast/faint text
    if (!text || text.trim().length < 20) {
      try {
        const thresholdBuffer = await preprocessThreshold(inputBuffer);
        if (thresholdBuffer) {
          const resThresh = await worker.recognize(thresholdBuffer);
          if (resThresh.data.text && resThresh.data.text.trim().length > (text ? text.trim().length : 0)) {
            text = resThresh.data.text;
            confidence = resThresh.data.confidence;
          }
        }
      } catch (_) {}
    }

    return { text: text || "", confidence: confidence || 0 };
  };

  const timeoutJob = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("OCR timeout (20s limit reached)")), 20000)
  );

  try {
    return await Promise.race([ocrJob(), timeoutJob]);
  } finally {
    try {
      await worker.terminate();
    } catch (_) {}
  }
}

module.exports = {
  extractTextFromImage,
};
