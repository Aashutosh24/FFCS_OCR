'use strict';

/**
 * Matches compound slots joined by '+' or space-'+'-space, e.g.:
 * "C1+TCC1", "F1 + TF1", "A1+TA1+TAA1", "L1+L2", "B1", "L31"
 */
const COMPOUND_SLOT_PATTERN = /\b(?:L\d{1,2}|T[A-Z]{1,2}\d|S[A-Z]\d|[A-G]\d)(?:\s*\+\s*(?:L\d{1,2}|T[A-Z]{1,2}\d|S[A-Z]\d|[A-G]\d))*\b/gi;

/**
 * VIT course-code pattern:
 * Matches 2-4 letters followed by 4 digits, optional letter (e.g. CSE3001, MAT2001, PHY1001L, SWE2008)
 */
const COURSE_CODE_PATTERN = /\b([A-Z]{2,4}\d{4}[A-Z]?)\b/i;

/**
 * Extract all valid slot strings from a line (normalizing "F1 + TF1" -> "F1+TF1")
 */
function extractAllSlotsFromLine(line) {
    if (!line) return [];
    const matches = line.match(COMPOUND_SLOT_PATTERN);
    if (!matches) return [];

    return matches.map(m => m.replace(/\s+/g, '').toUpperCase());
}

/**
 * Clean course title from raw text line
 */
