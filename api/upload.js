'use strict';

const multer = require('multer');
const { extractTextFromImage } = require('../backend/services/ocrService');
const { parseOCRText } = require('../backend/services/parser');

// Multer in-memory for Vercel (no disk)
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

function runMiddleware(req, res, fn) {
    return new Promise((resolve, reject) => {
        fn(req, res, (result) => {
            if (result instanceof Error) return reject(result);
            return resolve(result);
        });
    });
}

module.exports = async function handler(req, res) {
    // CORS
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
        await runMiddleware(req, res, upload.single('image'));
    } catch (err) {
        return res.status(400).json({ success: false, error: err.message });
    }

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
            courses,
            detectedSlots: detectedSlots || rawSlots.map(s => s.join('+')),
            rawSlots,
            lines
        });
    } catch (err) {
        console.error('OCR error:', err);
        return res.status(500).json({ success: false, error: 'OCR processing failed.', detail: err.message });
    }
};

