const http = require('http');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const PORT = process.env.PORT || 3000;
const ROOT_DIR = process.cwd();
const DATA_DIR = path.join(ROOT_DIR, 'data');
const DATA_FILE = path.join(DATA_DIR, 'bookings.json');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, '[]\n', 'utf8');
  }
}

function readBookings() {
  ensureDataFile();
  const raw = fs.readFileSync(DATA_FILE, 'utf8');
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [];
}

function writeBookings(bookings) {
  fs.writeFileSync(DATA_FILE, `${JSON.stringify(bookings, null, 2)}\n`, 'utf8');
}

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function parseRequestBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!data) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function toMinutes(time) {
  const [hours, minutes] = String(time).split(':').map(Number);
  return (hours * 60) + minutes;
}

function parseAndValidateSlot(body) {
  const date = typeof body.date === 'string' ? body.date : '';
  const time = typeof body.time === 'string' ? body.time : '';
  const duration = Number(body.duration);

  const isValidDate = /^\d{4}-\d{2}-\d{2}$/.test(date);
  const isValidTime = /^\d{2}:\d{2}$/.test(time);
  const isValidDuration = Number.isInteger(duration) && duration > 0;

  if (!isValidDate || !isValidTime || !isValidDuration) {
    return { error: 'Invalid date, time, or duration.' };
  }

  const startMinutes = toMinutes(time);
  const endMinutes = startMinutes + duration;

  if (endMinutes > 24 * 60) {
    return { error: 'Meeting cannot cross midnight.' };
  }

  return {
    date,
    time,
    duration,
    startMinutes,
    endMinutes,
  };
}

function hasOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && aEnd > bStart;
}

function handleApi(req, res) {
  const { method, url } = req;
  const pathname = url.split('?')[0];

  if (method === 'GET' && pathname === '/api/bookings') {
    const bookings = readBookings().sort((a, b) => {
      if (a.date === b.date) return a.startMinutes - b.startMinutes;
      return a.date.localeCompare(b.date);
    });
    sendJson(res, 200, { bookings });
    return;
  }

  if (method === 'POST' && pathname === '/api/bookings') {
    parseRequestBody(req)
      .then((body) => {
        const slot = parseAndValidateSlot(body);
        if (slot.error) {
          sendJson(res, 400, { error: slot.error });
          return;
        }

        const bookings = readBookings();
        const conflict = bookings.find(
          (existing) => existing.date === slot.date
            && hasOverlap(slot.startMinutes, slot.endMinutes, existing.startMinutes, existing.endMinutes),
        );

        if (conflict) {
          sendJson(res, 409, {
            error: 'Requested slot overlaps with an existing booking.',
            conflict,
          });
          return;
        }

        const booking = {
          id: randomUUID(),
          date: slot.date,
          time: slot.time,
          duration: slot.duration,
          startMinutes: slot.startMinutes,
          endMinutes: slot.endMinutes,
          createdAt: new Date().toISOString(),
        };

        bookings.push(booking);
        writeBookings(bookings);
        sendJson(res, 201, { booking });
      })
      .catch((error) => {
        const status = error.message === 'Payload too large' ? 413 : 400;
        sendJson(res, status, { error: error.message });
      });
    return;
  }

  if (method === 'DELETE' && pathname.startsWith('/api/bookings/')) {
    const bookingId = decodeURIComponent(pathname.replace('/api/bookings/', ''));
    const bookings = readBookings();
    const next = bookings.filter((item) => item.id !== bookingId);

    if (next.length === bookings.length) {
      sendJson(res, 404, { error: 'Booking not found.' });
      return;
    }

    writeBookings(next);
    sendJson(res, 200, { ok: true });
    return;
  }

  sendJson(res, 404, { error: 'Not found.' });
}

function serveStatic(req, res) {
  const requestPath = req.url.split('?')[0];
  const normalized = path.normalize(decodeURIComponent(requestPath === '/' ? 'index.html' : requestPath));
  const relativePath = normalized.replace(/^([/\\])+/, '');
  const filePath = path.resolve(ROOT_DIR, relativePath);

  if (!filePath.startsWith(path.resolve(ROOT_DIR))) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/')) {
    handleApi(req, res);
    return;
  }

  serveStatic(req, res);
});

server.listen(PORT, () => {
  ensureDataFile();
  console.log(`Meeting generator running at http://localhost:${PORT}`);
});
