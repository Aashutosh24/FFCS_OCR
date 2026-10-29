'use strict';

const multer = require('multer');
const { extractTextFromImage } = require('../backend/services/ocrService');
const { parseOCRText } = require('../backend/services/parser');

// In-memory multer storage (zero disk storage, auto-discarded after response)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB max total
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

module.exports = async function handler(req, res) {
    // Enable CORS
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
            return res.status(400).json({ success: false, error: 'No image file provided.' });
        }

        let combinedRawText = '';
        let allCourses = [];
        let allDetectedSlots = [];
        let allRawSlots = [];
        let allLines = [];

        for (const file of files) {
            try {
                const ocrResult = await extractTextFromImage(file.buffer);
                const rawText = typeof ocrResult === 'string' ? ocrResult : (ocrResult.text || '');
                const { courses, detectedSlots, rawSlots, lines } = parseOCRText(rawText);

                combinedRawText += (combinedRawText ? '\n\n' : '') + rawText;
                allCourses.push(...courses);
                if (detectedSlots) allDetectedSlots.push(...detectedSlots);
                if (rawSlots) allRawSlots.push(...rawSlots);
                if (lines) allLines.push(...lines);
            } catch (fileErr) {
                console.error(`Error processing file ${file.originalname}:`, fileErr);
            }
        }

        // Deduplicate courses by course code
        const uniqueCourses = [];
        const seenCodes = new Set();
        for (const c of allCourses) {
            const key = (c.code || c.name || '').toUpperCase();
            if (!seenCodes.has(key)) {
                seenCodes.add(key);
                uniqueCourses.push(c);
            } else {
                // Merge offerings if already present
                const existing = uniqueCourses.find(ec => (ec.code || ec.name || '').toUpperCase() === key);
                if (existing && c.offerings) {
                    existing.offerings = existing.offerings || [];
                    for (const off of c.offerings) {
                        if (!existing.offerings.some(eo => eo.slot === off.slot && eo.faculty === off.faculty)) {
                            existing.offerings.push(off);
                        }
                    }
                }
            }
        }

        return res.json({
            success: true,
            rawText: combinedRawText,
            courses: uniqueCourses,
            detectedSlots: allDetectedSlots.length > 0 ? Array.from(new Set(allDetectedSlots)) : allRawSlots.map(s => Array.isArray(s) ? s.join('+') : s),
            rawSlots: allRawSlots,
            lines: allLines
        });
    } catch (err) {
        console.error('OCR error:', err);
        return res.status(500).json({ success: false, error: 'OCR processing failed.', detail: err.message });
    }
};
