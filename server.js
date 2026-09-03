// deploy: 1788290893920
require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');
const nodemailer = require('nodemailer');
const db = require('./db');

// === FIX: Boletos 102-108 revertir a pendiente (MP desconectado, no pagaron) ===
setTimeout(() => {
  try {
    [102,103,104,105,106,107,108].forEach(num => {
      const att = db.getAll().find(a => Number(a.ticket_number) === num && a.payment_status === 'pagado' && !a.mp_payment_id);
      if (att) {
        db.updateByCode(att.ticket_code, { payment_status: 'pendiente' });
        console.log('[FIX] Boleto', num, att.full_name, '→ pendiente');
      }
    });
  } catch(e) { console.error('[FIX]', e.message); }
}, 3000);


const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
    }
  }
}));

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const EVENT_NAME_DEFAULT = process.env.EVENT_NAME || 'Seminario Amway';
const PRECIO_DEFAULT = parseInt(process.env.PRECIO_BOLETO || '450', 10);

function getEventConfig() {
  const cfg = db.getConfig();
  return {
    eventName:        cfg.eventName        || EVENT_NAME_DEFAULT,
    eventDate:        cfg.eventDate        || '',
    precio:           cfg.precio           != null ? cfg.precio           : PRECIO_DEFAULT,
    early_bird_active: cfg.early_bird_active || false,
    early_bird_precio: cfg.early_bird_precio != null ? cfg.early_bird_precio : 400,
    comision_mp:      cfg.comision_mp      != null ? cfg.comision_mp      : 3.49,
    precio_paquete:   cfg.precio_paquete   != null ? cfg.precio_paquete   : 1400,
    flyer:            cfg.flyer            || null,
  };
}

function requireAdmin(req, res, next) {
  const pass = req.headers['x-admin-password'] || req.query.password;
  if (pass !== ADMIN_PASSWORD) return res.status(401).json({ error: 'No autorizado' });
  next();
}

function maxCheckins(att) {
  return att.early_bird ? 2 : 1;
}


const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, 'uploads');
const DOCS_DIR = path.join(UPLOADS_DIR, 'docs');
try { require('fs').mkdirSync(UPLOADS_DIR, {recursive:true}); require('fs').mkdirSync(DOCS_DIR, {recursive:true}); } catch(e){}

app.use('/uploads', express.static(UPLOADS_DIR));

const uploadFlyer = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => cb(null, 'flyer' + path.extname(file.originalname)),
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
});

const uploadDocs = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, DOCS_DIR),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname),
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
});

let mpClient = null;
if (process.env.MP_ACCESS_TOKEN && process.env.MP_ACCESS_TOKEN !== 'TU_ACCESS_TOKEN_AQUI') {
  mpClient = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });
}

// ---------- Email (Resend HTTP API) ----------
async function sendResendEmail({ to, subject, html }) {
  const scriptUrl = process.env.APPS_SCRIPT_URL;
  if (!scriptUrl) { console.log('[EMAIL] No APPS_SCRIPT_URL'); return null; }
  const payload = JSON.stringify({ to, subject, html, token: 'seminario2024secret' });
  const opts = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
    redirect: 'manual'
  };
  try {
    let r = await fetch(scriptUrl, opts);
    // Google Apps Script devuelve 302 — hay que seguirlo manualmente como POST
    if (r.status === 301 || r.status === 302 || r.status === 307 || r.status === 308) {
      const location = r.headers.get('location');
      console.log('[EMAIL] Siguiendo redirect a', location);
      r = await fetch(location, opts);
    }
    const text = await r.text();
    const d = JSON.parse(text);
    if (!d.ok) throw new Error(d.error || 'Script error');
    console.log('[EMAIL] Sent via Apps Script to', to);
    return d;
  } catch (err) {
    console.error('[EMAIL] Error:', err.message);
    return null;
  }
}
async function sendTicketEmail(att) {
  if (!att || !att.email) return;
  try {
    const qrDataUrl = await QRCode.toDataURL(att.ticket_code, { width: 280, margin: 1 });
    const b64 = qrDataUrl.replace(/^data:image\/png;base64,/, '');
    const evtName = EVENT_NAME_DEFAULT;
    const ticketUrl = BASE_URL + '/ticket.html?code=' + att.ticket_code;
    const num = att.ticket_number ? '#' + att.ticket_number : '';
    await sendResendEmail({
      to: att.email,
      subject: 'Tu boleto ' + num + ' para ' + evtName,
      html: '<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;border:1px solid #e0e0e0;border-radius:14px;"><h2 style="color:#1c3a6e;text-align:center;">' + evtName + '</h2><p style="text-align:center;color:#666;">¡Tu pago fue confirmado!</p><p>Hola <strong>' + att.full_name + '</strong>,</p><p>Aquí está tu código QR de acceso:</p><div style="text-align:center;margin:24px 0;"><img src="' + qrDataUrl + '" alt="QR" style="width:220px;height:220px;border:4px solid #1c3a6e;border-radius:12px;"></div>' + (att.ticket_number ? '<p style="text-align:center;font-weight:bold;color:#1c3a6e;">Boleto ' + num + '</p>' : '') + '<p style="text-align:center;"><a href="' + ticketUrl + '" style="background:#1c3a6e;color:#fff;padding:10px 24px;border-radius:8px;text-decoration:none;font-weight:bold;display:inline-block;">Ver mi boleto digital →</a></p><p style="color:#999;font-size:0.82rem;text-align:center;margin-top:20px;">Presenta este QR en la entrada del evento.</p></div>',
      attachments: [],
    });
    console.log('[EMAIL] Enviado a', att.email);
  } catch(err) { console.error('[EMAIL] Error:', err.message); }
}

