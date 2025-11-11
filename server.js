const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const basicAuth = require('express-basic-auth');

const app = express();

// Cartella di upload
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Static assets e body parsing
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));

// (rimosso) /logout

// (rimosso) /unblock

// Configurazione Multer con salvataggio su disco e filtro estensioni
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const base = path.basename(file.originalname, ext);
    const safeBase = base.replace(/[^a-zA-Z0-9_.-]/g, '_');
    const target = safeBase + ext;
    // Sovrascrive il file esistente mantenendo lo stesso nome
    cb(null, target);
  }
});

const upload = multer({
  storage,
  limits: { files: 10000 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === '.txt' || ext === '.log') cb(null, true);
    else cb(new Error('Sono consentiti solo file .txt o .log'));
  }
});

// Autenticazione area admin (Basic Auth) semplice
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
app.use('/admin', basicAuth({ users: { admin: ADMIN_PASSWORD }, challenge: true }));

// (rimosso) Logout Basic Auth

// Utility: lista dei file disponibili
function listFiles() {
  if (!fs.existsSync(uploadsDir)) return [];
  return fs
    .readdirSync(uploadsDir)
    .filter(f => ['.txt', '.log'].includes(path.extname(f).toLowerCase()))
    .sort((a, b) => a.localeCompare(b));
}

// Parser per la sezione: sdir_board_sfp_metriche
// Parser per la sezione: sdir_link_performance_wl
const LINK_PERF_HEADER_RE = /^ID\s*;\s*LINK\s*;\s*RiL\s*;\s*WL1\s*;\s*TEMP1\s*;\s*TXbs1\s*;\s*TXdBm1\s*;\s*RXdBm1\s*;\s*BER1\s*;\s*WL2\s*;\s*TEMP2\s*;\s*TXbs2\s*;\s*TXdBm2\s*;\s*RXdBm2\s*;\s*BER2\s*;\s*DlLoss\s*;\s*UlLoss\s*;\s*LENGTH\s*;\s*TT\s*$/i;
const LINK_PERF_STOP_HEADERS = [
  /^ID\s*;\s*T\s*;\s*RiL/i,
  /^ID\s*;\s*LINK\s*;\s*RiL\s*;\s*VENDOR1/i,
  /^ID\s*;\s*RiL\s*;\s*BOARD\s*;\s*SFPLNH/i,
  /^BOARD\s*;\s*LNH\s*;\s*PORT/i,
  /^Prio\s*;\s*ST\s*;\s*syncRefType/i,
  /^AntennaNearUnit/i,
  /^XPBOARD\s*;\s*ST/i
];

function parseSdirLinkPerformanceWlFromContent(content) {
  const lines = content.split(/\r?\n/);
  const rows = [];
  let inSection = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (!inSection) {
      if (LINK_PERF_HEADER_RE.test(line)) {
        inSection = true;
      }
      continue;
    }
    if (LINK_PERF_STOP_HEADERS.some(re => re.test(line))) {
      inSection = false;
      continue;
    }
    if (!line.includes(';')) continue;
    // Allineamento stile BOARD: split semplice, gestione di eventuale primo campo vuoto e extra colonne
    let parts = line.split(';').map(p => p.trim());
    // Se la riga presenta un separatore iniziale, rimuovi il primo campo vuoto
    if (parts.length && parts[0] === '') {
      parts.shift();
    }
    // Correzione robusta: alcune righe hanno LINK vuoto subito dopo ID oppure RiL contiene lo stato (Up/Down/Dn).
    // In entrambi i casi, significa che LINK è slittato a destra: rimuoviamo UNA SOLA volta la colonna 1.
    if (parts.length >= 19 && (parts[1] === '' || /^(up|down|dn)$/i.test(parts[2]))) {
      parts.splice(1, 1);
    }
    // Se ci sono più di 19 campi, aggrega gli extra nell'ultimo (TT)
    if (parts.length > 19) {
      parts = parts.slice(0, 18).concat([parts.slice(18).join(';')]);
    }
    // Padding per garantire esattamente 19 colonne
    if (parts.length < 19) {
      parts = parts.concat(Array(19 - parts.length).fill(''));
    }
    if (parts.length >= 19) {
      const [ID, LINK, RiL, WL1, TEMP1, TXbs1, TXdBm1, RXdBm1, BER1, WL2, TEMP2, TXbs2, TXdBm2, RXdBm2, BER2, DlLoss, UlLoss, LENGTH, TT] = parts.slice(0, 19);
      // Parsing numerico di DlLoss e UlLoss per soglia -3.50
      const dlLossValue = parseFloat(String(DlLoss).replace(',', '.'));
      const ulLossValue = parseFloat(String(UlLoss).replace(',', '.'));
      const lowLoss = ((!Number.isNaN(dlLossValue) && dlLossValue < -3.5) || (!Number.isNaN(ulLossValue) && ulLossValue < -3.5));
      rows.push({ ID, LINK, RiL, WL1, TEMP1, TXbs1, TXdBm1, RXdBm1, BER1, WL2, TEMP2, TXbs2, TXdBm2, RXdBm2, BER2, DlLoss, UlLoss, LENGTH, TT, dlLossValue, ulLossValue, lowLoss });
    }
  }
  return rows;
}

function parseSdirLinkPerformanceWlFromFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return parseSdirLinkPerformanceWlFromContent(content);
  } catch (e) {
    return [];
  }
}

function aggregateLinkPerformanceWl() {
  const files = listFiles();
  const all = [];
  files.forEach(f => {
    const fileRows = parseSdirLinkPerformanceWlFromFile(path.join(uploadsDir, f));
    fileRows.forEach(r => all.push({ ...r, source: f }));
  });
  return all;
}

// Parser per la sezione: sdir_board_sfp_metriche (ripristino)
const BOARD_SFP_HEADER_RE = /^ID\s*;\s*RiL\s*;\s*BOARD\s*;\s*SFPLNH\s*;\s*PORT\s*;\s*VENDOR\s*;\s*VENDORPROD\s*;\s*REV\s*;\s*SERIAL\s*;\s*DATE\s*;\s*ERICSSONPROD\s*;\s*WL\s*;\s*TEMP\s*;\s*TXbs\s*;\s*TXdBm\s*;\s*RXdBm\s*;\s*BER\s*$/i;
const BOARD_SFP_STOP_HEADERS = [
  /^ID\s*;\s*T\s*;\s*RiL/i,
  /^ID\s*;\s*LINK\s*;\s*RiL/i,
  /^BOARD\s*;\s*LNH\s*;\s*PORT/i,
  /^Prio\s*;\s*ST\s*;\s*syncRefType/i,
  /^AntennaNearUnit/i,
  /^XPBOARD\s*;\s*ST/i
];

function parseSdirBoardSfpMetricsFromContent(content) {
  const lines = content.split(/\r?\n/);
  const rows = [];
  let inSection = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (!inSection) {
      if (BOARD_SFP_HEADER_RE.test(line)) {
        inSection = true;
      }
      continue;
    }
    if (BOARD_SFP_STOP_HEADERS.some(re => re.test(line))) {
      inSection = false;
      continue;
    }
    if (!line.includes(';')) continue;
    const parts = line.split(';').map(p => p.trim());
    if (parts.length >= 17) {
      const [ID, RiL, BOARD, SFPLNH, PORT, VENDOR, VENDORPROD, REV, SERIAL, DATE, ERICSSONPROD, WL, TEMP, TXbs, TXdBm, RXdBm, BER] = parts;
      rows.push({ ID, RiL, BOARD, SFPLNH, PORT, VENDOR, VENDORPROD, REV, SERIAL, DATE, ERICSSONPROD, WL, TEMP, TXbs, TXdBm, RXdBm, BER });
    }
  }
  return rows;
}

function parseSdirBoardSfpMetricsFromFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return parseSdirBoardSfpMetricsFromContent(content);
  } catch (e) {
    return [];
  }
}

function aggregateBoardSfpMetrics() {
  const files = listFiles();
  const all = [];
  files.forEach(f => {
    const fileRows = parseSdirBoardSfpMetricsFromFile(path.join(uploadsDir, f));
    fileRows.forEach(r => all.push({ ...r, source: f }));
  });
  return all;
}

