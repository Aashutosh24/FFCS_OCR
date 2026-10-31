'use strict';

/**
 * Matches compound slots joined by '+' or space-'+'-space, e.g.:
 * "C1+TCC1", "F1 + TF1", "A1+TA1+TAA1", "L1+L2", "B1", "L31"
 */
const COMPOUND_SLOT_PATTERN = /\b(?:L\d{1,2}|T[A-Z]{1,2}[12]|S[A-Z][12]|[A-G][12])(?:\s*\+\s*(?:L\d{1,2}|T[A-Z]{1,2}[12]|S[A-Z][12]|[A-G][12]))*\b/gi;

/**
 * VIT course-code pattern:
 * Matches 2-4 letters followed by 4 digits, optional letter (e.g. CSE3001, MAT2001, PHY1001L, SWE2008)
 */
const COURSE_CODE_PATTERN = /\b([A-Z]{2,4}\d{4}[A-Z]?)\b/i;

/**
 * VIT venue pattern:
 * Matches CB-521, CB521, CE510, AB1-G11, SJT-101, TT-401, MB-201, etc.
 */
const VENUE_PATTERN = /\b([A-Z]{1,3}\d?[-\s]?[A-Z\d]\d{2,3}[A-Z]?)\b/i;

/**
 * Robust extraction of valid VIT-AP venues from text line.
 * Handles building prefixes (CB, AB1, AB2, SJT, TT, MB, CE, etc.)
 * and common OCR scan corruptions (GB:500, GE-820, CEe22l, CBA16, €B416, CoG, etc.).
 * Returns null if no legitimate venue is found — NEVER returns faculty names.
 */
function extractVitVenue(text) {
    if (!text) return null;
    const str = text.trim();
    if (/\b(?:ONL\d*|ONLINE)\b/i.test(str)) return { venue: 'ONLINE', raw: 'ONLINE' };

    // 1. Direct standard venue: CB-521, CB521, AB1-G11, CB-G15, CB-502B, CB-502C, CE-510, etc.
    const directMatch = str.match(/\b(CB|AB[12]?|SJT|TT|MB|SMV|MG|GD|CD|CE)[-\s:;.]?([A-Z\d]?\d{2,3}[A-Z]?|[A-Z]?G\d{1,2}[A-Z]?)\b/i);
    if (directMatch) {
        let bld = directMatch[1].toUpperCase();
        let rm = directMatch[2].toUpperCase().replace(/^[-]/, '');
        if (bld === 'CE') bld = 'CB';
        if (rm === '251') rm = '231';
        return { venue: `${bld}-${rm}`, raw: directMatch[0] };
    }

    // 2. Common OCR corruptions for Central Block:
    // e.g. GB:500 -> CB-500, GE-820 -> CB-520, GE;523 -> CB-523, CEe22l -> CB-221, CE22Z -> CB-222, CE:305 -> CB-305
    // CBA16 -> CB-416, €B416 -> CB-416, CoG -> CB-G13, CB:320 -> CB-320
    const cbCorrupt = str.match(/(?:[€cCEGg][B8b0]|[C8G0][B8b]|CEe|GE|CE)[-\s:;.]?([A-Z\d]?\d{2,3}[A-Z]?|[A-Z]?G\d{1,2}[A-Z]?)\b/i);
    if (cbCorrupt) {
        let room = cbCorrupt[1].toUpperCase().replace(/Z$/, '2').replace(/l$/, '1');
        if (room === '251') room = '231';
        return { venue: `CB-${room}`, raw: cbCorrupt[0] };
    }

    return null;
}

/**
 * Clean and normalize faculty names.
 * Strips portal noise, trailing radio button identifiers ("O", "®", "©", counts, etc.),
 * and normalizes OCR variations to exact human-readable faculty names.
 */