async function sendPaqueteEmail(paqueteId) {
    try {
    const attendees = db.getByPaqueteId(paqueteId);
    if (!attendees.length) return;
    const buyerEmail = attendees.find(a => a.email)?.email;
    if (!buyerEmail) return;
    const evtName = EVENT_NAME_DEFAULT;
    let ticketRows = '';
    for (let i = 0; i < attendees.length; i++) {
      const att = attendees[i];
      const qrDataUrl = await QRCode.toDataURL(att.ticket_code, { width: 220, margin: 1 });
      const ticketUrl = BASE_URL + '/ticket.html?code=' + att.ticket_code;
      const num = att.ticket_number ? '#' + att.ticket_number : '';
      ticketRows += '<div style="border:1px solid #d8c5ff;border-radius:10px;padding:14px;margin-bottom:16px;text-align:center;">' +
        '<p style="margin:0 0 6px;font-weight:700;color:#7c3aed;">' + att.full_name + '</p>' +
        (att.ticket_number ? '<p style="margin:0 0 8px;color:#1c3a6e;font-weight:700;">Boleto ' + num + '</p>' : '') +
        '<img src="' + qrDataUrl + '" alt="QR" style="width:180px;height:180px;border:3px solid #7c3aed;border-radius:10px;display:block;margin:0 auto 10px;">' +
        '<a href="' + ticketUrl + '" style="background:#7c3aed;color:#fff;padding:8px 20px;border-radius:8px;text-decoration:none;font-weight:bold;font-size:0.9rem;">Ver boleto →</a></div>';
    }
    await sendResendEmail({
      to: buyerEmail,
      subject: 'Tus 4 boletos para ' + evtName + ' — Paquete Grupo',
      html: '<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;border:1px solid #e0e0e0;border-radius:14px;"><h2 style="color:#7c3aed;text-align:center;">' + evtName + '</h2><p style="text-align:center;color:#666;">¡Pago del Paquete Grupo confirmado!</p>' + ticketRows + '<p style="color:#999;font-size:0.82rem;text-align:center;margin-top:20px;">Guarda este correo — es el acceso de tu grupo al evento.</p></div>',
      attachments: [],
    });
    console.log('[EMAIL-PAQUETE] Enviado a', buyerEmail);
  } catch(err) { console.error('[EMAIL-PAQUETE] Error:', err.message); }
}

