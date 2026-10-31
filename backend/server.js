'use strict';

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const rateLimit = require('express-rate-limit');

const { extractTextFromImage } = require('./services/ocrService');
const { parseOCRText } = require('./services/parser');
const { generateSchedules } = require('./services/scheduler');
const { rankSchedules } = require('./services/optimizer');
const { runCourseOcr, transformResults, COURSE_OCR_OUT_DIR } = require('./services/courseOcrService');
const pdfParse = require('pdf-parse');
const { extractSmartSlices } = require('../api/pdf-ocr');

const app = express();
const PORT = process.env.PORT || 3001;

// ── Rate limiters ────────────────────────────────────────────────────────────
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' }
});

const uploadLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many upload requests, please try again later.' }
});

// ── Middleware ──────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Serve frontend static files
app.use(express.static(path.join(__dirname, '../frontend')));

// ── Multer – in-memory storage for uploaded images ──────────────────────────
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
    fileFilter(_req, file, cb) {
        const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp'];
        if (allowed.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Only image files are accepted (JPEG, PNG, GIF, WEBP, BMP).'));
        }
    }
});

// ── Multer – disk storage for PDF / ZIP uploads (course_ocr pipeline) ────────
const pdfUploadDir = path.join(os.tmpdir(), 'ffcs_ai_pdf_uploads');
if (!fs.existsSync(pdfUploadDir)) fs.mkdirSync(pdfUploadDir, { recursive: true });

const pdfUpload = multer({
    storage: multer.diskStorage({
        destination: (_req, _file, cb) => cb(null, pdfUploadDir),
        filename: (_req, file, cb) => {
            const ext = path.extname(file.originalname).toLowerCase();
            cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
        }
    }),
    limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB (batch of PDFs as ZIP)
    fileFilter(_req, file, cb) {
        const mime = file.mimetype;
        const ext  = path.extname(file.originalname).toLowerCase();
        const ok   = mime === 'application/pdf'
                  || mime === 'application/zip'
                  || mime === 'application/x-zip-compressed'
                  || ext === '.pdf'
                  || ext === '.zip';
        if (ok) cb(null, true);
        else cb(new Error('Only PDF or ZIP files are accepted for the course OCR pipeline.'));
    }
});

/**
 * Wrap multer so that any multer-level error is returned as JSON
 * instead of Express's default HTML error page.
 */
function inferCourseFromFilename(filename) {
    if (!filename) return null;
    const base = path.basename(filename, path.extname(filename)).trim();
    const codeMatch = base.match(/\b([A-Z]{2,4}\d{4}[A-Z]?)\b/i);
    if (codeMatch) {
        return { code: codeMatch[1].toUpperCase(), name: codeMatch[1].toUpperCase() };
    }
    const lower = base.toLowerCase();
    if (/adv.*german|german/i.test(lower)) return { code: 'FRL2005', name: 'German for Advanced Learners' };
    if (/french/i.test(lower)) return { code: 'FRE2001', name: 'French' };
    if (/sgc|secure.*group/i.test(lower)) return { code: 'CSE3013', name: 'Secure Group Communications' };
    if (/\bdw\b|data.*warehous/i.test(lower)) return { code: 'CSE4005', name: 'Data Warehousing and Data Mining' };
    if (/sts|competitive.*coding/i.test(lower)) return { code: 'STS4006', name: 'Advanced Competitive Coding - II' };
    if (/agile/i.test(lower)) return { code: 'CSE3001', name: 'Agile Development Process' };
    if (/\bst\b|testing/i.test(lower)) return { code: 'SWE4002', name: 'Software Testing' };
    if (/iwt|internet.*web/i.test(lower)) return { code: 'SWE3002', name: 'Internet and Web Technology' };
    if (/fda|data.*analytic/i.test(lower)) return { code: 'CSE3002', name: 'Foundations of Data Analytics' };
    if (/\bml\b|machine.*learn/i.test(lower)) return { code: 'CSE3008', name: 'Introduction to Machine Learning' };
    if (/\bdl\b|deep.*learn/i.test(lower)) return { code: 'CSE4022', name: 'Deep Learning' };
    if (/cloud/i.test(lower)) return { code: 'CSE3006', name: 'Cloud Computing' };

    const cleanTitle = base.replace(/[_\-]+/g, ' ').trim();
    return { code: base.toUpperCase().slice(0, 8), name: cleanTitle };
}

function uploadSingle(fieldName) {
    const multerMiddleware = upload.single(fieldName);
    return (req, res, next) => {
        multerMiddleware(req, res, err => {
            if (err) {
                return res.status(400).json({ success: false, error: err.message });
            }
            next();
        });
    };
}

// ── Routes ──────────────────────────────────────────────────────────────────

/**
 * POST /api/upload
 * Accept a screenshot and extract slot text via OCR.
 * Returns rawText, structured courses (if course headers detected) and raw slot groups.
 */