// Parser per la sezione: sdir_fru_radio_metriche
const FRU_RADIO_HEADER_RE = /^FRU\s*;\s*LNH\s*;\s*BOARD\s*;\s*RF\s*;\s*BP\s*;\s*TX\s*\(W\/dBm\)\s*;\s*VSWR\s*\(RL\)\s*;\s*RX\s*\(dBm\)\s*;\s*UEs\/gUEs\s*;\s*Sector\/AntennaGroup\/Cells\s*\(State:CellIds:PCIs\)\s*$/i;
const FRU_RADIO_STOP_HEADERS = [
  /^CELL\s+SC\s+FRU\s+BOARD/i,
  /^ID\s*;\s*LINK\s*;\s*RiL/i,
  /^ID\s*;\s*RiL\s*;\s*BOARD/i,
  /^BOARD\s*;\s*LNH\s*;\s*PORT/i
];

function parseSdirFruRadioMetricheFromContent(content) {
  const lines = content.split(/\r?\n/);
  const rows = [];
  let inSection = false;
  // Split limitato: massimo 10 colonne (9 separatori ';'), tutto l'extra resta nell'ultima
  const splitSemicolonsLimited = (s, maxParts) => {
    const out = [];
    let curr = '';
    let partsCount = 0;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === ';' && partsCount < maxParts - 1) {
        out.push(curr.trim());
        curr = '';
        partsCount++;
      } else {
        curr += ch;
      }
    }
    out.push(curr.trim());
    return out;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (!inSection) {
      if (FRU_RADIO_HEADER_RE.test(line)) {
        inSection = true;
      }
      continue;
    }
    // Se incontriamo separatori di sezione, ignoriamoli e proseguiamo
    if (/^={3,}$/.test(line) || /^-{3,}$/.test(line)) {
      continue;
    }
    if (FRU_RADIO_STOP_HEADERS.some(re => re.test(line))) {
      inSection = false;
      continue;
    }
    if (!line.includes(';')) continue;
    // Usa split limitato per garantire l’ancoraggio delle ultime colonne
    let parts = splitSemicolonsLimited(line, 10);
    // Rimuovi eventuali colonne vuote all’inizio che causano shift a destra
    while (parts.length && parts[0] === '') {
      parts.shift();
    }
    // Padding per garantire 10 colonne anche se alcune sono vuote
    if (parts.length < 10) {
      parts = parts.concat(Array(10 - parts.length).fill(''));
    }
    const [FRU, LNH, BOARD, RF, BP, TX, VSWR, RX, UEs_gUEs, SectorCells] = parts;
    // Estrai valore numerico VSWR (prima della parentesi) e RL (dentro la parentesi), se presenti
    let vswrValue = NaN;
    let rlValue = NaN;
    if (VSWR) {
      const mVswr = VSWR.match(/^\s*([+-]?[0-9]*\.?[0-9]+)/);
      if (mVswr) vswrValue = parseFloat(mVswr[1]);
      const mRl = VSWR.match(/\(([^)]+)\)/);
      if (mRl) {
        const mRlNum = String(mRl[1]).match(/([+-]?[0-9]*\.?[0-9]+)/);
        if (mRlNum) rlValue = parseFloat(mRlNum[1]);
      }
    }
    const highVSWR = !isNaN(vswrValue) && vswrValue > 1.5;
    rows.push({ FRU, LNH, BOARD, RF, BP, TX, VSWR, RX, UEs_gUEs, SectorCells, vswrValue, rlValue, highVSWR });
  }
  return rows;
}

function parseSdirFruRadioMetricheFromFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return parseSdirFruRadioMetricheFromContent(content);
  } catch (e) {
    return [];
  }
}

function aggregateFruRadioMetriche() {
  const files = listFiles();
  const all = [];
  files.forEach(f => {
    const fileRows = parseSdirFruRadioMetricheFromFile(path.join(uploadsDir, f));
    fileRows.forEach(r => all.push({ ...r, source: f }));
  });
  return all;
}

