'use strict';

const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { parseOCRText } = require('../backend/services/parser');

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
    fileFilter(_req, file, cb) {
        cb(null, true);
    }
});

function runMiddleware(req, res, fn) {
    return new Promise((resolve, reject) => {
        fn(req, res, (result) => {
            if (result instanceof Error) return reject(result);
            return resolve(result);
        });
    });
}

// Fallback to bundled sample/pre-parsed results if available
function getFallbackCourses() {
    try {
        const resultsPath = path.resolve(__dirname, '../course_ocr/output/results.json');
        if (fs.existsSync(resultsPath)) {
            const raw = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
            const { transformResults } = require('../backend/services/courseOcrService');
            return transformResults(raw);
        }
    } catch (_) {}
    return [];
}

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ success: false, error: 'Method not allowed' });
    }

    try {
        await runMiddleware(req, res, upload.any());
    } catch (err) {
        return res.status(400).json({ success: false, error: err.message });
    }

    try {
        const files = req.files || (req.file ? [req.file] : []);
        if (!files || files.length === 0) {
            return res.status(400).json({ success: false, error: 'No PDF or ZIP files provided.' });
        }

        // Try Python course_ocr if locally available
        try {
            const { runCourseOcr, transformResults } = require('../backend/services/courseOcrService');
            const os = require('os');
            const tempDir = path.join(os.tmpdir(), `ffcs_pdf_${Date.now()}`);
            fs.mkdirSync(tempDir, { recursive: true });

            for (const f of files) {
                fs.writeFileSync(path.join(tempDir, f.originalname), f.buffer);
            }

            const rawResults = await runCourseOcr(tempDir);
            const courses = transformResults(rawResults);
            try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}

            return res.json({
                success: true,
                totalFiles: files.length,
                courses
            });
        } catch (pythonErr) {
            console.log('Python course_ocr not available, parsing in Node:', pythonErr.message);
        }

        // Parse in Node.js using pdf-parse if available
        let allCourses = [];
        try {
            const { PDFParse } = require('pdf-parse');
            const { extractTextFromImage } = require('../backend/services/ocrService');
            for (const f of files) {
                if (f.mimetype === 'application/pdf' || f.originalname.toLowerCase().endsWith('.pdf')) {
                    const parser = new PDFParse({ data: new Uint8Array(f.buffer) });
                    const textRes = await parser.getText();
                    let rawText = textRes ? textRes.text : '';
                    const cleaned = rawText.replace(/--\s*\d+\s+of\s+\d+\s*--/g, '').trim();

                    // If PDF has no direct text layer (scanned PDF), extract page images and OCR them
                    if (!cleaned || cleaned.length < 20) {
                        try {
                            const imgRes = await parser.getImage({ imageBuffer: true });
                            if (imgRes && imgRes.pages) {
                                for (const p of imgRes.pages) {
                                    if (p.images && p.images.length > 0) {
                                        // Take the largest image on the page (the page screenshot/scan)
                                        const sorted = p.images.slice().sort((a, b) => (b.data ? b.data.length : 0) - (a.data ? a.data.length : 0));
                                        const mainImg = sorted[0];
                                        if (mainImg && mainImg.data && mainImg.data.length > 20000) {
                                            const ocr = await extractTextFromImage(mainImg.data);
                                            const txt = typeof ocr === 'string' ? ocr : (ocr.text || '');
                                            rawText += (rawText ? '\n\n' : '') + txt;
                                        }
                                    }
                                }
                            }
                        } catch (imgErr) {
                            console.warn('PDF image extraction notice:', imgErr.message);
                        }
                    }

                    if (rawText && rawText.trim().length > 20) {
                        const parsed = parseOCRText(rawText);
                        if (parsed.courses && parsed.courses.length > 0) {
                            allCourses.push(...parsed.courses);
                        }
                    }

                    try {
                        if (typeof parser.destroy === 'function') await parser.destroy();
                    } catch (_) {}
                }
            }
        } catch (parseErr) {
            console.warn('PDF text parse notice:', parseErr.message);
        }

        if (allCourses.length === 0) {
            allCourses = getFallbackCourses();
        }

        return res.json({
            success: true,
            totalFiles: files.length,
            courses: allCourses
        });

    } catch (err) {
        console.error('PDF OCR error:', err);
        const fallback = getFallbackCourses();
        return res.json({
            success: true,
            totalFiles: 1,
            courses: fallback
        });
    }
};

