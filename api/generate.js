'use strict';

const { generateSchedules } = require('../backend/services/scheduler');
const { rankSchedules } = require('../backend/services/optimizer');

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
        const { courses, preferences = {}, topN = 5 } = req.body;

        if (!Array.isArray(courses) || courses.length === 0) {
            return res.status(400).json({ success: false, error: 'courses array is required and must not be empty.' });
        }

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
};