// Parser per la sezione: mfitr (CELL, SC, FRU, BOARD, PUSCH, PUCCH, A, B, [C], [D], DELTA)
function parseMfitrFromContent(content) {
  const lines = content.split(/\r?\n/);
  const rows = [];
  let inSection = false;
  const isHeader = (s) => /\bCELL\b/i.test(s) && /\bSC\b/i.test(s) && /\bFRU\b/i.test(s) && /\bBOARD\b/i.test(s) && /\bPUSCH\b/i.test(s) && /\bPUCCH\b/i.test(s) && /\bDELTA\b/i.test(s);
  // Non considerare i separatori come fine sezione; solo marker di fine blocco
  const stopRes = [/^Bye\b/i, /^Output has been logged/i, /^CS\w+>\s+\w+/i];
  for (let raw of lines) {
    const line = raw.trimEnd();
    if (!inSection) { if (isHeader(line)) { inSection = true; continue; } else { continue; } }
    const t = line.trim();
    if (!t) continue;
    if (/^={3,}$/.test(t) || /^-{3,}$/.test(t)) continue; // ignora separatori
    if (stopRes.some(re => re.test(t))) { inSection = false; continue; }
    const tokens = t.split(/\s+/).filter(Boolean);
    if (tokens.length < 9) continue;
    const CELL = tokens[0];
    const SC = tokens[1];
    const FRU = tokens[2];
    const BOARD = tokens[3];
    const PUSCH = tokens[4];
    const PUCCH = tokens[5];
    const rest = tokens.slice(6);
    const DELTA = rest[rest.length - 1] || '';
    const numeric = rest.slice(0, rest.length - 1);
    const A = numeric[0] || '';
    const B = numeric[1] || '';
    const C = numeric[2] || '';
    const D = numeric[3] || '';
    rows.push({ CELL, SC, FRU, BOARD, PUSCH, PUCCH, A, B, C, D, DELTA });
  }
  return rows;
}

function parseMfitrFromFile(filePath) {
  try { const content = fs.readFileSync(filePath, 'utf8'); return parseMfitrFromContent(content); }
  catch (e) { return []; }
}

function aggregateMfitr() {
  const files = listFiles();
  const all = [];
  files.forEach(f => {
    const fileRows = parseMfitrFromFile(path.join(uploadsDir, f));
    fileRows.forEach(r => all.push({ ...r, source: f }));
  });
  return all;
}

// Parser per la sezione: mfar (senza separatori ';', colonne separate da spazi multipli)
function parseMfarFromContent(content) {
  const lines = content.split(/\r?\n/);
  const rows = [];
  let inSection = false;
  let rowBuf = '';
  // Riconoscimento header più flessibile (variazioni di spazi e parole)
  const isHeader = (s) => /SC\s+SE\s+Tx\/Rx/i.test(s)
    && /RfPort1\s*-\s*RfPort2/i.test(s)
    && /(Cell\s*\(State\))/i.test(s)
    && /Samples/i.test(s)
    && /Med/i.test(s)
    && /Mean/i.test(s)
    && /SDev/i.test(s)
    && /Pol/i.test(s)
    && /Res/i.test(s)
    && /Issue/i.test(s);
  const stopRes = [
    /^Total:/i,
    /^ID\s*;\s*LINK\s*;\s*RiL/i,
    /^FRU\s*;\s*LNH/i,
    /^CELL\s+SC\s+FRU\s+BOARD/i
  ];
  for (let raw of lines) {
    const line = raw.trimEnd();
    if (!inSection) {
      if (isHeader(line)) {
        inSection = true;
        try { console.log('[MFAR] Header rilevato'); } catch {}
        rowBuf = '';
      }
      continue;
    }
    const t = line.trim();
    if (!t) continue; // ignora righe vuote
    if (/^=+/.test(t) || /^-+/.test(t)) continue; // ignora separatori
    // Quando incontriamo uno stop, chiudiamo la sezione ma continuiamo a cercare eventuali altre sezioni MFAR
    if (stopRes.some(re => re.test(t))) { inSection = false; rowBuf = ''; continue; }

    // Gestione righe spezzate: accumula fino a trovare "Passed"/"Failed"
    const rowStart = /^\s*\d+\/\d+\s+\d+/; // es: "2/4 0"
    if (rowStart.test(line)) {
      // Se c'è un buffer precedente non finalizzato, proviamo a chiuderlo
      if (rowBuf.trim()) {
        const mPrev = rowBuf.match(/^\s*(\S+)\s+(\S+)\s{2,}(.*)$/);
        if (mPrev) {
          const scp = mPrev[1];
          const sep = mPrev[2];
          const tailp = mPrev[3];
          const partsp = tailp.split(/\s{2,}/).map(p => p.trim()).filter(Boolean);
          if (partsp.length >= 12) {
            const [txrx, brPair, rfPorts1, rfPorts2, hw, serial, cellState, samples, med, mean, sdev, pol, res, ...issueParts] = partsp;
            const issue = (issueParts && issueParts.length) ? issueParts.join(' ') : '';
            rows.push({ SC: scp, SE: sep, TxRx: txrx, BrPair: brPair, RfPort1: rfPorts1, RfPort2: rfPorts2, HW: hw, Serial: serial, CellState: cellState, Samples: samples, Med: med, Mean: mean, SDev: sdev, Pol: pol, Res: res, Issue: issue });
          } else { try { console.log('[MFAR] Buffer incompleto scartato, parts=', partsp.length); } catch {} }
        }
      }
      const startIdx = line.search(rowStart);
      rowBuf = startIdx >= 0 ? line.slice(startIdx) : line;
    } else {
      // Continuazione di una riga lunga
      rowBuf = (rowBuf ? rowBuf + ' ' : '') + line; // conserva spazi multipli di colonna
    }

    // Se la riga contiene l'esito, consideriamo la riga completa
    if (/\b(Passed|Failed)\b/i.test(rowBuf)) {
      try { console.log('[MFAR] Row buf:', rowBuf); } catch {}
      // Permetti spazi singoli tra SC e SE e tra il resto delle colonne
      const m = rowBuf.match(/^\s*(\S+)\s+(\S+)\s+(.*)$/);
      if (m) {
        const SC = m[1];
        const SE = m[2];
        const tail = m[3];
        const tokens = tail.trim().split(/\s+/).filter(Boolean);
        try { console.log('[MFAR] tokens:', tokens); } catch {}
        // Atteso: [TxRx, <BrPair 2 tokens>, RfPort1, RfPort2, HW, Serial, <CellState 2 tokens>, Samples, Med, Mean, SDev, Pol, Res, Issue...]
        if (tokens.length >= 15) {
          const TxRx = tokens[0];
          const BrPair = tokens[1] + ' ' + tokens[2];
          const RfPort1 = tokens[3];
          const RfPort2 = tokens[4];
          const HW = tokens[5];
          const Serial = tokens[6];
          const CellState = tokens[7] + ' ' + tokens[8];
          const Samples = tokens[9];
          const Med = tokens[10];
          const Mean = tokens[11];
          const SDev = tokens[12];
          const Pol = tokens[13];
          const Res = tokens[14];
          const Issue = tokens.slice(15).join(' ');
          rows.push({ SC, SE, TxRx, BrPair, RfPort1, RfPort2, HW, Serial, CellState, Samples, Med, Mean, SDev, Pol, Res, Issue });
        } else { try { console.log('[MFAR] Riga scartata (tokens<15), len=', tokens.length, 'tail=', tail); } catch {} }
      }
      rowBuf = '';
    }
  }
  return rows;
}

function parseMfarFromFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return parseMfarFromContent(content);
  } catch (e) {
    return [];
  }
}

function aggregateMfar() {
  const files = listFiles();
  const all = [];
  files.forEach(f => {
    const fileRows = parseMfarFromFile(path.join(uploadsDir, f));
    try { console.log(`[MFAR] ${f}: ${fileRows.length} righe`); } catch {}
    fileRows.forEach(r => all.push({ ...r, source: f }));
  });
  return all;
}

// Home visitatore: mostra entrambe le tabelle aggregate
app.get('/', (req, res) => {
  const fileOptions = listFiles();
  let selectedFile = (req.query.file || '').trim();
  // Se non è specificato un file, imposta di default il primo in elenco
  if (!selectedFile && fileOptions.length > 0) {
    selectedFile = fileOptions[0];
  }

  let perfRows = aggregateLinkPerformanceWl();
  let boardRows = aggregateBoardSfpMetrics();
  let fruRows = aggregateFruRadioMetriche();
  let mfarRows = aggregateMfar();
  let mfitrRows = aggregateMfitr();

  if (selectedFile) {
    perfRows = perfRows.filter(r => r.source === selectedFile);
    boardRows = boardRows.filter(r => r.source === selectedFile);
    fruRows = fruRows.filter(r => r.source === selectedFile);
    mfarRows = mfarRows.filter(r => r.source === selectedFile);
    mfitrRows = mfitrRows.filter(r => r.source === selectedFile);
  }

  // Mostra solo righe dove almeno uno tra DlLoss o UlLoss è < -3.49
  perfRows = perfRows.filter(r => (
    (!Number.isNaN(r.dlLossValue) && r.dlLossValue < -3.49) ||
    (!Number.isNaN(r.ulLossValue) && r.ulLossValue < -3.49)
  ));

    // Mostra solo righe BOARD SFP con ID=TN e TXdBm o RXdBm < -13.99
  boardRows = boardRows.filter(r => {
    const idIsTN = String(r.ID).trim().toUpperCase() === 'TN';
    const txVal = parseFloat(String(r.TXdBm).replace(',', '.'));
    const rxVal = parseFloat(String(r.RXdBm).replace(',', '.'));
      const txOk = !Number.isNaN(txVal) && txVal < -13.99;
      const rxOk = !Number.isNaN(rxVal) && rxVal < -13.99;
    return idIsTN && (txOk || rxOk);
  });

  // Mostra solo righe FRU Radio con VSWR (RL) > 1.49
  fruRows = fruRows.filter(r => {
    let v = r.vswrValue;
    if (Number.isNaN(v) || typeof v === 'undefined') {
      const m = String(r.VSWR || '').match(/^[\s]*([+-]?[0-9]+(?:[.,][0-9]+)?)/);
      if (m) v = parseFloat(m[1].replace(',', '.'));
    }
    return !Number.isNaN(v) && v > 1.49;
  });

  // Mostra solo righe MFAR con Issue diverso da 'Passed'
  mfarRows = mfarRows.filter(r => {
    const issue = String(r.Issue || '').trim().toLowerCase();
    return issue && issue !== 'passed';
  });

  // Mostra solo righe MFITR con DELTA > 3.9
  mfitrRows = mfitrRows.filter(r => {
    const deltaVal = parseFloat(String(r.DELTA || '').replace(',', '.'));
    return !Number.isNaN(deltaVal) && deltaVal > 3.9;
  });

  res.render('index', { perfRows, boardRows, fruRows, mfarRows, mfitrRows, fileOptions, selectedFile });
});