function cleanCourseName(rawName) {
    if (!rawName) return '';
    return rawName
        .replace(/^[\s\-–:\d\.\(\)]+/, '')
        .replace(/[\s\-–:\d\.\(\)]+$/, '')
        .replace(/[\-–\s]*(?:Embedded\b.*|Theory\s+Only\b.*|Lab\s+Only\b.*)$/i, '')
        .replace(/[\s\-–:\d\.\(\)]+$/, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

/**
 * Extract structured slot offering (slot, faculty, venue, mode, type) from a table row line
 */
function extractSlotOfferingFromLine(line, slotsOnLine) {
    if (!slotsOnLine || slotsOnLine.length === 0) return null;
    const slot = slotsOnLine[0];

    // Method 1: Column splitting with 2 or more spaces
    const parts = line.split(/\s{2,}/).map(p => p.trim()).filter(Boolean);
    let venue = '';
    let faculty = '';
    let mode = '';

    if (parts.length >= 3) {
        const slotPartIdx = parts.findIndex(p => extractAllSlotsFromLine(p).length > 0);
        if (slotPartIdx !== -1) {
            const remainingParts = parts.slice(slotPartIdx + 1);
            // Venue: e.g. CB-423, SJT-101, MB-201, TT-401, etc.
            const venueIdx = remainingParts.findIndex(p => /^[A-Z0-9]{2,6}[-\s]?[A-Z0-9]{2,5}$/i.test(p));
            if (venueIdx !== -1) {
                venue = remainingParts[venueIdx];
                const afterVenue = remainingParts.slice(venueIdx + 1);
                // Non-faculty tail: CBL, PBL, RBL, 0, etc.
                const nonFacultyIdx = afterVenue.findIndex(p => /^(CBL|PBL|RBL|REGULAR|ONLINE|OFFLINE|\d+)$/i.test(p));
                if (nonFacultyIdx !== -1) {
                    faculty = afterVenue.slice(0, nonFacultyIdx).join(' ');
                    mode = afterVenue[nonFacultyIdx];
                } else {
                    faculty = afterVenue.join(' ');
                }
            } else {
                venue = remainingParts[0] || '';
                faculty = remainingParts[1] || '';
            }
        }
    }

    // Method 2: Regex fallback
    if (!faculty) {
        let rest = line.replace(slot, '').trim();
        const venueMatch = rest.match(/\b([A-Z0-9]{2,6}-[A-Z0-9]{2,5})\b/i);
        if (venueMatch) {
            venue = venueMatch[1].toUpperCase();
            rest = rest.replace(venueMatch[0], '').trim();
        }
        rest = rest.replace(/\b(CBL|PBL|RBL|REGULAR|ONLINE|OFFLINE)\b/gi, '').replace(/\b\d+\b/g, '').trim();
        faculty = rest.replace(/[—_–\-\:\.\,]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
    }

    // Clean faculty string
    faculty = faculty
        .replace(/^[^a-zA-Z]+/, '')
        .replace(/\s*\([^)]*\)\s*$/g, '')
        .replace(/(\s+[a-zA-Z0-9]{1,2})+\s*$/g, '')
        .replace(/[^a-zA-Z\.\s]+$/, '')
        .replace(/\s{2,}/g, ' ')
        .trim();

    if (!faculty || faculty.length < 2) faculty = 'TBA';
    if (!venue || venue.length < 2) venue = 'TBA';

    // Filter out portal noise lines / headers / fake slots (e.g. "UNIVERSITY FALL SEMESTER 2026-27 REGISTRATION")
    if (
        /(?:UNIVERSITY|FALL\s+SEMESTER|WINTER\s+SEMESTER|REGISTRATION|VTOP|ACADEMIC|STUDY\s+SYSTEM|CONFIRM\s+REGISTRATION)/i.test(line) ||
        /(?:UNIVERSITY|FALL\s+SEMESTER|WINTER\s+SEMESTER|REGISTRATION|VTOP|ACADEMIC|STUDY\s+SYSTEM|CONFIRM\s+REGISTRATION)/i.test(faculty)
    ) {
        return null;
    }

    const isLab = /^L\d+/i.test(slot);

    return {
        slot,
        venue,
        faculty,
        mode: mode || 'CBL',
        type: isLab ? 'lab' : 'theory'
    };
}

/**
 * Parse raw OCR text into structured courses and slot groups.
 */
function parseOCRText(rawText) {
    const textStr = typeof rawText === 'string' ? rawText : (rawText && rawText.text ? rawText.text : String(rawText || ''));
    const lines = textStr
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean);

    const rawSlotStrings = [];
    const courses = [];
    let currentCourse = null;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Skip pure table column labels / noise headers / portal banners
        if (
            /^(COURSE\s+CODE|COURSE\s+TITLE|SLOT\s+VENUE|GENERAL\s+AVAILABLE|SLOT\s+FACULTY|COURSE\s+MODE)/i.test(line) ||
            /(?:UNIVERSITY|FALL\s+SEMESTER|WINTER\s+SEMESTER|REGISTRATION|VTOP|ACADEMIC\s+YEAR|STUDY\s+SYSTEM|CONFIRM\s+REGISTRATION)/i.test(line) ||
            line === 'GENERAL' || line === 'AVAILABLE' || line === '—_—'
        ) {
            continue;
        }

        const codeMatch = line.match(COURSE_CODE_PATTERN);
        const slotsOnLine = extractAllSlotsFromLine(line);

        if (slotsOnLine.length > 0) {
            slotsOnLine.forEach(s => {
                if (!rawSlotStrings.includes(s)) rawSlotStrings.push(s);
            });
        }

        // Case 1: Course Header Line (Course Code without slots, e.g. "SWE2008 Object Oriented Analysis and Design ETL")
        if (codeMatch && slotsOnLine.length === 0) {
            const courseCode = codeMatch[1].toUpperCase();
            const parts = line.split(/\s{2,}/).map(p => p.trim()).filter(Boolean);

            let courseName = '';
            let component = '';

            if (parts.length >= 2) {
                const codeIdx = parts.findIndex(p => p.toUpperCase() === courseCode);
                if (codeIdx !== -1) {
                    const rest = parts.slice(codeIdx + 1);
                    if (rest.length >= 2) {
                        courseName = rest[0];
                        component = rest[1];
                    } else if (rest.length === 1) {
                        courseName = rest[0];
                    }
                }
            }

            if (!courseName) {
                const codeIdx = line.toUpperCase().indexOf(courseCode);
                let after = line.substring(codeIdx + courseCode.length);
                const compMatch = after.match(/\b(ETL|ETH|EPJ|ELA|TH|LO|SS)\b/i);
                if (compMatch) {
                    component = compMatch[1].toUpperCase();
                    after = after.replace(compMatch[0], '');
                }
                courseName = cleanCourseName(after);
            }

            if (!courseName || courseName.length < 2) courseName = courseCode;

            let existing = courses.find(c => c.code === courseCode);
            if (!existing) {
                existing = {
                    code: courseCode,
                    name: courseName,
                    component: component || 'Theory',
                    credit: 3,
                    offerings: [],
                    theorySlots: [],
                    labSlots: [],
                    slots: [],
                    options: []
                };
                courses.push(existing);
            } else if (existing.name === courseCode && courseName !== courseCode) {
                existing.name = courseName;
                if (component) existing.component = component;
            }

            currentCourse = existing;
            continue;
        }

        // Case 2: Line with Slot(s)
        if (slotsOnLine.length > 0) {
            const offering = extractSlotOfferingFromLine(line, slotsOnLine);

            let targetCourse = currentCourse;

            // If line ALSO has a course code (single-row table format)
            if (codeMatch) {
                const courseCode = codeMatch[1].toUpperCase();
                targetCourse = courses.find(c => c.code === courseCode);
                if (!targetCourse) {
                    const cleanName = cleanCourseName(line.replace(codeMatch[1], '').replace(slotsOnLine[0], '')) || courseCode;
                    targetCourse = {
                        code: courseCode,
                        name: cleanName,
                        component: 'Theory',
                        credit: 3,
                        offerings: [],
                        theorySlots: [],
                        labSlots: [],
                        slots: [],
                        options: []
                    };
                    courses.push(targetCourse);
                }
                currentCourse = targetCourse;
            }

            if (targetCourse && offering) {
                targetCourse.offerings.push(offering);
                if (offering.type === 'lab') {
                    targetCourse.labSlots.push(offering);
                } else {
                    targetCourse.theorySlots.push(offering);
                }

                if (!targetCourse.slots.includes(offering.slot)) {
                    targetCourse.slots.push(offering.slot);
                }

                const optKey = offering.slot.split('+').sort().join('+');
                const alreadyHas = targetCourse.options.some(opt => opt.slice().sort().join('+') === optKey);
                if (!alreadyHas) {
                    targetCourse.options.push(offering.slot.split('+'));
                }
            } else if (!targetCourse && offering) {
                // Orphaned slot row
                const isLab = offering.type === 'lab';
                courses.push({
                    code: '',
                    name: `Course (${offering.slot})`,
                    component: isLab ? 'Lab' : 'Theory',
                    credit: isLab ? 1 : 3,
                    offerings: [offering],
                    theorySlots: isLab ? [] : [offering],
                    labSlots: isLab ? [offering] : [],
                    slots: [offering.slot],
                    options: [offering.slot.split('+')]
                });
            }
        }
    }

    const validCourses = courses.filter(c => (c.offerings && c.offerings.length > 0) || c.slots.length > 0);

    return {
        courses: validCourses,
        detectedSlots: rawSlotStrings,
        rawSlots: rawSlotStrings.map(s => s.split('+')),
        lines
    };
}

function parseCompoundSlot(compound) {
    if (!compound) return [];
    return compound
        .toUpperCase()
        .split('+')
        .map(s => s.trim())
        .filter(Boolean);
}

const SLOT_PATTERN = COMPOUND_SLOT_PATTERN;

/**
 * Validate that all slots in a compound slot array exist in the slot DB.
 * Returns unknown slots.
 * @param {string[]} slots
 * @param {Object} slotDB
 * @returns {string[]} Unknown slot names
 */
function validateSlots(slots, slotDB) {
    return slots.filter(s => !slotDB[s]);
}

module.exports = { parseOCRText, parseCompoundSlot, validateSlots, SLOT_PATTERN };
