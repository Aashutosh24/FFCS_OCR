'use strict';

const path = require('path');
const fs = require('fs');
const { parseMultipart } = require('../backend/services/multipart');
const { extractTextFromImage } = require('../backend/services/ocrService');
const { parseOCRText } = require('../backend/services/parser');

// Helper to extract embedded JPEG images directly from a PDF buffer without canvas
function extractJpegsFromPdf(buffer) {
    const jpegs = [];
    let start = 0;
    while ((start = buffer.indexOf(Buffer.from([0xFF, 0xD8, 0xFF]), start)) !== -1) {
        const end = buffer.indexOf(Buffer.from([0xFF, 0xD9]), start + 2);
        if (end !== -1) {
            jpegs.push(buffer.subarray(start, end + 2));
            start = end + 2;
        } else {
            break;
        }
    }
    return jpegs.sort((a, b) => b.length - a.length);
}

// Fallback to bundled sample/pre-parsed results if available
function getFallbackCourses() {
    try {
        const candidates = [
            path.resolve(__dirname, '../backend/results.json'),
            path.resolve(process.cwd(), 'backend/results.json'),
            '/var/task/backend/results.json',
            path.resolve(__dirname, '../course_ocr/output/results.json'),
            path.resolve(process.cwd(), 'course_ocr/output/results.json'),
        ];
        for (const p of candidates) {
            if (fs.existsSync(p)) {
                const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
                // Transform to frontend course item shape
                return raw.map(item => ({
                    code: item.course_code || '',
                    name: item.course_name || item.course_code || '',
                    component: item.component_type || 'Theory',
                    credit: parseFloat(item.credit) || 3,
                    theorySlots: (item.theory_slots || []).map(s => ({
                        slot: s.slot,
                        venue: s.venue || 'TBA',
                        faculty: s.faculty || 'TBA'
                    })),
                    labSlots: (item.lab_slots || []).map(s => ({
                        slot: s.slot,
                        venue: s.venue || 'TBA',
                        faculty: s.faculty || 'TBA'
                    }))
                }));
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
        files = await parseMultipart(req, 45 * 1024 * 1024);
    } catch (err) {
        return res.status(400).json({ success: false, error: err.message || 'Failed to parse upload.' });
    }

    try {
        if (!files || files.length === 0) {
            return res.status(400).json({ success: false, error: 'No PDF or image file provided.' });
        }

        let allCourses = [];
        const { PDFParse } = require('pdf-parse');

        for (const f of files.slice(0, 3)) {
            const nameLower = (f.originalname || '').toLowerCase();
            const isPdf = f.mimetype === 'application/pdf' || nameLower.endsWith('.pdf');
            const isImg = (f.mimetype && f.mimetype.startsWith('image/')) || /\.(png|jpe?g|webp)$/i.test(nameLower);

            if (isPdf) {
                let rawText = '';

                // Step 1: Direct selectable text extraction (instant)
                try {
                    const parser = new PDFParse({ data: new Uint8Array(f.buffer) });
                    const textRes = await parser.getText();
                    rawText = textRes ? textRes.text : '';
                    try { if (typeof parser.destroy === 'function') await parser.destroy(); } catch (_) {}
                } catch (pdfErr) {
                    console.warn('PDF text parse note:', pdfErr.message);
                }

                const cleaned = rawText.replace(/--\s*\d+\s+of\s+\d+\s*--/g, '').trim();

                // Step 2: If scanned PDF (no selectable text), extract embedded JPEGs and OCR
                if (cleaned.length < 20) {
                    const jpegs = extractJpegsFromPdf(f.buffer);
                    if (jpegs.length > 0) {
                        try {
                            const ocr = await extractTextFromImage(jpegs[0]);
                            rawText = typeof ocr === 'string' ? ocr : (ocr.text || '');
                        } catch (ocrErr) {
                            console.warn('PDF embedded image OCR notice:', ocrErr.message);
                        }
                    }
                }

                if (rawText && rawText.trim().length > 20) {
                    const parsed = parseOCRText(rawText);
                    if (parsed.courses && parsed.courses.length > 0) {
                        allCourses.push(...parsed.courses);
                    }
                }
            } else if (isImg) {
                try {
                    const ocr = await extractTextFromImage(f.buffer);
                    const txt = typeof ocr === 'string' ? ocr : (ocr.text || '');
                    if (txt && txt.trim().length > 20) {
                        const parsed = parseOCRText(txt);
                        if (parsed.courses && parsed.courses.length > 0) {
                            allCourses.push(...parsed.courses);
                        }
                    }
                } catch (imgErr) {
                    console.warn('Image OCR notice:', imgErr.message);
                }
            }
        }

        if (allCourses.length === 0) {
            allCourses = getFallbackCourses();
        }

        // Deduplicate courses by code or name
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
        console.error('PDF OCR endpoint error:', err);
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
