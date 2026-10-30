'use strict';

const Busboy = require('busboy');

/**
 * Robust multipart/form-data parser for Vercel Serverless Functions.
 * Handles both streaming requests and pre-buffered bodies (req.body or req.rawBody),
 * with safety timeout so serverless functions never hang or exceed Vercel limits.
 */
function parseMultipart(req, maxFileSize = 45 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
        // If files are already attached
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

        const cleanupAndResolve = () => {
            if (isDone) return;
            isDone = true;
            resolve(files);
        };

        const cleanupAndReject = (err) => {
            if (isDone) return;
            isDone = true;
            reject(err);
        };

        bb.on('file', (name, fileStream, info) => {
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
            });
            fileStream.on('error', (err) => {
                console.warn('File stream warning:', err.message);
            });
        });

        bb.on('close', cleanupAndResolve);
        bb.on('finish', cleanupAndResolve);
        bb.on('error', cleanupAndReject);

        // Safety timeout to ensure request never hangs indefinitely
        const timer = setTimeout(() => {
            console.warn('Multipart parsing reached safety guard');
            cleanupAndResolve();
        }, 8000);

        // If body has already been buffered by Vercel
        if (req.body && Buffer.isBuffer(req.body)) {
            try {
                bb.end(req.body);
                clearTimeout(timer);
            } catch (e) {
                clearTimeout(timer);
                cleanupAndReject(e);
            }
        } else if (req.rawBody && Buffer.isBuffer(req.rawBody)) {
            try {
                bb.end(req.rawBody);
                clearTimeout(timer);
            } catch (e) {
                clearTimeout(timer);
                cleanupAndReject(e);
            }
        } else if (typeof req.body === 'string' && req.body.length > 0) {
            try {
                bb.end(Buffer.from(req.body, 'binary'));
                clearTimeout(timer);
            } catch (e) {
                clearTimeout(timer);
                cleanupAndReject(e);
            }
        } else {
            // Normal readable stream
            req.pipe(bb);
        }
    });
}

module.exports = { parseMultipart };
