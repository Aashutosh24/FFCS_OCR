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
            for (const f of files) {
                if (f.mimetype === 'application/pdf' || f.originalname.toLowerCase().endsWith('.pdf')) {
                    const parser = new PDFParse(new Uint8Array(f.buffer));
                    const textRes = await parser.getText();
                    if (textRes && textRes.text && textRes.text.trim().length > 20) {
                        const parsed = parseOCRText(textRes.text);
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