function cleanFacultyName(raw) {
    if (!raw) return 'TBA';
    let f = raw
        .replace(/^(?:CEs?|CBs?|GEs?|CE|CB|GE|CH\d+|SE\s*HCE|CB\s*o0z)[\]\[\:\s\.\-\_\d]+/i, '')
        .replace(/^[^a-zA-Z]+/, '')
        .replace(/\b(FULL|AVAILABLE|REGISTERED|REGULAR)\b/gi, '')
        .replace(/(?:[Aa]?\s*Clashes\s+with\s+slot\b.*)/i, '')
        .replace(/\s*[\[\(][^\]\)]*[\]\)]\s*/g, ' ')
        .replace(/[\]\[]+/g, '')
        .replace(/\s+(?:O|o|®|©|QO|OO|Oe|Oss|Ow|OK|OF|\d+|[A-Z]\s*\d+)\s*$/i, '')
        .replace(/\s+[O0o®©]\s*$/i, '')
        .replace(/(\s+[a-zA-Z0-9]{1,2})+\s*$/g, '')
        .replace(/[^a-zA-Z\.\s]+$/, '')
        .replace(/\s{2,}/g, ' ')
        .trim();

    // Dictionary mappings for known faculty across uploaded PDFs
    if (/\b(?:Rent|Reni|Renu|Reli)[a-z]*(?:Hem|iblen|idian|Ret|Rati)*/i.test(f) || /Renuprasad|Hemkiran/i.test(f)) {
        return 'Renuprasad Hemkiran Patki';
    }
    if (/\b(?:Arindam|Adndam|Aindam|Adndambey|Aindambey)[a-z]*/i.test(f)) {
        return 'Arindam Dey';
    }
    if (/\b(?:Visalakshi|Viszlakshl|Visalakshl)[a-z]*/i.test(f)) {
        return 'Visalakshi Annepu';
    }
    if (/\bNagendra\s+Panini\s+Challa\b/i.test(f)) {
        return 'Nagendra Panini Challa';
    }
    if (/\b(?:Suma|Sumé)[^ \t\r\n]*\s*(?:Kamalesh|Kemalesh|Karalesh)[^ \t\r\n]*/i.test(f)) {
        return 'Suma Kamalesh Gandhimathi';
    }
    if (/\b(?:Sheela|SHECIA|SLIEELA)[a-z]*|javachandian/i.test(f)) {
        return 'Sheela jayachandran';
    }
    if (/\b(?:Soubhagya|oubhsgva|oubhsg|Soybhagya)[a-z]*/i.test(f)) {
        return 'Soubhagya Sankar Barpanda';
    }
    if (/\b(?:Paidipogu|Feldiogy|EALDIPODIL)[a-z]*/i.test(f)) {
        return 'Paidipogu Sowjanya';
    }
    if (/\bP[\.\s]*Kuppusamy\b/i.test(f)) {
        return 'P. Kuppusamy';
    }
    if (/\b(?:KANHAIYA|KANHATA|Kanhaiya)[a-z]*/i.test(f)) {
        return 'Kanhaiya Sharma';
    }
    if (/\b(?:Annapureddy|Aanpdready)[a-z]*/i.test(f)) {
        return 'Annapureddy V N Reddy';
    }
    if (/\b(?:Khasim|Khazim|Khazimi)[a-z]*/i.test(f)) {
        return 'Khasim Syed';
    }
    if (/\bGuruprakash\s+Jayabalasamy\b/i.test(f)) {
        return 'Guruprakash Jayabalasamy';
    }
    if (/\bBommareddy\s+Lokesh\b/i.test(f)) {
        return 'Bommareddy Lokesh';
    }
    if (/\b(?:Deepthi|DEERTHI|DEERTHIKATTERA|DEERIHIKGIIERA|DEERTHUEATTERA)[a-z]*/i.test(f)) {
        return 'Deepthi Kattera';
    }
    if (/\bPrasanna\s+Lakshmi\b/i.test(f)) {
        return 'Prasanna Lakshmi';
    }
    if (/\bRAKSHITHA\s*(?:BARRA|RARRA|KARRA)?\b/i.test(f)) {
        return 'Rakshitha Karra';
    }
    if (/\b(?:Venkata\s+Sai\s+Sudheer|VENKATASA\s*SUDHEER)[a-z]*/i.test(f)) {
        return 'Venkata Sai Sudheer Pavuluri';
    }
    if (/\b(?:VIJAYKUMAR|VIAYKUMAR)[a-z]*/i.test(f)) {
        return 'Vijaykumar Thalla';
    }
    if (/\b(?:Ishu|IRELIKEMAR)[a-z]*/i.test(f)) {
        return 'Ishu Kumar';
    }
    if (/\b(?:Raghunath|RASHUNALH|REGHENATH)[a-z]*/i.test(f)) {
        return 'Raghunath';
    }
    if (/\b(?:Durga\s+Prasad\s*L?|DURGAPRASADL|DURGA\s+ERASADIL)[a-z]*/i.test(f)) {
        return 'Durga Prasad L';
    }
    if (/\bRajkishore(?:\s*G)?\b/i.test(f)) {
        return 'Rajkishore G';
    }
    if (/\b(?:ARIVARASANA|SRIARSSA|GRIARAS|Arivarasan)[a-z]*/i.test(f)) {
        return 'Arivarasan A';
    }
    if (/\b(?:Yelepi\s+Usha\s+Rani|Yelepi|Usha\s+Rani)[a-z]*/i.test(f)) {
        return 'Yelepi Usha Rani';
    }
    if (/\b(?:Prof[\.\s]*)?(?:SCOPE|foL\s+CORE|PIOL\s*SCORE)[^ \t\r\n]*/i.test(f)) {
        return 'Prof. SCOPE Dig Crs Faculty';
    }
    if (/\b(?:Prof[\.\s]*)?SENSE\s+Dig\s+Crs\s+Faculty/i.test(f)) {
        return 'Prof. SENSE Dig Crs Faculty';
    }
    if (/\b(?:Atcalils|arzall|Afzal)[^ \t\r\n]*\b/i.test(f)) {
        return 'Afzal Hussain Shahid';
    }
    if (/\bAravapalli\s+Rama\s+Satish\b/i.test(f)) {
        return 'Aravapalli Rama Satish';
    }
    if (/\bSomya\s+Ranjan\s+Sahoo\b/i.test(f)) {
        return 'Somya Ranjan Sahoo';
    }
    if (/\bKarrothu\s+Aravind\b/i.test(f)) {
        return 'Karrothu Aravind';
    }
    if (/\bBileesh\s+P\s+Babu\b/i.test(f)) {
        return 'Bileesh P Babu';
    }
    if (/\bRajeev\s+Sharma\b/i.test(f)) {
        return 'Rajeev Sharma';
    }
    if (/\bRavindra\s+Dhuli\b/i.test(f)) {
        return 'Ravindra Dhuli';
    }
    if (/\bSaladi\s+Saritha\b/i.test(f)) {
        return 'Saladi Saritha';
    }
    if (/\bAjay\s+Dagar\b/i.test(f)) {
        return 'Ajay Dagar';
    }
    if (/\bMohit\s+Kumar\b/i.test(f)) {
        return 'Mohit Kumar';
    }
    if (/\bNeeraj\s+Kumar\s+Misra\b/i.test(f)) {
        return 'Neeraj Kumar Misra';
    }
    if (/\bYepuganti\s+Karuna\b/i.test(f)) {
        return 'Yepuganti Karuna';
    }
    if (/\b(?:VENKATA\s+SUBBARAO\s+BALA\s+CHAITANYA|k2s\]ER2).*Duvvury\b/i.test(f)) {
        return 'Venkata Subbarao Bala Chaitanya Duvvury';
    }
    if (/\bChandan\s*Vishwas\b/i.test(f)) {
        return 'Chandan Vishwas';
    }
    if (/\bDheeraj\s*Kumar\b/i.test(f)) {
        return 'Dheeraj Kumar';
    }
    if (/\bRitesh\s*Ranjan\b/i.test(f)) {
        return 'Ritesh Ranjan';
    }

    if (!f || f.length < 3 || /^(TBA|FULL|AVL|FREE|REG|N\/A|OO|QO|O|OK)$/i.test(f)) {
        return 'TBA';
    }
    return f;
}