// ---------- Registro Paquete Grupo (4 boletos por $1400) ----------
app.post('/api/register', uploadDocs.fields([
  { name: 'comprobante', maxCount: 1 },
  { name: 'ine_photo',   maxCount: 1 },
  { name: 'ine_nuevo',   maxCount: 1 },
]), async (req, res) => {
  try {
    const {
      full_name, platino, esmeralda, diamante,
      ticket_type, auspicio_numero, fecha_auspicio, email,
    } = req.body;

    if (!full_name || !String(full_name).trim()) {
      return res.status(400).json({ error: 'Falta el nombre completo' });
    }

    const type = ticket_type || 'empresario';
    if (!['empresario', 'nuevo_empresario', 'invitado'].includes(type)) {
      return res.status(400).json({ error: 'Tipo de boleto inválido' });
    }

    const cfg = getEventConfig();
    const ticket_code = uuidv4();
    let amount = 0;
    let early_bird = false;
    let comprobante_image = null;
    let ine_image = null;
    const emailClean = email ? String(email).trim().toLowerCase() : null;

    // -- Validaciones y precio por tipo --
    if (type === 'nuevo_empresario') {
      if (!auspicio_numero || !String(auspicio_numero).trim()) {
        return res.status(400).json({ error: 'Falta el número de empresario' });
      }
      // Validar nombre completo (mínimo 2 palabras)
      if (full_name.trim().split(/\s+/).length < 2) {
        return res.status(400).json({ error: 'Por favor escribe tu nombre completo (nombre y apellido).' });
      }

      const registrosExistentes = db.getNuevoSociosPorNumero(auspicio_numero.trim());
      const nombreNorm = full_name.trim().toLowerCase().replace(/\s+/g, ' ');

      // Función para detectar si dos nombres son similares (uno contiene al otro)
      const nombresSimilares = (a, b) => {
        if (a === b) return true;
        if (a.includes(b) || b.includes(a)) return true;
        return false;
      };

      // Separar registros del mismo titular/cotitular vs otras personas
      const registrosMismaPersna = registrosExistentes.filter(r =>
        nombresSimilares(nombreNorm, (r.full_name || '').trim().toLowerCase().replace(/\s+/g, ' '))
      );
      const personasUnicas = [...new Set(
        registrosExistentes.map(r => (r.full_name || '').trim().toLowerCase().replace(/\s+/g, ' '))
      )].filter(n => !nombresSimilares(n, nombreNorm));

      // Regla 1: esta persona ya usó sus 2 eventos gratis
      if (registrosMismaPersna.length >= 2) {
        return res.status(400).json({ error: 'Ya usaste tus 2 eventos gratuitos como Nuevo Empresario. Debes comprar un boleto de Empresario.' });
      }

      // Regla 2: el número ya tiene 2 personas distintas y esta persona es una tercera
      if (personasUnicas.length >= 2 && registrosMismaPersna.length === 0) {
        return res.status(400).json({ error: 'Este número de empresario ya tiene registrados al titular y cotitular. No se permiten más registros gratuitos con este número.' });
      }
      if (!req.files || !req.files.comprobante) {
        return res.status(400).json({ error: 'Debes subir el comprobante de tu fecha de auspicio' });
      }
      comprobante_image = req.files.comprobante[0].filename;
      if (!req.files || !req.files.ine_nuevo) {
        return res.status(400).json({ error: 'Debes subir una foto de tu INE' });
      }
      ine_image = req.files.ine_nuevo[0].filename;
      amount = 0; // gratis
      if (cfg.early_bird_active) early_bird = true; // Ticket Holder si se registró durante el evento

    } else if (type === 'invitado') {
      const existing = db.getInvitadoByNombre(full_name.trim());
      if (existing) {
        return res.status(400).json({ error: 'Ya existe un registro de este invitado. Los invitados sólo pueden asistir gratuitamente una sola vez.' });
      }
      if (!req.files || !req.files.ine_photo) {
        return res.status(400).json({ error: 'Debes subir una foto de tu INE' });
      }
      ine_image = req.files.ine_photo[0].filename;
      amount = 0; // acceso gratuito
      if (cfg.early_bird_active) early_bird = true; // Ticket Holder si se registró durante el evento

    } else { // empresario
      if (cfg.early_bird_active) {
        amount = cfg.early_bird_precio;
        early_bird = true;
      } else {
        amount = cfg.precio;
      }
    }

    const record = {
      ticket_number: null,
      ticket_code,
      full_name: full_name.trim(),
      platino: (platino || '').trim(),
      esmeralda: (esmeralda || '').trim(),
      diamante: (diamante || '').trim(),
      ticket_type: type,
      auspicio_numero: auspicio_numero ? String(auspicio_numero).trim() : null,
      fecha_auspicio: fecha_auspicio || null,
      email: emailClean,
      comprobante_image,
      ine_image,
      amount,
      early_bird,
      payment_method: 'mercadopago',
      payment_status: 'pendiente',
      mp_preference_id: null,
      mp_payment_id: null,
      email_sent: false,
      checked_in: false,
      checked_in_count: 0,
      checked_in_at: null,
      created_at: new Date().toISOString(),
    };

    db.insertAttendee(record);

    // Gratis (nuevo_empresario): marcar pagado directo y asignar número
    if (amount === 0) {
      db.updateByCode(ticket_code, { payment_status: 'pagado', ticket_number: db.getNextTicketNumber() });
      sendTicketEmail(db.getByCode(ticket_code)).catch(() => {});
      return res.json({ demo: true, ticket_code, redirect: `/ticket.html?code=${ticket_code}` });
    }

    // Sin MP configurado: modo demo
    if (!mpClient) {
      db.updateByCode(ticket_code, { payment_status: 'pagado', ticket_number: db.getNextTicketNumber() });
      sendTicketEmail(db.getByCode(ticket_code)).catch(() => {});
      return res.json({ demo: true, ticket_code, redirect: `/ticket.html?code=${ticket_code}` });
    }

    const preference = new Preference(mpClient);
    const result = await preference.create({
      body: {
        items: [{ title: `${cfg.eventName} - Boleto`, quantity: 1, unit_price: amount, currency_id: 'MXN' }],
        payer: { name: full_name.trim() },
        external_reference: ticket_code,
        back_urls: {
          success: `${BASE_URL}/pago-resultado.html?code=${ticket_code}&status=success`,
          failure: `${BASE_URL}/pago-resultado.html?code=${ticket_code}&status=failure`,
          pending: `${BASE_URL}/pago-resultado.html?code=${ticket_code}&status=pending`,
        },
        auto_return: 'approved',
        notification_url: `${BASE_URL}/api/webhook/mercadopago`,
        payment_methods: {
          excluded_payment_types: [
            { id: 'ticket' },
            { id: 'bank_transfer' },
            { id: 'atm' },
          ],
        },
      },
    });

    db.updateByCode(ticket_code, { mp_preference_id: result.id });
    res.json({ ticket_code, init_point: result.init_point, sandbox_init_point: result.sandbox_init_point });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al crear el registro' });
  }
});