// Visualizzazione contenuto file
app.get('/view/:filename', (req, res) => {
  const filename = req.params.filename;
  const fullPath = path.join(uploadsDir, filename);
  if (!fs.existsSync(fullPath)) {
    return res.status(404).send('File non trovato');
  }
  fs.readFile(fullPath, 'utf8', (err, data) => {
    if (err) return res.status(500).send('Errore nella lettura del file');
    res.render('view', { filename, content: data });
  });
});

// Report: celle di riferimento con VSWR > 1.50
function extractRefCellFromSectorCells(sectorCells) {
  const sc = String(sectorCells || '');
  let refCell = '';
  const mFdd = sc.match(/FDD\s*=\s*(CS\d+[A-Z]{1,2}\d+)/i);
  if (mFdd) {
    refCell = mFdd[1];
  } else {
    const mAny = sc.match(/CS\d+[A-Z]{1,2}\d+/g);
    if (mAny && mAny.length) refCell = mAny[0];
  }
  return refCell;
}

// Estrae coppie di celle di riferimento (AB/CD) dai campi WL/TT/LINK di una riga WL
function extractCellsFromLinkPerfRow(row) {
  const bucket = [row.TT, row.WL1, row.WL2, row.LINK].map(v => String(v || '')).join(' ');
  const tokens = bucket.match(/CS0(?:AE|AN|AM|AT|FM|FT)\d+/g) || [];
  const ae = tokens.filter(t => t.startsWith('CS0AE'));
  const an = tokens.filter(t => t.startsWith('CS0AN'));
  const fm = tokens.filter(t => t.startsWith('CS0FM'));
  const ft = tokens.filter(t => t.startsWith('CS0FT'));
  const am = tokens.filter(t => t.startsWith('CS0AM'));
  const at = tokens.filter(t => t.startsWith('CS0AT'));
  let ab = '';
  let cd = '';
  if (ae.length || an.length) {
    ab = (ae[0] || '') + ((ae[0] && an[0]) ? '/' : '') + (an[0] || '');
    cd = (ae[1] || '') + ((ae[1] && an[1]) ? '/' : '') + (an[1] || '');
  } else if (fm.length || ft.length) {
    ab = (fm[0] || '') + ((fm[0] && ft[0]) ? '/' : '') + (ft[0] || '');
    cd = (fm[1] || '') + ((fm[1] && ft[1]) ? '/' : '') + (ft[1] || '');
  } else if (am.length || at.length) {
    ab = (am[0] || '') + ((am[0] && at[0]) ? '/' : '') + (at[0] || '');
    cd = (am[1] || '') + ((am[1] && at[1]) ? '/' : '') + (at[1] || '');
  }
  // Fallback: se nessun token presente, prova da RiL per file CS0AT*
  if (!ab && !cd) {
    const rilStr = String(row.RiL || '');
    const m = rilStr.match(/(?:Radio-)?S(\d+)-(\d+)/i);
    if (m && /AT/i.test(String(row.source || ''))) {
      const n = m[1];
      ab = `CS0AE${n}/CS0AN${n}`;
    }
  }
  const refCells = [ab, cd].filter(Boolean).join(' ; ');
  return refCells;
}