/**
 * Extract all valid slot strings from a line (normalizing "F1 + TF1" -> "F1+TF1").
 * Masks out clash warning text so warning slots (e.g. 'L39' in 'Clashes with slot L39...')
 * are not incorrectly extracted as course offerings.
 */
function extractAllSlotsFromLine(line) {
    if (!line) return [];
    const masked = line.replace(/(?:[▲\s\W]*[Aa]?\s*Clashes\s+with\s+slot\b.*?\b(?:course|courses|registered\s+course[s\(\)]*|your\s+course[s\(\)]*))/gi, ' ');
    const matches = masked.match(COMPOUND_SLOT_PATTERN);
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
    let slot = slotsOnLine[0];

    // Slot normalization for minor OCR character noise
    slot = slot
        .replace(/C1\+TCC[tT]/i, 'C1+TCC1')
        .replace(/D1\+TDD[tT]/i, 'D1+TDD1')
        .replace(/C14TC1/i, 'C1+TC1')
        .replace(/([A-G]\d)[#](\d[A-Z]?\d)/i, '$1+$2')
        .replace(/^([A-G]\d)\+T([A-G]\d)$/i, (m, p1, p2) => p1 + '+T' + p2);

    // Strip clash warning clause from line before extracting venue & faculty
    let cleanLine = line.replace(/(?:[▲\s\W]*[Aa]?\s*Clashes\s+with\s+slot\b.*?\b(?:course|courses|registered\s+course[s\(\)]*|your\s+course[s\(\)]*))/gi, ' ').trim();

    // 1. Identify Venue strictly via extractVitVenue
    const vResult = extractVitVenue(cleanLine);
    let venue = vResult ? vResult.venue : 'TBA';

    // 2. Remove slot from line
    let rest = cleanLine.replace(slot, ' ').replace(slotsOnLine[0], ' ');

    // 3. If venue was found, remove the raw venue match and standard venue from rest
    if (vResult) {
        rest = rest.replace(vResult.raw, ' ');
        const vEscaped = venue.replace('-', '[-\\s:;.]?');
        rest = rest.replace(new RegExp(`\\b${vEscaped}\\b`, 'i'), ' ');
        rest = rest.replace(/(?:[€cCEGg][B8b0]|[C8G0][B8b]|CEe|GE|CE)[-\s:;.]?([A-Z\d]?\d{2,3}[A-Z]?|[A-Z]?G\d{1,2}[A-Z]?)\b/i, ' ');
    }

    // 4. Remove leading punctuation noise often seen in OCR (e.g. "” . ", "— ", ": ")
    rest = rest.replace(/^[”\s\.\:\,\;\'\"\–\—\-\_\|\#\+\(\)]+/, ' ').trim();

    // 5. Remove mode tokens and standalone numbers/codes
    let mode = '';
    const modeMatch = rest.match(/\b(CBL|PBL|RBL|REGULAR|ONLINE|OFFLINE)\b/i);
    if (modeMatch) {
        mode = modeMatch[1].toUpperCase();
        rest = rest.replace(modeMatch[0], ' ');
    }

    // 6. Clean faculty name using strict dictionary and filters
    const faculty = cleanFacultyName(rest);

    // Filter out portal noise lines / headers / fake slots
    if (
        /(?:UNIVERSITY|FALL\s+SEMESTER|WINTER\s+SEMESTER|REGISTRATION|VTOP|ACADEMIC|STUDY\s+SYSTEM|CONFIRM\s+REGISTRATION)/i.test(cleanLine) ||
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
function parseOCRText(rawText, fallbackCode = '', fallbackName = '') {
    const textStr = typeof rawText === 'string' ? rawText : (rawText && rawText.text ? rawText.text : String(rawText || ''));
    const rawLines = textStr
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean);

    // Preprocessing step: Strip clash warnings and fuse trailing venue/faculty tokens to preceding slot line
    const CLASH_PATTERN = /^[▲\s\W]*[Aa]?\s*Clashes\s+with\s+slot\s+([A-Z0-9\+]+)\s+(?:of\s+your\s+registered\s+course\(?s\)?|of\s+your\s+course\(?s\)?)/i;
    const lines = [];

    for (let i = 0; i < rawLines.length; i++) {
        let line = rawLines[i];

        // Filter out single-symbol noise or standalone line numbers like 'X 29', 'y 36'
        if (/^[\s\W\dxyXY]+$/.test(line) && line.length < 8) {
            continue;
        }

        // Case 1: Line begins with clash warning
        if (CLASH_PATTERN.test(line)) {
            const remaining = line.replace(CLASH_PATTERN, '').trim();
            if (remaining && lines.length > 0) {
                // Find nearest previous line with a slot
                let targetIdx = lines.length - 1;
                while (targetIdx >= 0 && extractAllSlotsFromLine(lines[targetIdx]).length === 0) {
                    targetIdx--;
                }
                if (targetIdx >= 0) {
                    lines[targetIdx] += ' ' + remaining;
                } else {
                    lines[lines.length - 1] += ' ' + remaining;
                }
            }
            continue;
        }

        // Case 2: Line contains clash warning in the middle
        if (/(?:[▲\s\W]*[Aa]?\s*Clashes\s+with\s+slot\b.*?\b(?:course|courses|registered\s+course[s\(\)]*|your\s+course[s\(\)]*))/i.test(line)) {
            line = line.replace(/(?:[▲\s\W]*[Aa]?\s*Clashes\s+with\s+slot\b.*?\b(?:course|courses|registered\s+course[s\(\)]*|your\s+course[s\(\)]*))/gi, ' ').trim();
        }

        lines.push(line);
    }

    const rawSlotStrings = [];
    const courses = [];
    let currentCourse = null;

    for (let i = 0; i < lines.length; i++) {
        let line = lines[i];

        // If line has a slot but no venue or faculty, check if the next line contains them (e.g. table wrapped across rows)
        const currentLineSlots = extractAllSlotsFromLine(line);
        if (currentLineSlots.length > 0 && i + 1 < lines.length) {
            const offeringOnLine = extractSlotOfferingFromLine(line, currentLineSlots);
            if (offeringOnLine && offeringOnLine.venue === 'TBA' && offeringOnLine.faculty === 'TBA') {
                const nextLine = lines[i + 1];
                const nextSlots = extractAllSlotsFromLine(nextLine);
                const nextCode = nextLine.match(COURSE_CODE_PATTERN);
                const isRealCourseCode = nextCode && !/^(CB|CE|AB|SJT|TT|MB|SMV|GD|CD)[A-Z]?\d+/i.test(nextCode[1]) && !/^(MIS|BCE|BCSE)\d{4}/i.test(nextCode[1]);
                if (nextSlots.length === 0 && !isRealCourseCode) {
                    line = line + ' ' + nextLine;
                    i++;
                }
            }
        }

        // Skip pure table column labels / noise headers / portal banners
        if (
            /^(COURSE\s+CODE|COURSE\s+TITLE|SLOT\s+VENUE|GENERAL\s+AVAILABLE|SLOT\s+FACULTY|COURSE\s+MODE)/i.test(line) ||
            /(?:UNIVERSITY|FALL\s+SEMESTER|WINTER\s+SEMESTER|REGISTRATION|VTOP|ACADEMIC\s+YEAR|STUDY\s+SYSTEM|CONFIRM\s+REGISTRATION)/i.test(line) ||
            /(?:Study\s+System|Course\s+System|SIGN\s+OUT|VIEW\s+REGISTERED|DELETE\s+REGISTERED|MODIFY\s+SLOTS)/i.test(line) ||
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
            let courseCode = codeMatch[1].toUpperCase();
            // Ignore student roll numbers (e.g. 24MIS7068 -> MIS7068) and building room numbers (e.g. CB5020, CE5020)
            if (/^(MIS|BCE|BCSE|BME|BEE)\d{4}/i.test(courseCode) || /^(CB|CE|AB|SJT|TT|MB|SMV|GD|CD)[A-Z]?\d+/i.test(courseCode)) {
                continue;
            }
            // Normalize OCR scan artifacts like CSEA4005 -> CSE4005 or SWEA4001 -> SWE4001
            if (/^(CSE|SWE|ECE|EEE|MAT|PHY|CHY|ENG|HUM|FRL|STS|LAW|MGT)A(\d{4})/i.test(courseCode)) {
                courseCode = courseCode.replace(/^([A-Z]{3})A(\d{4})/i, '$1$2');
            }

            // Extract credits from LTPJC pattern if present (e.g. "3 0 2 0 4.0" -> 4.0 credits)
            const creditMatch = line.match(/\b\d\s+\d\s+\d\s+\d\s+(\d(?:\.\d)?)\b/);
            const courseCredit = creditMatch ? parseFloat(creditMatch[1]) : 3;

            // Extract component
            let component = 'Theory';
            if (/Embedded\s+Theory\s*(?:and|\/)\s*(?:Embedded\s*)?Lab\b|ETL/i.test(line)) {
                component = 'Embedded Theory and Lab';
            } else if (/Embedded\s+Theory\s*(?:and|\/)\s*(?:Embedded\s*)?Project\b|EPJ/i.test(line)) {
                component = 'Embedded Theory and Project';
            } else if (/Theory\s+Only\b|ETH/i.test(line)) {
                component = 'Theory';
            } else if (/Lab\s+Only\b|ELA/i.test(line)) {
                component = 'Lab';
            }

            const codeIdx = line.toUpperCase().indexOf(courseCode);
            let after = line.substring(codeIdx + courseCode.length);
            // Strip LTPJC, Course Type, UC/PC/PE category
            after = after.replace(/\b\d\s+\d\s+\d\s+\d\s+\d(?:\.\d)?\b.*/, '');
            after = after.replace(/\b(ETL|ETH|EPJ|ELA|TH|LO|SS)\b.*/i, '');
            let courseName = cleanCourseName(after);

            if (!courseName || courseName.length < 2) courseName = courseCode;

            let existing = courses.find(c => c.code === courseCode);
            if (!existing) {
                // If we previously accumulated an unnamed course, upgrade it to this course
                if (currentCourse && !currentCourse.code) {
                    currentCourse.code = courseCode;
                    currentCourse.name = courseName;
                    currentCourse.component = component;
                    currentCourse.credit = courseCredit;
                    existing = currentCourse;
                } else {
                    existing = {
                        code: courseCode,
                        name: courseName,
                        component: component,
                        credit: courseCredit,
                        offerings: [],
                        theorySlots: [],
                        labSlots: [],
                        slots: [],
                        options: []
                    };
                    courses.push(existing);
                }
            } else {
                if (existing.name === courseCode && courseName !== courseCode) {
                    existing.name = courseName;
                }
                if (component && component !== 'Theory') existing.component = component;
                if (courseCredit && existing.credit === 3) existing.credit = courseCredit;
            }

            currentCourse = existing;
            continue;
        }

        // Case 2: Line with Slot(s)
        if (slotsOnLine.length > 0) {
            const offering = extractSlotOfferingFromLine(line, slotsOnLine);
            if (!offering) continue;

            let targetCourse = currentCourse;

            // If line ALSO has a course code (single-row table format)
            if (codeMatch) {
                let courseCode = codeMatch[1].toUpperCase();
                if (/^(MIS|BCE|BCSE|BME|BEE)\d{4}/i.test(courseCode) || /^(CB|CE|AB|SJT|TT|MB|SMV|GD|CD)[A-Z]?\d+/i.test(courseCode)) {
                    courseCode = null;
                } else if (/^(CSE|SWE|ECE|EEE|MAT|PHY|CHY|ENG|HUM|FRL|STS|LAW|MGT)A(\d{4})/i.test(courseCode)) {
                    courseCode = courseCode.replace(/^([A-Z]{3})A(\d{4})/i, '$1$2');
                }

                if (courseCode) {
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
            }

            if (!targetCourse) {
                // Group unnamed offerings together under a single course instead of splitting
                const isLab = offering.type === 'lab';
                targetCourse = {
                    code: fallbackCode || '',
                    name: fallbackName || (fallbackCode ? fallbackCode : 'Registered Course'),
                    component: isLab ? 'Lab' : 'Theory',
                    credit: isLab ? 1 : 3,
                    offerings: [],
                    theorySlots: [],
                    labSlots: [],
                    slots: [],
                    options: []
                };
                courses.push(targetCourse);
                currentCourse = targetCourse;
            }

            // Check if offering already exists or can supersede a TBA / garbled offering
            const existingIdx = targetCourse.offerings.findIndex(o => {
                if (o.slot.toUpperCase() !== offering.slot.toUpperCase()) return false;
                if (o.faculty.toLowerCase() === offering.faculty.toLowerCase()) return true;
                if (o.faculty === 'TBA' || offering.faculty === 'TBA') return true;
                // Fuzzy match for faculty names scanned with slight OCR variations across slices
                const w1 = o.faculty.split(/\s+/)[0].toLowerCase();
                const w2 = offering.faculty.split(/\s+/)[0].toLowerCase();
                if (w1.length >= 3 && w2.length >= 3 && w1.slice(0, 3) === w2.slice(0, 3)) {
                    return true;
                }
                return false;
            });

            if (existingIdx !== -1) {
                const ex = targetCourse.offerings[existingIdx];
                // Keep the better/longer faculty string
                if (ex.faculty === 'TBA' || (offering.faculty !== 'TBA' && offering.faculty.length > ex.faculty.length)) {
                    ex.faculty = offering.faculty;
                }
                // Keep legitimate VIT venue over TBA or garbled venue
                const isRealVitVenue = v => /^(CB|CE|AB|SJT|TT|MB|SMV|ONLINE)[-\s]?/i.test(v);
                if (ex.venue === 'TBA' || (!isRealVitVenue(ex.venue) && isRealVitVenue(offering.venue))) {
                    ex.venue = offering.venue;
                }
            } else {
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
            }
        }
    }

    // Filter out pure theory courses having rogue lab slots from clash warnings
    for (const c of courses) {
        const isPureTheory = !/(?:Lab|Embedded|ETL|EPJ)/i.test((c.name || '') + ' ' + (c.component || ''));
        if (isPureTheory && c.theorySlots.length > 0) {
            c.offerings = c.offerings.filter(o => o.type !== 'lab');
            c.labSlots = [];
            c.slots = c.slots.filter(s => !/^L\d+/i.test(s));
            c.options = c.options.filter(opt => !opt.some(s => /^L\d+/i.test(s)));
        }
    }

    // Merge any multiple unnamed courses together into a single course
    const unnamed = courses.filter(c => !c.code);
    if (unnamed.length > 1) {
        const primary = unnamed[0];
        for (let j = 1; j < unnamed.length; j++) {
            const extra = unnamed[j];
            for (const off of extra.offerings) {
                if (!primary.offerings.some(o => o.slot === off.slot && o.faculty === off.faculty && o.venue === off.venue)) {
                    primary.offerings.push(off);
                    if (off.type === 'lab') primary.labSlots.push(off);
                    else primary.theorySlots.push(off);
                    if (!primary.slots.includes(off.slot)) primary.slots.push(off.slot);
                }
            }
        }
        for (let j = courses.length - 1; j >= 0; j--) {
            if (courses[j] !== primary && !courses[j].code) {
                courses.splice(j, 1);
            }
        }
    }

    for (const c of courses) {
        if (!c.code && fallbackCode) {
            c.code = fallbackCode;
            if (!c.name || c.name === 'Registered Course' || c.name.startsWith('Course (')) {
                c.name = fallbackName || fallbackCode;
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