app.post('/api/upload', uploadLimiter, uploadSingle('image'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, error: 'No image file provided.' });
        }

        const ocrResult = await extractTextFromImage(req.file.buffer);
        const rawText = typeof ocrResult === 'string' ? ocrResult : (ocrResult.text || '');
        const { courses, detectedSlots, rawSlots, lines } = parseOCRText(rawText);

        return res.json({
            success: true,
            rawText,
            courses,        // structured: [{ code, name, slots: string[], options: string[][] }]
            detectedSlots: detectedSlots || rawSlots.map(s => s.join('+')),
            rawSlots,
            lines
        });
    } catch (err) {
        console.error('OCR error:', err);
        return res.status(500).json({ success: false, error: 'OCR processing failed.', detail: err.message });
    }
});

/**
 * POST /api/generate
 * Accept structured course data + preferences and return ranked timetables.
 *
 * Body:
 * {
 *   courses: [
 *     { course: "CN", options: [["C1","TCC1"], ["F2","TF2"]] },
 *     ...
 *   ],
 *   preferences: {
 *     preferMorning: false,
 *     preferEvening: false,
 *     minimizeBreaks: true,
 *     freeDayPreference: "SAT"   // optional
 *   },
 *   topN: 5
 * }
 */
app.post('/api/generate', apiLimiter, (req, res) => {
    try {
        const { courses, preferences = {}, topN = 5 } = req.body;

        if (!Array.isArray(courses) || courses.length === 0) {
            return res.status(400).json({ success: false, error: 'courses array is required and must not be empty.' });
        }

        // Validate structure
        for (const c of courses) {
            if (!c.course || !Array.isArray(c.options) || c.options.length === 0) {
                return res.status(400).json({
                    success: false,
                    error: `Invalid course entry: ${JSON.stringify(c)}. Each course needs "course" (string) and "options" (array of slot arrays).`
                });
            }
        }

        const allSchedules = generateSchedules(courses, Math.min(topN * 100, 5000));
        const ranked = rankSchedules(allSchedules, preferences, topN);

        return res.json({
            success: true,
            totalFound: allSchedules.length,
            topN: ranked.length,
            schedules: ranked
        });
    } catch (err) {
        console.error('Generate error:', err);
        return res.status(500).json({ success: false, error: 'Schedule generation failed.', detail: err.message });
    }
});

/**
 * POST /api/pdf-ocr
 * Accept one or multiple PDFs, or a ZIP of PDFs, run the course_ocr Python pipeline on them,
 * and return the structured course extraction results.
 *
 * The uploaded files are saved to a temporary folder, the pipeline is run across all files,
 * and the combined results.json produced in course_ocr/output/ is read and returned.
 * The course_ocr source code is never modified.
 *
 * Form field: "pdfs" (supports single or multiple files)
 */
