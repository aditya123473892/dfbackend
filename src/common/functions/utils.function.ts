import { extname } from 'path';
import { randomBytes } from 'crypto';
import { DefaultFindParams } from '../interfaces';
import * as archiver from 'archiver';
import internal, { Readable } from 'stream';
import * as moment from 'moment-timezone';

export const convertToKey = (title: string): string => {
  return (
    title
      .trim()
      .replace(/\s+/g, '-')
      .replace(/[^A-Za-z0-9_]/g, '-')
      .toLowerCase() || ''
  );
};

export const generateParams = (params: any, options?: any) => {
  return {
    ...DefaultFindParams,
    ...params,
    ...options,
  };
};

const allowedExtensions = [
  '.jpg',
  '.jpeg',
  '.png',
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
];

export function customFilename(req, file, callback) {
  const randomName = randomBytes(8).toString('hex');
  const fileExtName = extname(file.originalname);
  if (allowedExtensions.includes(fileExtName.toLowerCase())) {
    callback(
      null,
      `${randomName}.${convertToSlug(
        file.originalname.split('.')[0],
      )}${fileExtName}`,
    );
  } else {
    callback(new Error('Invalid file type'));
  }
}

export function allowedFileTypes(filename: string): boolean {
  const fileExtName = extname(filename);
  return allowedExtensions.includes(fileExtName.toLowerCase());
}

function convertToSlug(inputString) {
  // Convert the string to lowercase
  const lowerCaseString = inputString.toLowerCase();

  // Replace spaces and special characters (except '_' and '-') with '-'
  const slug = lowerCaseString.replace(/[^\w-]/g, '-');

  return slug;
}

export async function createZipBuffer(
  files: { filename: string; buffer: Buffer }[],
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const archive = archiver('zip');
    const chunks: Buffer[] = [];

    archive.on('error', (err) => reject(err));

    archive.on('data', (chunk) => chunks.push(chunk));

    archive.on('end', () => resolve(Buffer.concat(chunks)));

    files.forEach((file) => {
      const readable = new Readable();
      readable._read = () => {}; // Necessary to make the stream readable
      readable.push(file.buffer);
      readable.push(null);
      archive.append(readable, { name: file.filename });
    });

    archive.finalize();
  });
}

/**
 * Add interval to date.
 * @param {string | Date} baseDate - The campaign timeline date.
 * @param {string} interval - Interval of in this formate  1 day / 1 week etc.
 */
export function addIntervalToDate(
  baseDate: string | Date,
  interval: string,
): Date | null {
  if (!baseDate || !interval) {
    console.error('Both baseDate and interval are required.');
    return null;
  }

  const matchResult = interval.match(/(\d+)\s*(\w+)/);
  if (!matchResult) {
    console.error(
      'Invalid interval format. Expected format: "<number> <unit>".',
    );
    return null;
  }

  const [, number, unit] = matchResult;

  const duration: Record<string, number> = {
    day: 24 * 60 * 60 * 1000,
    week: 7 * 24 * 60 * 60 * 1000,
    month: 30 * 24 * 60 * 60 * 1000,
    months: 30 * 24 * 60 * 60 * 1000,
  };

  const baseDateTime =
    typeof baseDate === 'string'
      ? new Date(baseDate).getTime()
      : baseDate.getTime();
  const milliseconds = parseInt(number, 10) * duration[unit];
  const newDate = new Date(baseDateTime + milliseconds);
  return newDate;
}

export const convertDateToTimezone = (date: string, timezone: string) => {
  const sourceDate = moment(date).tz(moment.tz.guess());

  const destinationDate = sourceDate.clone().tz(timezone);

  return destinationDate.toDate() || new Date();
};

export function generateSlug(name: string): string {
  // Remove spaces and convert to lowercase
  const slug = name.replace(/\s+/g, '').toLowerCase();
  return slug;
}
