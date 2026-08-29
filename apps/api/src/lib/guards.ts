import { ApiError } from './errors.js';

/** 10 MB. Generous for an invoice, small enough to keep memory bounded. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const MAGIC = {
  pdf: Buffer.from([0x25, 0x50, 0x44, 0x46]),
  zip: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
} as const;

/**
 * Validate an upload before it costs us anything.
 *
 * The check is on the BYTES. A declared MIME type comes from the browser and
 * an extension comes from the user; neither is evidence. We use the extension
 * only to tell an .xlsx apart from any other zip, and only after the magic
 * bytes have established that it is a zip at all.
 */
export const guardUpload = (
  buffer: Buffer,
  filename: string,
): { mimeType: string } => {
  if (buffer.length === 0) {
    throw ApiError.badRequest('The uploaded file is empty.');
  }
  if (buffer.length > MAX_UPLOAD_BYTES) {
    throw ApiError.tooLarge(
      `File is ${(buffer.length / 1024 / 1024).toFixed(1)} MB; the limit is ` +
        `${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`,
    );
  }

  const head = buffer.subarray(0, 4);

  if (head.equals(MAGIC.pdf)) return { mimeType: 'application/pdf' };

  if (head.equals(MAGIC.zip)) {
    if (/\.xlsx?$/i.test(filename)) {
      return {
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      };
    }
    throw ApiError.unsupported(
      `"${filename}" is a zip archive but not an .xlsx workbook.`,
    );
  }

  throw ApiError.unsupported(
    `"${filename}" is not a PDF or an .xlsx workbook. ` +
      `Its first bytes match neither format.`,
  );
};
