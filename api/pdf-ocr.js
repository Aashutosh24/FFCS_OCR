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
    const all = [];
    let start = 0;
    while ((start = buffer.indexOf(Buffer.from([0xFF, 0xD8, 0xFF]), start)) !== -1) {
        const end = buffer.indexOf(Buffer.from([0xFF, 0xD9]), start + 2);
        if (end !== -1) {
            const data = buffer.subarray(start, end + 2);
            let w = 0, h = 0;
            for (let k = 0; k < data.length - 8; k++) {
                if (data[k] === 0xFF && (data[k + 1] === 0xC0 || data[k + 1] === 0xC2)) {
                    h = data.readUInt16BE(k + 5);
                    w = data.readUInt16BE(k + 7);
                    break;
                }
            }
            if (data.length > 40000 && w >= 1200 && h >= 600) {
                const aspect = w / h;
                if (aspect >= 0.7 && aspect <= 2.5) {
                    all.push({ offset: start, size: data.length, w, h, data });
                }
            }
            start = end + 2;
        } else {
            break;
        }
    }

    if (all.length === 0) {
        // Fallback for smaller/cropped PDFs
        let s2 = 0;
        while ((s2 = buffer.indexOf(Buffer.from([0xFF, 0xD8, 0xFF]), s2)) !== -1) {
            const e2 = buffer.indexOf(Buffer.from([0xFF, 0xD9]), s2 + 2);
            if (e2 !== -1) {
                const d2 = buffer.subarray(s2, e2 + 2);
                if (d2.length > 25000) all.push({ offset: s2, size: d2.length, w: 0, h: 0, data: d2 });
                s2 = e2 + 2;
            } else break;
        }
    }

    // Determine dominant resolution (e.g. 2361x1637)
    const dimCounts = {};
    for (const item of all) {
        if (item.w && item.h) {
            const k = item.w + 'x' + item.h;
            dimCounts[k] = (dimCounts[k] || 0) + 1;
        }
    }
    const dominantDim = Object.keys(dimCounts).sort((a,b) => dimCounts[b] - dimCounts[a])[0];

    // Pick exactly one primary image per page offset (spaced by >= 350KB in the PDF stream)
    const pages = [];
    for (const item of all) {
        const isDominant = (item.w + 'x' + item.h) === dominantDim;
        if (isDominant || all.length <= 4) {
            const isClose = pages.some(p => Math.abs(p.offset - item.offset) < 350000);
            if (!isClose) {
                pages.push(item);
            }
        }
    }

    if (pages.length > 0) return pages.map(p => p.data);
    return all.slice(0, 5).map(p => p.data);
}

function inferCourseFromFilename(filename) {
    if (!filename) return null;
    const base = filename.replace(/\.[^/.]+$/, '').trim();
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

        for (const f of files.slice(0, 50)) {
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
                    const fnInfo = inferCourseFromFilename(f.originalname || '');
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
            } else if (isImg) {
                try {
                    const ocr = await extractTextFromImage(f.buffer);
                    const txt = typeof ocr === 'string' ? ocr : (ocr.text || '');
                    if (txt && txt.trim().length > 20) {
                        const fnInfo = inferCourseFromFilename(f.originalname || '');
                        const fallbackCode = fnInfo ? fnInfo.code : '';
                        const fallbackName = fnInfo ? fnInfo.name : '';
                        const parsed = parseOCRText(txt, fallbackCode, fallbackName);
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
module.exports.extractSmartSlices = extractSmartSlices;
module.exports.config = {
    api: {
        bodyParser: false,
    },
};