// Estrae celle di riferimento da una riga BOARD/SFP (usa WL e fallback su RiL)
function extractCellsFromBoardRow(row) {
  const bucket = [row.WL].map(v => String(v || '')).join(' ');
  const tokens = bucket.match(/CS0(?:AE|AN|AM|AT|FM|FT)\d+/g) || [];
  const ae = tokens.filter(t => t.startsWith('CS0AE'));
  const an = tokens.filter(t => t.startsWith('CS0AN'));
  const fm = tokens.filter(t => t.startsWith('CS0FM'));
  const ft = tokens.filter(t => t.startsWith('CS0FT'));
  const am = tokens.filter(t => t.startsWith('CS0AM'));
  const at = tokens.filter(t => t.startsWith('CS0AT'));
  let ab = '';
  let cd = '';
  if (ae.length || an.length) {
    ab = (ae[0] || '') + ((ae[0] && an[0]) ? '/' : '') + (an[0] || '');
    cd = (ae[1] || '') + ((ae[1] && an[1]) ? '/' : '') + (an[1] || '');
  } else if (fm.length || ft.length) {
    ab = (fm[0] || '') + ((fm[0] && ft[0]) ? '/' : '') + (ft[0] || '');
    cd = (fm[1] || '') + ((fm[1] && ft[1]) ? '/' : '') + (ft[1] || '');
  } else if (am.length || at.length) {
    ab = (am[0] || '') + ((am[0] && at[0]) ? '/' : '') + (at[0] || '');
    cd = (am[1] || '') + ((am[1] && at[1]) ? '/' : '') + (at[1] || '');
  }
  // Fallback via RiL per file CS0AT*
  if (!ab && !cd) {
    const rilStr = String(row.RiL || '');
    const m = rilStr.match(/(?:Radio-)?S(\d+)-(\d+)/i);
    if (m && /AT/i.test(String(row.source || ''))) {
      const n = m[1];
      ab = `CS0AE${n}/CS0AN${n}`;
    }
  }
  const refCells = [ab, cd].filter(Boolean).join(' ; ');
  return refCells;
}

