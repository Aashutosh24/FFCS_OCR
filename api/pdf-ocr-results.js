'use strict';

const path = require('path');
const fs = require('fs');

module.exports = function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    try {
        const resultsPath = path.resolve(__dirname, '../course_ocr/output/results.json');
        if (!fs.existsSync(resultsPath)) {
            return res.json({ success: true, totalFiles: 0, courses: [] });
        }

        const raw = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
        const { transformResults } = require('../backend/services/courseOcrService');
        const courses = transformResults(raw);
        return res.json({ success: true, totalFiles: raw.length, courses });
    } catch (e) {
        return res.status(500).json({ success: false, error: `Could not read results: ${e.message}` });
    }
};