// ---------- Registro Paquete Grupo (4 boletos por $1400) ----------

app.post('/api/register-paquete', async (req, res) => {
  try {
    const { personas, email } = req.body;
    const emailClean = email ? String(email).trim().toLowerCase() : null;
    if (!Array.isArray(personas) || personas.length !== 4) {
      return res.status(400).json({ error: 'Se requieren exactamente 4 personas' });
    }
    for (let i = 0; i < 4; i++) {
      const p = personas[i];
      if (!p.full_name || p.full_name.trim().split(/\s+/).length < 2) {
        return res.status(400).json({ error: `Persona ${i + 1}: escribe nombre y apellido` });
      }
      if (!p.platino || !p.esmeralda || !p.diamante) {
        return res.status(400).json({ error: `Persona ${i + 1}: faltan datos de línea` });
      }
    }

    const cfg = getEventConfig();
    const paquete_id = uuidv4();
    const PRECIO_PAQUETE = cfg.precio_paquete;
    const early_bird = cfg.early_bird_active || false;
    const ticket_codes = [];

    for (const p of personas) {
      const ticket_code = uuidv4();
      db.insertAttendee({
        ticket_number: null,
        ticket_code,
        full_name: p.full_name.trim(),
        platino: p.platino.trim(),
        esmeralda: p.esmeralda.trim(),
        diamante: p.diamante.trim(),
        ticket_type: 'empresario',
        paquete_id,
        email: emailClean || '',
        auspicio_numero: null,
        fecha_auspicio: null,
        comprobante_image: null,
        ine_image: null,
        amount: Math.round(PRECIO_PAQUETE / 4),
        early_bird,
        payment_method: 'mercadopago',
        payment_status: 'pendiente',
        mp_preference_id: null,
        mp_payment_id: null,
        checked_in: false,
        checked_in_count: 0,
        checked_in_at: null,
        email: emailClean,
        email_sent: false,
        created_at: new Date().toISOString(),
      });
      ticket_codes.push(ticket_code);
    }

    // Modo demo (sin MP configurado)
    if (!mpClient) {
      for (const code of ticket_codes) {
        db.updateByCode(code, { payment_status: 'pagado', ticket_number: db.getNextTicketNumber() });
      }
      sendPaqueteEmail(paquete_id).catch(() => {});
      return res.json({ demo: true, paquete_id, redirect: `/paquete.html?id=${paquete_id}` });
    }

    // Pago único de $1400 via Mercado Pago
    const preference = new Preference(mpClient);
    const result = await preference.create({
      body: {
        items: [{ title: `${cfg.eventName} — Paquete Grupo (4 boletos)`, quantity: 1, unit_price: PRECIO_PAQUETE, currency_id: 'MXN' }],
        payer: { name: personas[0].full_name.trim() },
        external_reference: `paquete:${paquete_id}`,
        back_urls: {
          success: `${BASE_URL}/paquete.html?id=${paquete_id}&status=success`,
          failure: `${BASE_URL}/paquete.html?id=${paquete_id}&status=failure`,
          pending: `${BASE_URL}/paquete.html?id=${paquete_id}&status=pending`,
        },
        auto_return: 'approved',
        notification_url: `${BASE_URL}/api/webhook/mercadopago`,
        payment_methods: {
          excluded_payment_types: [
            { id: 'ticket' },
            { id: 'bank_transfer' },
            { id: 'atm' },
          ],
        },
      },
    });

    ticket_codes.forEach(code => db.updateByCode(code, { mp_preference_id: result.id }));
    res.json({ paquete_id, init_point: result.init_point });

  } catch (err) {
    console.error('[REGISTER-PAQUETE]', err);
    res.status(500).json({ error: 'Error al crear el paquete' });
  }
});

