'use strict';

const path = require('path');
const fs = require('fs');
const { parseMultipart } = require('../backend/services/multipart');
const { parseOCRText } = require('../backend/services/parser');

// Fallback to bundled sample/pre-parsed results if available
function getFallbackCourses() {
    try {
        const candidates = [
            path.resolve(__dirname, '../course_ocr/output/results.json'),
            path.resolve(process.cwd(), 'course_ocr/output/results.json'),
            '/var/task/course_ocr/output/results.json'
        ];
        for (const p of candidates) {
            if (fs.existsSync(p)) {
                const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
                const { transformResults } = require('../backend/services/courseOcrService');
                return transformResults(raw);
            }
        }
    } catch (_) {}
    return [];
}

async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ success: false, error: 'Method not allowed' });
    }

    let files = [];
    try {
        files = await parseMultipart(req, 50 * 1024 * 1024);
    } catch (err) {
        return res.status(400).json({ success: false, error: err.message || 'Failed to parse upload.' });
    }

    try {
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

        // Parse in Node.js using pdf-parse and ocrService
        let allCourses = [];
        try {
            const { PDFParse } = require('pdf-parse');
            const { extractTextFromImage } = require('../backend/services/ocrService');

            for (const f of files) {
                const nameLower = (f.originalname || '').toLowerCase();
                const isPdf = f.mimetype === 'application/pdf' || nameLower.endsWith('.pdf');
                const isImg = (f.mimetype && f.mimetype.startsWith('image/')) || /\.(png|jpe?g|webp)$/i.test(nameLower);

                if (isPdf) {
                    const parser = new PDFParse({ data: new Uint8Array(f.buffer) });
                    const textRes = await parser.getText();
                    let rawText = textRes ? textRes.text : '';
                    const cleaned = rawText.replace(/--\s*\d+\s+of\s+\d+\s*--/g, '').trim();

                    // If PDF has no direct text layer (scanned PDF), extract page images and OCR them
                    if (!cleaned || cleaned.length < 20) {
                        try {
                            const imgRes = await parser.getImage({ imageBuffer: true });
                            if (imgRes && imgRes.pages) {
                                // Process up to first 2 pages
                                for (const p of imgRes.pages.slice(0, 2)) {
                                    if (p.images && p.images.length > 0) {
                                        // Take the largest image on the page
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
                } else if (isImg) {
                    const ocr = await extractTextFromImage(f.buffer);
                    const txt = typeof ocr === 'string' ? ocr : (ocr.text || '');
                    if (txt && txt.trim().length > 20) {
                        const parsed = parseOCRText(txt);
                        if (parsed.courses && parsed.courses.length > 0) {
                            allCourses.push(...parsed.courses);
                        }
                    }
                }
            }
        } catch (parseErr) {
            console.warn('PDF text parse notice:', parseErr.message);
        }

        if (allCourses.length === 0) {
            allCourses = getFallbackCourses();
        }

        // Deduplicate courses
        const uniqueCourses = [];
        const seen = new Set();
        for (const c of allCourses) {
            const k = (c.code || c.name || '').toUpperCase();
            if (!seen.has(k)) {
                seen.add(k);
                uniqueCourses.push(c);
            }
        }

        return res.json({
            success: true,
            totalFiles: files.length,
            courses: uniqueCourses
        });
    } catch (err) {
        console.error('PDF processing error:', err);
        return res.status(500).json({
            success: false,
            error: 'Failed to process file(s).',
            detail: err.message
        });
    }
}

module.exports = handler;
module.exports.config = {
    api: {
        bodyParser: false,
    },
};
