import pdfParse from 'pdf-parse';
import xlsx from 'xlsx';
import { parseStringPromise } from 'xml2js';

/** Extract plain-ish text from Buffer + mimetype + filename */
export async function extractText({ buffer, mimetype, originalname }) {
  const name = (originalname || '').toLowerCase();

  if (mimetype === 'application/pdf' || name.endsWith('.pdf')) {
    const pdf = await pdfParse(buffer);
    return pdf.text;
  }

  if (mimetype.includes('spreadsheet') || name.endsWith('.xlsx') || name.endsWith('.xls') || name.endsWith('.csv')) {
    const wb = xlsx.read(buffer, { type: 'buffer' });
    const texts = [];
    for (const sheetName of wb.SheetNames) {
      const ws = wb.Sheets[sheetName];
      const csv = xlsx.utils.sheet_to_csv(ws);
      texts.push(`# Sheet: ${sheetName}\n${csv}`);
    }
    return texts.join('\n\n');
  }

  if (mimetype.includes('xml') || name.endsWith('.xml')) {
    const xml = buffer.toString('utf8');
    const obj = await parseStringPromise(xml, { explicitArray: false, mergeAttrs: true });
    return JSON.stringify(obj, null, 2);
  }

  // fallback: treat as utf8 text
  return buffer.toString('utf8');
}