// ---------- Consultar paquete grupo ----------
app.get('/api/config', (req, res) => {
  const cfg = getEventConfig();
  res.json({
    eventName:         cfg.eventName,
    eventDate:         cfg.eventDate,
    precio:            cfg.early_bird_active ? cfg.early_bird_precio : cfg.precio,
    precio_normal:     cfg.precio,
    precio_paquete:    cfg.precio_paquete,
    early_bird_active: cfg.early_bird_active,
    early_bird_precio: cfg.early_bird_precio,
    flyer:             cfg.flyer ? `/uploads/${cfg.flyer}` : null,
    mpEnabled:         !!mpClient,
  });
});

app.get('/api/paquete/:id', async (req, res) => {
  const attendees = db.getByPaqueteId(req.params.id);
  if (!attendees.length) return res.status(404).json({ error: 'Paquete no encontrado' });
  const cfg = getEventConfig();
  const withQR = await Promise.all(attendees.map(async att => {
    let qr = null;
    if (att.payment_status === 'pagado') {
      qr = await QRCode.toDataURL(att.ticket_code, { width: 200, margin: 1 });
    }
    return { ...att, qr };
  }));
  res.json({ attendees: withQR, eventName: cfg.eventName, eventDate: cfg.eventDate });
});

// ---------- Webhook Mercado Pago ----------
app.post('/api/webhook/mercadopago', async (req, res) => {
  try {
    const topic = req.query.topic || req.query.type || req.body.type;
    const id = req.query['data.id'] || (req.body.data && req.body.data.id);
    if (topic === 'payment' && id && mpClient) {
      const payment = new Payment(mpClient);
      const info = await payment.get({ id });
      if (info.external_reference && info.status === 'approved') {
        const ref = info.external_reference;
        if (ref.startsWith('paquete:')) {
          const paqId = ref.replace('paquete:', '');
          const paqAttendees = db.getByPaqueteId(paqId);
          for (const att of paqAttendees) {
            const updates = { payment_status: 'pagado', mp_payment_id: String(info.id) };
            if (!att.ticket_number) updates.ticket_number = db.getNextTicketNumber();
            db.updateByCode(att.ticket_code, updates);
          }
          sendPaqueteEmail(paqId).catch(() => {});
        } else {
          const existing = db.getByCode(ref);
          const updates = { payment_status: 'pagado', mp_payment_id: String(info.id) };
          if (existing && !existing.ticket_number) updates.ticket_number = db.getNextTicketNumber();
          db.updateByCode(ref, updates);
          if (existing && !existing.email_sent) {
            db.updateByCode(ref, { email_sent: true });
            sendTicketEmail(db.getByCode(ref)).catch(() => {});
          }
        }
      }
    }
    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.sendStatus(200);
  }
});