app.post('/api/pdf-ocr', uploadLimiter, (req, res, next) => {
    pdfUpload.array('pdfs', 50)(req, res, err => {
        if (err) return res.status(400).json({ success: false, error: err.message });
        next();
    });
}, async (req, res) => {
    const files = req.files || (req.file ? [req.file] : []);
    if (!files || files.length === 0) {
        return res.status(400).json({ success: false, error: 'No PDF or ZIP files provided.' });
    }

    try {
        // If single ZIP file uploaded, fallback to course_ocr Python pipeline if available
        if (files.length === 1 && path.extname(files[0].originalname).toLowerCase() === '.zip') {
            try {
                const rawResults = await runCourseOcr(files[0].path);
                const courses    = transformResults(rawResults);
                return res.json({
                    success: true,
                    totalFiles: rawResults.length,
                    courses,
                    outputDir: COURSE_OCR_OUT_DIR,
                });
            } catch (zipErr) {
                console.warn('Zip processing fallback note:', zipErr.message);
            }
        }

        let allCourses = [];

        for (const file of files) {
            const buf = fs.readFileSync(file.path);
            const nameLower = (file.originalname || '').toLowerCase();
            const isPdf = file.mimetype === 'application/pdf' || nameLower.endsWith('.pdf');
            const isImg = (file.mimetype && file.mimetype.startsWith('image/')) || /\.(png|jpe?g|webp)$/i.test(nameLower);

            let rawText = '';

            if (isPdf) {
                // Step 1: Direct selectable text extraction (instant)
                try {
                    const pdfData = await pdfParse(buf);
                    rawText = (pdfData.text || '').replace(/--\s*\d+\s+of\s+\d+\s*--/g, '').trim();
                } catch (pdfErr) {
                    console.warn(`Direct PDF text extraction note (${file.originalname}):`, pdfErr.message);
                }

                // Step 2: Scanned PDF fallback via smart embedded slice extraction & OCR
                if (rawText.length < 20) {
                    const slices = extractSmartSlices(buf);
                    for (const slice of slices) {
                        try {
                            const ocr = await extractTextFromImage(slice);
                            const txt = typeof ocr === 'string' ? ocr : (ocr.text || '');
                            if (txt && txt.trim()) {
                                rawText += '\n\n' + txt;
                            }
                        } catch (ocrErr) {
                            console.warn(`Slice OCR notice (${file.originalname}):`, ocrErr.message);
                        }
                    }
                }
            } else if (isImg) {
                try {
                    const ocr = await extractTextFromImage(buf);
                    rawText = typeof ocr === 'string' ? ocr : (ocr.text || '');
                } catch (imgErr) {
                    console.warn(`Image OCR notice (${file.originalname}):`, imgErr.message);
                }
            }

            if (rawText && rawText.trim().length > 20) {
                const fnInfo = inferCourseFromFilename(file.originalname || '');
                const fallbackCode = fnInfo ? fnInfo.code : '';
                const fallbackName = fnInfo ? fnInfo.name : '';
                const parsed = parseOCRText(rawText, fallbackCode, fallbackName);
                if (parsed.courses && parsed.courses.length > 0) {
                    for (const c of parsed.courses) {
                        if (!c.code && fallbackCode) {
                            c.code = fallbackCode;
                            c.name = fallbackName;
                        }
                        allCourses.push(c);
                    }
                }
            }
        }

        // Deduplicate courses by code or name
        const uniqueCourses = [];
        const seen = new Set();
        for (const c of allCourses) {
            const k = (c.code || c.name || '').toUpperCase();
            if (!seen.has(k)) {
                seen.add(k);
                uniqueCourses.push(c);
            } else {
                const existing = uniqueCourses.find(ec => (ec.code || ec.name || '').toUpperCase() === k);
                if (existing) {
                    const mergeList = (targetList, sourceList) => {
                        const seenSlots = new Set(targetList.map(s => `${(s.slot||'').toUpperCase()}__${(s.faculty||'').toLowerCase()}`));
                        for (const item of sourceList) {
                            const sk = `${(item.slot||'').toUpperCase()}__${(item.faculty||'').toLowerCase()}`;
                            if (!seenSlots.has(sk)) {
                                seenSlots.add(sk);
                                targetList.push(item);
                            }
                        }
                    };
                    mergeList(existing.theorySlots, c.theorySlots || []);
                    mergeList(existing.labSlots, c.labSlots || []);
                    mergeList(existing.offerings, c.offerings || []);
                    for (const s of c.slots || []) {
                        if (!existing.slots.includes(s)) existing.slots.push(s);
                    }
                }
            }
        }

        // Save to results.json for local preview / review tools
        try {
            const resultsJsonPath = path.join(COURSE_OCR_OUT_DIR, 'results.json');
            fs.writeFileSync(resultsJsonPath, JSON.stringify(uniqueCourses, null, 2), 'utf8');
        } catch (_) {}
        try {
            const backendOutPath = path.join(__dirname, 'results.json');
            fs.writeFileSync(backendOutPath, JSON.stringify(uniqueCourses, null, 2), 'utf8');
        } catch (_) {}

        return res.json({
            success: true,
            totalFiles: files.length,
            courses: uniqueCourses,
            outputDir: COURSE_OCR_OUT_DIR,
        });

    } catch (err) {
        console.error('PDF OCR error:', err);
        return res.status(500).json({ success: false, error: err.message });
    } finally {
        for (const file of files) {
            if (file.path && fs.existsSync(file.path)) {
                fs.unlink(file.path, () => {});
            }
        }
    }
});

/**
 * GET /api/pdf-ocr/results
 */
app.get('/api/pdf-ocr/results', apiLimiter, (_req, res) => {
    const resultsPath = path.join(COURSE_OCR_OUT_DIR, 'results.json');
    if (!fs.existsSync(resultsPath)) {
        return res.status(404).json({ success: false, error: 'No results.json found. Run the PDF OCR pipeline first.' });
    }
    try {
        const raw     = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
        const courses = transformResults(raw);
        return res.json({ success: true, totalFiles: raw.length, courses });
    } catch (e) {
        return res.status(500).json({ success: false, error: `Could not read results.json: ${e.message}` });
    }
});

/**
 * GET /api/health
 * Simple health check.
 */
app.get('/api/health', apiLimiter, (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── Catch-all: serve the frontend SPA ───────────────────────────────────────
app.get('*', apiLimiter, (_req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// ── Global JSON error handler ────────────────────────────────────────────────
// Catches any error passed via next(err) and always responds with JSON.
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
    console.error('Unhandled error:', err);
    if (!res.headersSent) {
        res.status(err.status || 500).json({
            success: false,
            error: err.message || 'Internal server error'
        });
    }
});

// ── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`FFCS AI Planner running on http://localhost:${PORT}`);
});

module.exports = app;