app.get('/report/celle', (req, res) => {
  const selectedFile = req.query.file || '';
  const selectedTable = (req.query.table || '').trim();
  const fileOptions = listFiles();
  let fruRows = [];
  let perfRows = [];
  let boardRows = [];
  let mfarRows = [];
  let mfitrRows = [];
  if (selectedFile) {
    fruRows = parseSdirFruRadioMetricheFromFile(path.join(uploadsDir, selectedFile))
      .map(r => ({ ...r, source: selectedFile }));
    perfRows = parseSdirLinkPerformanceWlFromFile(path.join(uploadsDir, selectedFile))
      .map(r => ({ ...r, source: selectedFile }));
    boardRows = parseSdirBoardSfpMetricsFromFile(path.join(uploadsDir, selectedFile))
      .map(r => ({ ...r, source: selectedFile }));
    mfarRows = parseMfarFromFile(path.join(uploadsDir, selectedFile))
      .map(r => ({ ...r, source: selectedFile }));
    mfitrRows = parseMfitrFromFile(path.join(uploadsDir, selectedFile))
      .map(r => ({ ...r, source: selectedFile }));
  } else {
    fruRows = aggregateFruRadioMetriche();
    perfRows = aggregateLinkPerformanceWl();
    boardRows = aggregateBoardSfpMetrics();
    mfarRows = aggregateMfar();
    mfitrRows = aggregateMfitr();
  }
  // Filtra VSWR > 1.50 con fallback parsing
  const filtered = fruRows.filter(r => {
    let v = r.vswrValue;
    if (Number.isNaN(v) || typeof v === 'undefined') {
      const m = String(r.VSWR || '').match(/^[\s]*([+-]?[0-9]+(?:[.,][0-9]+)?)/);
      if (m) v = parseFloat(m[1].replace(',', '.'));
    }
    return !Number.isNaN(v) && v > 1.49;
  }).map(r => ({
    refCell: extractRefCellFromSectorCells(r.SectorCells),
    VSWR: r.VSWR,
    Radio: r.FRU,
    BOARD: r.BOARD,
    RF: r.RF,
    source: r.source
  })).filter(x => x.refCell);

  // Filtra performance WL: almeno uno tra DlLoss o UlLoss < -3.49 e ricava celle riferimento
  const wlRows = perfRows.filter(r => (
    (!Number.isNaN(r.dlLossValue) && r.dlLossValue < -3.49) ||
    (!Number.isNaN(r.ulLossValue) && r.ulLossValue < -3.49)
  )).map(r => ({
    refCells: extractCellsFromLinkPerfRow(r),
    DlLoss: r.DlLoss,
    UlLoss: r.UlLoss,
    LENGTH: r.LENGTH,
    source: r.source
  })).filter(x => x.refCells);

    // Filtra BOARD/SFP: ID = TN e almeno uno tra TXdBm/RXdBm < -13.99, ricava celle
  const boardSfpRows = boardRows.filter(r => {
    const idIsTN = String(r.ID).trim().toUpperCase() === 'TN';
    const txVal = parseFloat(String(r.TXdBm).replace(',', '.'));
    const rxVal = parseFloat(String(r.RXdBm).replace(',', '.'));
      const txOk = !Number.isNaN(txVal) && txVal < -13.99;
      const rxOk = !Number.isNaN(rxVal) && rxVal < -13.99;
    return idIsTN && (txOk || rxOk);
  }).map(r => ({
    refCells: extractCellsFromBoardRow(r),
    BOARD: r.BOARD,
    TXdBm: r.TXdBm,
    RXdBm: r.RXdBm,
    WL: r.WL,
    source: r.source
  }));

  // Filtra MFAR: mostra solo Issue diverso da 'Passed'
  mfarRows = mfarRows.filter(r => {
    const issue = String(r.Issue || '').trim().toLowerCase();
    return issue && issue !== 'passed';
  });

  // Filtra MFITR: DELTA > 3.9
  mfitrRows = mfitrRows.filter(r => {
    const deltaVal = parseFloat(String(r.DELTA || '').replace(',', '.'));
    return !Number.isNaN(deltaVal) && deltaVal > 3.9;
  });

  res.render('report_celle', { rows: filtered, wlRows, boardSfpRows, mfarRows, mfitrRows, fileOptions, selectedFile, selectedTable });
});

// Pagina admin: upload multiplo e cancellazione
app.get('/admin', (req, res) => {
  // Se richiesto logout via query, forza 401 per ripristinare il prompt Basic Auth
  if (req.query.logout === '1') {
    res.set('WWW-Authenticate', 'Basic realm="Admin"');
    return res.status(401).send('Logout: premi Annulla nel prompt per uscire.');
  }
  const files = listFiles();
  const msg = req.query.msg || null;
  res.render('admin', { files, msg });
});

// Upload fino a 10000 file contemporaneamente
app.post('/admin/upload', upload.array('files', 10000), (req, res) => {
  const count = (req.files || []).length;
  const msg = count > 0 ? `Caricati ${count} file.` : 'Nessun file caricato.';
  res.redirect(`/admin?msg=${encodeURIComponent(msg)}`);
});

// Eliminazione file selezionati
app.post('/admin/delete', (req, res) => {
  let selected = req.body.selected;
  if (!selected) {
    return res.redirect(`/admin?msg=${encodeURIComponent('Nessun file selezionato')}`);
  }
  if (!Array.isArray(selected)) selected = [selected];

  let deleted = 0;
  selected.forEach(name => {
    const fullPath = path.join(uploadsDir, name);
    try {
      if (fs.existsSync(fullPath)) {
        fs.unlinkSync(fullPath);
        deleted++;
      }
    } catch (e) {
      // continua comunque
    }
  });
  const msg = `Eliminati ${deleted} file.`;
  res.redirect(`/admin?msg=${encodeURIComponent(msg)}`);
});

// Avvio server
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server avviato su http://localhost:${port}/`);
});