// ---------- Consultar boleto ----------
app.get('/api/ticket/:code', async (req, res) => {
  const att = db.getByCode(req.params.code);
  if (!att) return res.status(404).json({ error: 'Boleto no encontrado' });

  if (att.payment_status === 'pendiente' && mpClient) {
    try {
      const payment = new Payment(mpClient);
      const search = await payment.search({ options: { external_reference: att.ticket_code, sort: 'date_created', criteria: 'desc' } });
      const approved = (search.results || []).find(p => p.status === 'approved');
      if (approved) {
        const updates = { payment_status: 'pagado', mp_payment_id: String(approved.id) };
        if (!att.ticket_number) updates.ticket_number = db.getNextTicketNumber();
        db.updateByCode(att.ticket_code, updates);
        att.payment_status = 'pagado';
        if (!att.email_sent) {
          db.updateByCode(att.ticket_code, { email_sent: true });
          sendTicketEmail(db.getByCode(att.ticket_code)).catch(() => {});
        }
        if (!att.ticket_number) att.ticket_number = updates.ticket_number;
      }
    } catch (e) { /* ignora */ }
  }

  let qr = null;
  if (att.payment_status === 'pagado') {
    qr = await QRCode.toDataURL(att.ticket_code, { width: 280, margin: 1 });
  }

  const cfg = getEventConfig();
  res.json({
    full_name: att.full_name,
    platino: att.platino,
    esmeralda: att.esmeralda,
    diamante: att.diamante,
    ticket_type: att.ticket_type || 'empresario',
    auspicio_numero: att.auspicio_numero,
    fecha_auspicio: att.fecha_auspicio,
    amount: att.amount,
    early_bird: att.early_bird || false,
    payment_status: att.payment_status,
    checked_in: !!att.checked_in,
    checked_in_count: att.checked_in_count || 0,
    checked_in_at: att.checked_in_at,
    ticket_number: att.ticket_number || null,
    ticket_code: att.ticket_code,
    qr,
    eventName: cfg.eventName,
    eventDate: cfg.eventDate,
    max_checkins: maxCheckins(att),
  });
});

// ---------- ADMIN: lista de asistentes ----------
app.get('/api/admin/attendees', (req, res) => {
  res.json(db.getAll().filter(a => a.payment_status === 'pagado'));
});

// ---------- ADMIN: búsqueda por nombre ----------
app.get('/api/admin/search', (req, res) => {
  const q = req.query.q || '';
  if (q.trim().length < 2) return res.json([]);
  res.json(db.searchByName(q).filter(a => a.payment_status === 'pagado'));
});

// ---------- ADMIN: configuración ----------
app.get('/api/admin/config', (req, res) => {
  res.json(getEventConfig());
});

app.post('/api/admin/config', uploadFlyer.single('flyer'), (req, res) => {
  try {
    const fields = {};
    if (req.body.eventName?.trim())  fields.eventName  = req.body.eventName.trim();
    if (req.body.eventDate != null)  fields.eventDate  = String(req.body.eventDate).trim();
    if (req.body.precio?.trim())     fields.precio     = parseInt(req.body.precio, 10) || PRECIO_DEFAULT;
    if (req.body.early_bird_precio?.trim()) fields.early_bird_precio = parseInt(req.body.early_bird_precio, 10) || 400;
    if (req.body.early_bird_active != null) fields.early_bird_active = req.body.early_bird_active === 'true' || req.body.early_bird_active === true;
    if (req.body.comision_mp?.trim()) fields.comision_mp = parseFloat(req.body.comision_mp) || 3.49;
    if (req.body.precio_paquete?.trim()) fields.precio_paquete = parseInt(req.body.precio_paquete, 10) || 1400;
    if (req.file) fields.flyer = req.file.filename;
    db.setConfig(fields);
    res.json({ ok: true, config: getEventConfig() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'No se pudo guardar la configuración' });
  }
});
// ---------- ADMIN: reiniciar evento ----------
app.post('/api/admin/reset', (req, res) => {
  try {
    const cfg = getEventConfig();
    const archivo = db.archiveAndReset(cfg.eventName);
    res.json({ ok: true, archivo });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'No se pudo reiniciar el evento' });
  }
});

