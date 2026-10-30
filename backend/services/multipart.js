'use strict';

const Busboy = require('busboy');

/**
 * Robust multipart/form-data parser for Vercel Serverless Functions.
 * Accurately tracks pending file streams, cancels safety timer on completion,
 * and handles both streams and pre-buffered bodies.
 */
function parseMultipart(req, maxFileSize = 25 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
        if (req.files && Array.isArray(req.files) && req.files.length > 0) {
            return resolve(req.files);
        }
        if (req.file) {
            return resolve([req.file]);
        }

        const contentType = req.headers['content-type'] || req.headers['Content-Type'] || '';
        if (!contentType.includes('multipart/form-data')) {
            return resolve([]);
        }

        let bb;
        try {
            bb = Busboy({
                headers: req.headers,
                limits: { fileSize: maxFileSize }
            });
        } catch (err) {
            return reject(err);
        }

        const files = [];
        let isDone = false;
        let busboyClosed = false;
        let pendingFiles = 0;
        let timer = null;

        const cleanupAndResolve = () => {
            if (isDone) return;
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
            isDone = true;
            resolve(files);
        };

        const cleanupAndReject = (err) => {
            if (isDone) return;
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
            isDone = true;
            reject(err);
        };

        const checkCompletion = () => {
            if (busboyClosed && pendingFiles === 0) {
                cleanupAndResolve();
            }
        };

        bb.on('file', (name, fileStream, info) => {
            pendingFiles++;
            const { filename, encoding, mimeType } = info;
            const chunks = [];

            fileStream.on('data', (d) => chunks.push(d));

            fileStream.on('end', () => {
                const buffer = Buffer.concat(chunks);
                files.push({
                    fieldname: name,
                    originalname: filename || 'upload.png',
                    encoding,
                    mimetype: mimeType || 'image/png',
                    buffer,
                    size: buffer.length
                });
                pendingFiles--;
                checkCompletion();
            });

            fileStream.on('error', (err) => {
                console.warn('File stream error:', err.message);
                pendingFiles--;
                checkCompletion();
            });
        });

        bb.on('close', () => {
            busboyClosed = true;
            checkCompletion();
        });

        bb.on('finish', () => {
            busboyClosed = true;
            checkCompletion();
        });

        bb.on('error', (err) => {
            cleanupAndReject(err);
        });

        // 12-second safety timeout
        timer = setTimeout(() => {
            if (!isDone) {
                cleanupAndResolve();
            }
        }, 12000);

        // Pre-buffered body
        if (req.body && Buffer.isBuffer(req.body)) {
            try {
                bb.end(req.body);
            } catch (e) {
                cleanupAndReject(e);
            }
        } else if (req.rawBody && Buffer.isBuffer(req.rawBody)) {
            try {
                bb.end(req.rawBody);
            } catch (e) {
                cleanupAndReject(e);
            }
        } else if (typeof req.body === 'string' && req.body.length > 0) {
            try {
                bb.end(Buffer.from(req.body, 'binary'));
            } catch (e) {
                cleanupAndReject(e);
            }
        } else {
            req.pipe(bb);
        }
    });
}

module.exports = { parseMultipart };
