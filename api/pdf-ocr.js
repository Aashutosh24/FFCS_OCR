'use strict';

const pdfParse = require('pdf-parse');
const { parseMultipart } = require('../backend/services/multipart');
const { extractTextFromImage } = require('../backend/services/ocrService');
const { parseOCRText } = require('../backend/services/parser');

/**
 * Extract embedded JPEG images directly from a PDF buffer without canvas/DOMMatrix.
 * Filters out duplicate color planes, extreme aspect ratio divider lines, and empty chrome.
 * Preserves the natural reading order (offset) from page 1 to the end of the document.
 */
function extractSmartSlices(buffer) {
    const jpegs = [];
    let start = 0;
    while ((start = buffer.indexOf(Buffer.from([0xFF, 0xD8, 0xFF]), start)) !== -1) {
        const end = buffer.indexOf(Buffer.from([0xFF, 0xD9]), start + 2);
        if (end !== -1) {
            const data = buffer.subarray(start, end + 2);
            // Parse dimensions from JPEG SOF markers
            let w = 0, h = 0;
            for (let k = 0; k < data.length - 8; k++) {
                if (data[k] === 0xFF && (data[k + 1] === 0xC0 || data[k + 1] === 0xC2)) {
                    h = data.readUInt16BE(k + 5);
                    w = data.readUInt16BE(k + 7);
                    break;
                }
            }
            jpegs.push({ offset: start, size: data.length, data, w, h });
            start = end + 2;
        } else {
            break;
        }
    }

    // 1. Substantive images (> 25KB, width >= 300, height >= 150)
    const substantive = jpegs.filter(j => j.size > 25000 && j.w >= 300 && j.h >= 150);

    // 2. Filter extreme aspect ratios (divider lines, thin header strips: aspect > 4.5 or < 0.25)
    const reasonable = substantive.filter(j => {
        const aspect = j.w / j.h;
        return aspect >= 0.25 && aspect <= 4.5;
    });

    // 3. Deduplicate consecutive duplicate dimensions (identical graphics / color planes)
    const deduplicated = [];
    for (const s of reasonable) {
        const last = deduplicated[deduplicated.length - 1];
        if (!last || last.w !== s.w || last.h !== s.h) {
            deduplicated.push(s.data);
        }
    }

    if (deduplicated.length > 0) return deduplicated.slice(0, 6);
    // Fallback if metadata extraction was inconclusive
    return jpegs.sort((a, b) => b.size - a.size).slice(0, 4).map(c => c.data);
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

        for (const f of files.slice(0, 3)) {
            const nameLower = (f.originalname || '').toLowerCase();
            const isPdf = f.mimetype === 'application/pdf' || nameLower.endsWith('.pdf');
            const isImg = (f.mimetype && f.mimetype.startsWith('image/')) || /\.(png|jpe?g|webp)$/i.test(nameLower);

            if (isPdf) {
                let rawText = '';

                // Step 1: Direct selectable text extraction (instant)
                try {
                    const pdfData = await pdfParse(f.buffer);
                    rawText = pdfData.text || '';
                } catch (pdfErr) {
                    console.warn('Direct PDF text extraction note:', pdfErr.message);
                }

                const cleaned = rawText.replace(/--\s*\d+\s+of\s+\d+\s*--/g, '').trim();

                // Step 2: If scanned PDF (no selectable text), extract all embedded page images in order and OCR
                if (cleaned.length < 20) {
                    const slices = extractSmartSlices(f.buffer);
                    if (slices.length > 0) {
                        for (const slice of slices) {
                            try {
                                const ocr = await extractTextFromImage(slice);
                                const txt = typeof ocr === 'string' ? ocr : (ocr.text || '');
                                if (txt && txt.trim()) {
                                    rawText += '\n\n' + txt;
                                }
                            } catch (ocrErr) {
                                console.warn('PDF embedded image OCR notice:', ocrErr.message);
                            }
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
            return res.status(422).json({
                success: false,
                error: 'No course information could be extracted from the uploaded files.',
                totalFiles: files.length,
                courses: []
            });
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