// ---------- ADMIN: archivos anteriores ----------
app.get('/api/admin/archivos', (req, res) => {
  res.json(db.listArchives());
});

// ---------- ADMIN: exportar CSV ----------
app.get('/api/admin/export', (req, res) => {
  let attendees;
  let nombreArchivo = 'reporte';
  if (req.query.archivo) {
    const archivo = db.getArchive(req.query.archivo);
    if (!archivo) return res.status(404).json({ error: 'Archivo no encontrado' });
    attendees = archivo.attendees.filter(a => a.payment_status === 'pagado');
    nombreArchivo = req.query.archivo.replace(/\.json$/, '');
  } else {
    attendees = db.getAll().filter(a => a.payment_status === 'pagado');
  }

  const cfg = getEventConfig();
  // Comisión real MP: (monto × 3.49% + $4 fijo) × 1.16 IVA
  // Para paquetes el cargo fijo aplica una sola vez al total de 4 personas
  const calcComisionMP = (a) => {
    const m = a.amount || 0;
    if (m === 0 || a.payment_status !== 'pagado') return 0;
    if (a.paquete_id) return ((m * 4 * 0.0349 + 4) * 1.16) / 4;
    return (m * 0.0349 + 4) * 1.16;
  };

  const headers = [
    'N° Boleto', 'Nombre completo', 'Tipo de boleto', 'Platino', 'Esmeralda', 'Diamante',
    'N° Empresario', 'Fecha auspicio', 'Early Bird', 'Monto cobrado',
    'Comisión MP estimada', 'Ingreso neto', 'Estado de pago',
    'Entró', 'Veces escaneado', 'Fecha/hora de entrada', 'TH Escaneado', 'Fecha TH', 'Registrado', 'Link Boleto'
  ];

  const tipoLabel = { empresario: 'Empresario', nuevo_empresario: 'Nuevo Empresario', invitado: 'Invitado' };

  const fmtDate = iso => {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleString('es-MX', {
        timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit',
        day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true,
      });
    } catch(e) { return iso; }
  };

  // Ordenar por fecha de registro (ascendente) para que el número sea cronológico
  const attendeesSorted = [...attendees].sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
  const rows = attendeesSorted.map((a, i) => {
    const monto = a.amount || 0;
    const comisionMonto = calcComisionMP(a).toFixed(2);
    const neto = monto > 0 && a.payment_status === 'pagado' ? (monto - calcComisionMP(a)).toFixed(2) : '0.00';
    return [
      a.ticket_number || (i + 1),
      a.full_name || '',
      tipoLabel[a.ticket_type] || a.ticket_type || 'Empresario',
      a.platino || '', a.esmeralda || '', a.diamante || '',
      a.auspicio_numero || '',
      a.fecha_auspicio || '',
      a.early_bird ? 'Sí' : 'No',
      `$${monto}`,
      `$${comisionMonto}`,
      `$${neto}`,
      a.payment_status || '',
      a.checked_in ? 'Sí' : 'No',
      (a.checked_in_count || 0) + (a.th_scanned ? 1 : 0),
      a.checked_in_at || '',
      a.th_scanned ? 'Sí' : 'No',
      a.th_scanned_at || '',
      fmtDate(a.created_at),
      `${BASE_URL}/ticket.html?code=${a.ticket_code}`,
    ];
  });

  // Totales al final
  const totalCobrado = attendees.filter(a => a.payment_status === 'pagado').reduce((s, a) => s + (a.amount || 0), 0);
  const pagadosLista = attendees.filter(a => a.payment_status === 'pagado');
  const totalComisionNum = pagadosLista.reduce((s, a) => s + calcComisionMP(a), 0);
  const totalComision = totalComisionNum.toFixed(2);
  const totalNeto = (totalCobrado - totalComisionNum).toFixed(2);
  rows.push([]);
  rows.push(['TOTALES', '', '', '', '', '', '', '', '', `$${totalCobrado}`, `$${totalComision}`, `$${totalNeto}`]);

  const csvEscape = val => {
    const s = String(val == null ? '' : val);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };

  const csv = [headers, ...rows].map(r => r.map(csvEscape).join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${nombreArchivo}.csv"`);
  res.send('﻿' + csv);
});

// ---------- CHECK-IN (escáner de puerta) ----------
// modo: 'ticket_holder' = registro previo (solo early bird) | 'evento' = día del seminario (default)
// TH y evento son conteos INDEPENDIENTES para que no se interfieran.
// Endpoint público de búsqueda para escáneres (sin datos sensibles)
app.get('/api/scanner/search', (req, res) => {
  const q = req.query.q || '';
  if (q.trim().length < 2) return res.json([]);
  const data = db.searchByName(q);
  res.json(data.map(r => ({
    ticket_code: r.ticket_code,
    full_name: r.full_name,
    ticket_type: r.ticket_type,
    early_bird: r.early_bird,
    payment_status: r.payment_status,
    th_scanned: r.th_scanned,
  })));
});

app.post('/api/checkin', (req, res) => {
  const { ticket_code, modo } = req.body;
  console.log('[CHECKIN] modo recibido:', JSON.stringify(modo), '| code:', ticket_code);
  if (!ticket_code) return res.status(400).json({ error: 'Código de boleto requerido' });

  const att = db.getByCode(ticket_code);
  if (!att) return res.status(404).json({ ok: false, reason: 'no_encontrado', message: 'Boleto no encontrado' });
  if (att.payment_status !== 'pagado') return res.json({ ok: false, reason: 'no_pagado', message: 'Boleto no pagado', attendee: att });

  const ts = () => new Date().toLocaleString('es-MX', {
    timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true,
  });

  // ---- Modo Ticket Holder (conteo SEPARADO del evento) ----
  if (modo === 'ticket_holder') {
    if (!att.early_bird) {
      return res.json({ ok: false, reason: 'no_aplica_th', message: 'Este boleto no aplica Ticket Holder (no es Early Bird)', attendee: enrichAttendee(att) });
    }
    if (att.th_scanned) {
      return res.json({ ok: false, reason: 'ya_escaneado_th', message: 'Este Ticket Holder ya fue registrado', attendee: enrichAttendee(att) });
    }
    // Registrar TH — NO toca checked_in_count del evento
    const updated = db.updateByCode(ticket_code, { th_scanned: true, th_scanned_at: ts() });
    return res.json({ ok: true, message: 'Ticket Holder registrado ✔', attendee: enrichAttendee(updated) });
  }

  // ---- Modo Evento (día del seminario) — independiente del TH ----
  const count = att.checked_in_count || 0;
  if (count >= 1) {
    return res.json({ ok: false, reason: 'ya_usado', message: 'Este boleto ya fue usado el día del evento', attendee: enrichAttendee(att) });
  }
  const updated = db.updateByCode(ticket_code, {
    checked_in: true,
    checked_in_count: 1,
    checked_in_at: ts(),
  });
  res.json({ ok: true, message: 'Acceso permitido ✔', attendee: enrichAttendee(updated) });
});

// Agrega URLs de imágenes al objeto de asistente
function enrichAttendee(att) {
  return {
    ...att,
    comprobante_url: att.comprobante_image ? `/uploads/docs/${att.comprobante_image}` : null,
    ine_url:         att.ine_image         ? `/uploads/docs/${att.ine_image}`         : null,
    nuevo_socio_total: att.ticket_type === 'nuevo_empresario'
      ? db.countNuevoSocioRegistros(att.auspicio_numero)
      : null,
  };
}





// ---------- ADMIN: cancelar boletos por n�mero (revertir a pendiente) ----------
app.post('/api/admin/cancel-tickets', requireAdmin, (req, res) => {
  const { ticket_numbers } = req.body;
  if (!Array.isArray(ticket_numbers) || ticket_numbers.length === 0) {
    return res.status(400).json({ error: 'Falta ticket_numbers (array)' });
  }
  const all = db.getAll();
  const results = [];
  for (const num of ticket_numbers) {
    const att = all.find(a => Number(a.ticket_number) === Number(num));
    if (!att) { results.push({ ticket_number: num, ok: false, error: 'no encontrado' }); continue; }
    db.updateByCode(att.ticket_code, { payment_status: 'pendiente' });
    results.push({ ticket_number: num, ok: true, full_name: att.full_name });
  }
  res.json({ results });
});

app.listen(PORT, () => {
  console.log(`Servidor corriendo en ${BASE_URL} (puerto ${PORT})`);
});
